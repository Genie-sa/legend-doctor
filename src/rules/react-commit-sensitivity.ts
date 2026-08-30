import ts from "typescript";

import {
  collectBindingNames,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import {
  findAncestor,
  isRuntimeFunctionLike,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import type { HookImports } from "../imports.js";
import {
  bindingContainsName,
  callbackIsEventRooted,
  localFunctionBinding,
  uniqueVariableDeclaration,
} from "./state-proofs.js";
import type { RuntimeFunctionLike } from "../ast.js";

export interface ReactCommitContext {
  directTransitionCallbacks: ReadonlyMap<RuntimeFunctionLike, readonly RuntimeFunctionLike[]>;
  eventTransitionCallbacks: ReadonlyMap<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>;
  effectCalls: readonly ts.CallExpression[];
  lifecycleRegions: ReadonlySet<ts.Node>;
  sensitiveOwners: ReadonlySet<RuntimeFunctionLike>;
}

export function collectReactCommitContext(
  sourceFile: ts.SourceFile,
  imports: HookImports,
): ReactCommitContext {
  const effectCalls: ts.CallExpression[] = [],
    lifecycleRegions = new Set<ts.Node>(),
    nonTransitionSensitiveOwners = new Set<RuntimeFunctionLike>(),
    sensitiveOwners = new Set<RuntimeFunctionLike>(),
    transitionOwners = new Set<RuntimeFunctionLike>();
  visit(sourceFile, (node) => {
    if (ts.isJsxAttribute(node) && node.name.getText() === "ref") {
      const expression =
          node.initializer && ts.isJsxExpression(node.initializer)
            ? node.initializer.expression
            : null,
        owner = expression ? findAncestor(node, isRuntimeFunctionLike) : null;
      if (expression && owner && refIdentityMayChange(expression, owner, imports)) {
        markRuntimeAncestors(node, sensitiveOwners);
        markRuntimeAncestors(node, nonTransitionSensitiveOwners);
      }
      return;
    }
    if (ts.isCallExpression(node) && isReactEffectCall(node, imports)) {
      lifecycleRegions.add(node);
      const owner = findAncestor(node, isRuntimeFunctionLike),
        callback =
          owner && node.arguments[0]
            ? resolveLifecycleCallback(node.arguments[0], owner, imports, new Set())
            : null;
      if (callback) {
        lifecycleRegions.add(callback);
      }
      if (isImportedReactCall(node, imports.useEffect, imports.reactNamespaces, "useEffect")) {
        effectCalls.push(node);
      }
      if (hasNoDependencyArray(node)) {
        markRuntimeAncestors(node, sensitiveOwners);
        markRuntimeAncestors(node, nonTransitionSensitiveOwners);
      }
      return;
    }
    if (isTransitionReference(node, imports)) {
      markRuntimeAncestors(node, sensitiveOwners);
      markRuntimeAncestors(node, transitionOwners);
    }
  });
  const directTransitionCallbacks = new Map<RuntimeFunctionLike, readonly RuntimeFunctionLike[]>(),
    eventTransitionCallbacks = new Map<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>();
  for (const owner of transitionOwners) {
    if (nonTransitionSensitiveOwners.has(owner)) {
      continue;
    }
    const transitions = directTransitionContext(owner, imports);
    if (!transitions) {
      continue;
    }
    directTransitionCallbacks.set(owner, transitions.callbacks);
    eventTransitionCallbacks.set(owner, transitions.eventCallbacks);
  }
  return {
    directTransitionCallbacks,
    effectCalls,
    eventTransitionCallbacks,
    lifecycleRegions,
    sensitiveOwners,
  };
}

interface DirectTransitionContext {
  callbacks: readonly RuntimeFunctionLike[];
  eventCallbacks: ReadonlySet<RuntimeFunctionLike>;
}

function directTransitionContext(
  owner: RuntimeFunctionLike,
  imports: HookImports,
): DirectTransitionContext | null {
  if (!owner.body) {
    return null;
  }
  const bindings = new Set<string>();
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      isImportedReactCall(
        node.initializer,
        imports.useTransition,
        imports.reactNamespaces,
        "useTransition",
      )
    ) {
      const start = node.name.elements[1];
      if (start && !ts.isOmittedExpression(start) && ts.isIdentifier(start.name)) {
        bindings.add(start.name.text);
      }
    }
  });

  const callbacks: RuntimeFunctionLike[] = [],
    eventCallbacks = new Set<RuntimeFunctionLike>();
  let safe = true;
  visit(owner.body, (node) => {
    if (!safe || !ts.isCallExpression(node)) {
      return;
    }
    const directHookTransition =
        ts.isIdentifier(node.expression) && bindings.has(node.expression.text),
      directStaticTransition = isImportedReactCall(
        node,
        imports.startTransition,
        imports.reactNamespaces,
        "startTransition",
      );
    if (!directHookTransition && !directStaticTransition) {
      return;
    }
    const callback = node.arguments[0] ? directTransitionCallback(node.arguments[0]!, owner) : null;
    if (!callback) {
      safe = false;
      return;
    }
    visit(callback.body, (reference) => {
      if (
        safe &&
        ts.isIdentifier(reference) &&
        !isDeclarationName(reference) &&
        !isNonValueIdentifier(reference) &&
        localFunctionBinding(owner, reference.text)
      ) {
        safe = false;
      }
    });
    callbacks.push(callback);
    const caller = findAncestor(node, isRuntimeFunctionLike);
    if (
      caller &&
      caller !== owner &&
      (ts.isArrowFunction(caller) ||
        ts.isFunctionDeclaration(caller) ||
        ts.isFunctionExpression(caller)) &&
      callbackIsEventRooted(caller, owner, "", new Set())
    ) {
      eventCallbacks.add(callback);
    }
  });

  if (!safe) {
    return null;
  }
  const transitionBindings = new Set([...bindings, ...imports.startTransition]);
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      !transitionBindings.has(node.text) ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      return;
    }
    if (ts.isArrayLiteralExpression(node.parent)) {
      return;
    }
    safe = false;
  });
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isPropertyAccessExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      !imports.reactNamespaces.has(node.expression.text) ||
      node.name.text !== "startTransition"
    ) {
      return;
    }
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      return;
    }
    if (ts.isArrayLiteralExpression(node.parent)) {
      return;
    }
    safe = false;
  });
  return safe ? { callbacks, eventCallbacks } : null;
}

function directTransitionCallback(
  expression: ts.Expression,
  owner: RuntimeFunctionLike,
): RuntimeFunctionLike | null {
  const value = unwrapTransparentExpression(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    return value;
  }
  if (!ts.isIdentifier(value)) {
    return null;
  }

  const declaration = uniqueVariableDeclaration(owner, value.text);
  if (
    !declaration?.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  const callback = unwrapTransparentExpression(declaration.initializer);
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
    return null;
  }

  let safe = true,
    references = 0;
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== value.text ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    references += 1;
    if (node !== value) {
      safe = false;
    }
  });
  return safe && references === 1 ? callback : null;
}

function resolveLifecycleCallback(
  expression: ts.Expression,
  owner: RuntimeFunctionLike,
  imports: HookImports,
  seen: ReadonlySet<string>,
): ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null {
  const value = unwrapTransparentExpression(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    return value;
  }
  if (!ts.isIdentifier(value) || seen.has(value.text)) {
    return null;
  }

  const direct = localFunctionBinding(owner, value.text);
  if (direct) {
    return direct;
  }
  const declaration = uniqueVariableDeclaration(owner, value.text);
  if (
    !declaration?.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer),
    nextSeen = new Set(seen).add(value.text);
  if (ts.isIdentifier(initializer)) {
    return resolveLifecycleCallback(initializer, owner, imports, nextSeen);
  }
  if (
    ts.isCallExpression(initializer) &&
    isImportedReactCall(initializer, imports.useCallback, imports.reactNamespaces, "useCallback") &&
    initializer.arguments[0]
  ) {
    return resolveLifecycleCallback(initializer.arguments[0], owner, imports, nextSeen);
  }
  return null;
}

function markRuntimeAncestors(node: ts.Node, owners: Set<RuntimeFunctionLike>): void {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (isRuntimeFunctionLike(current)) {
      owners.add(current);
    }
  }
}

function refIdentityMayChange(
  expression: ts.Expression,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value) || ts.isCallExpression(value)) {
    return !ts.isCallExpression(value) || !isStableReactRefFactory(value, imports);
  }
  if (ts.isConditionalExpression(value)) {
    return (
      refIdentityMayChange(value.whenTrue, owner, imports) ||
      refIdentityMayChange(value.whenFalse, owner, imports)
    );
  }
  if (!ts.isIdentifier(value)) {
    return false;
  }
  if (localFunctionBinding(owner, value.text)) {
    return true;
  }
  const declaration = uniqueVariableDeclaration(owner, value.text);
  if (!declaration?.initializer) {
    return false;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  if (ts.isConditionalExpression(initializer)) {
    return (
      refIdentityMayChange(initializer.whenTrue, owner, imports) ||
      refIdentityMayChange(initializer.whenFalse, owner, imports)
    );
  }
  return ts.isCallExpression(initializer) && !isStableReactRefFactory(initializer, imports);
}

function isStableReactRefFactory(call: ts.CallExpression, imports: HookImports): boolean {
  if (isImportedReactCall(call, imports.useRef, imports.reactNamespaces, "useRef")) {
    return true;
  }
  if (!isImportedReactCall(call, imports.useCallback, imports.reactNamespaces, "useCallback")) {
    return false;
  }
  const dependencies = call.arguments[1];
  if (!dependencies) {
    return false;
  }
  const value = unwrapTransparentExpression(dependencies);
  return ts.isArrayLiteralExpression(value) && value.elements.length === 0;
}

function hasNoDependencyArray(call: ts.CallExpression): boolean {
  const dependency = call.arguments[1];
  if (!dependency) {
    return true;
  }
  const value = unwrapTransparentExpression(dependency);
  if (value.kind === ts.SyntaxKind.NullKeyword) {
    return true;
  }
  if (ts.isVoidExpression(value)) {
    return true;
  }
  if (!ts.isIdentifier(value) || value.text !== "undefined") {
    return false;
  }
  const owner = findAncestor(call, isRuntimeFunctionLike);
  return owner === null || !hasLexicalBindingAt(call, owner, value.text);
}

function isReactEffectCall(call: ts.CallExpression, imports: HookImports): boolean {
  return (
    isImportedReactCall(call, imports.useEffect, imports.reactNamespaces, "useEffect") ||
    isImportedReactCall(
      call,
      imports.useLayoutEffect,
      imports.reactNamespaces,
      "useLayoutEffect",
    ) ||
    isImportedReactCall(
      call,
      imports.useInsertionEffect,
      imports.reactNamespaces,
      "useInsertionEffect",
    )
  );
}

function isTransitionReference(node: ts.Node, imports: HookImports): boolean {
  if (
    ts.isCallExpression(node) &&
    isImportedReactCall(node, imports.useTransition, imports.reactNamespaces, "useTransition")
  ) {
    return true;
  }
  if (ts.isIdentifier(node)) {
    if (!imports.startTransition.has(node.text)) {
      return false;
    }
    const owner = findAncestor(node, isRuntimeFunctionLike);
    return owner === null || !hasLexicalBindingAt(node, owner, node.text);
  }
  if (
    !ts.isPropertyAccessExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    !imports.reactNamespaces.has(node.expression.text) ||
    node.name.text !== "startTransition"
  ) {
    return false;
  }
  const owner = findAncestor(node, isRuntimeFunctionLike);
  return owner === null || !hasLexicalBindingAt(node, owner, node.expression.text);
}

function isImportedReactCall(
  call: ts.CallExpression,
  localNames: ReadonlySet<string>,
  namespaceNames: ReadonlySet<string>,
  canonicalName: string,
): boolean {
  const { expression } = call;
  const binding =
    ts.isIdentifier(expression) && localNames.has(expression.text)
      ? expression.text
      : ts.isPropertyAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          namespaceNames.has(expression.expression.text) &&
          expression.name.text === canonicalName
        ? expression.expression.text
        : null;
  if (!binding) {
    return false;
  }
  const owner = findAncestor(call, isRuntimeFunctionLike);
  return owner === null || !hasLexicalBindingAt(call, owner, binding);
}

const functionScopedBindingsByOwner = new WeakMap<RuntimeFunctionLike, ReadonlySet<string>>();

function hasLexicalBindingAt(node: ts.Node, owner: RuntimeFunctionLike, name: string): boolean {
  if (owner.parameters.some((parameter) => bindingContainsName(parameter.name, name))) {
    return true;
  }
  if (!owner.body) {
    return false;
  }

  let functionScopedBindings = functionScopedBindingsByOwner.get(owner);
  if (!functionScopedBindings) {
    const collected = new Set<string>();
    visitSkippingNestedRuntimeFunctions(owner.body, (current) => {
      if (
        ts.isVariableDeclaration(current) &&
        ts.isVariableDeclarationList(current.parent) &&
        (current.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0
      ) {
        collectBindingNames(current.name, collected);
      }
    });
    functionScopedBindings = collected;
    functionScopedBindingsByOwner.set(owner, functionScopedBindings);
  }
  if (functionScopedBindings.has(name)) {
    return true;
  }

  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (scopeDirectlyDeclares(current, name)) {
      return true;
    }
  }
  return false;
}

function scopeDirectlyDeclares(scope: ts.Node, name: string): boolean {
  if (ts.isCatchClause(scope) && scope.variableDeclaration) {
    return bindingContainsName(scope.variableDeclaration.name, name);
  }
  if (
    ts.isForStatement(scope) &&
    scope.initializer &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    return scope.initializer.declarations.some((declaration) =>
      bindingContainsName(declaration.name, name),
    );
  }
  if (
    (ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    return scope.initializer.declarations.some((declaration) =>
      bindingContainsName(declaration.name, name),
    );
  }
  if (!ts.isBlock(scope)) {
    return false;
  }
  return scope.statements.some((statement) => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some((declaration) =>
        bindingContainsName(declaration.name, name),
      );
    }
    return (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    );
  });
}
