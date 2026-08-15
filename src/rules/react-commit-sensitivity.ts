import ts from "typescript";

import { unwrapTransparentExpression } from "../analysis-ast.js";
import {
  findAncestor,
  isRuntimeFunctionLike,
  type RuntimeFunctionLike,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import type { HookImports } from "../imports.js";
import {
  bindingContainsName,
  localFunctionBinding,
  uniqueVariableDeclaration,
} from "./state-proofs.js";

export interface ReactCommitContext {
  effectCalls: readonly ts.CallExpression[];
  lifecycleRegions: ReadonlySet<ts.Node>;
  sensitiveOwners: ReadonlySet<RuntimeFunctionLike>;
}

export function collectReactCommitContext(
  sourceFile: ts.SourceFile,
  imports: HookImports
): ReactCommitContext {
  const effectCalls: ts.CallExpression[] = [];
  const lifecycleRegions = new Set<ts.Node>();
  const sensitiveOwners = new Set<RuntimeFunctionLike>();
  visit(sourceFile, node => {
    if (ts.isJsxAttribute(node) && node.name.getText() === "ref") {
      const expression = node.initializer && ts.isJsxExpression(node.initializer)
        ? node.initializer.expression
        : null;
      const owner = expression ? findAncestor(node, isRuntimeFunctionLike) : null;
      if (expression && owner && refIdentityMayChange(expression, owner, imports)) {
        markRuntimeAncestors(node, sensitiveOwners);
      }
      return;
    }
    if (ts.isCallExpression(node) && isReactEffectCall(node, imports)) {
      lifecycleRegions.add(node);
      const owner = findAncestor(node, isRuntimeFunctionLike);
      const callback = owner && node.arguments[0]
        ? resolveLifecycleCallback(node.arguments[0], owner, imports, new Set())
        : null;
      if (callback) lifecycleRegions.add(callback);
      if (isImportedReactCall(node, imports.useEffect, imports.reactNamespaces, "useEffect")) {
        effectCalls.push(node);
      }
      if (hasNoDependencyArray(node)) markRuntimeAncestors(node, sensitiveOwners);
      return;
    }
    if (isTransitionReference(node, imports)) {
      markRuntimeAncestors(node, sensitiveOwners);
    }
  });
  return { effectCalls, lifecycleRegions, sensitiveOwners };
}

function resolveLifecycleCallback(
  expression: ts.Expression,
  owner: RuntimeFunctionLike,
  imports: HookImports,
  seen: ReadonlySet<string>
): ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null {
  const value = unwrapTransparentExpression(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value;
  if (!ts.isIdentifier(value) || seen.has(value.text)) return null;

  const direct = localFunctionBinding(owner, value.text);
  if (direct) return direct;
  const declaration = uniqueVariableDeclaration(owner, value.text);
  if (
    !declaration?.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  const nextSeen = new Set(seen).add(value.text);
  if (ts.isIdentifier(initializer)) {
    return resolveLifecycleCallback(initializer, owner, imports, nextSeen);
  }
  if (
    ts.isCallExpression(initializer) &&
    isImportedReactCall(
      initializer,
      imports.useCallback,
      imports.reactNamespaces,
      "useCallback"
    ) &&
    initializer.arguments[0]
  ) {
    return resolveLifecycleCallback(initializer.arguments[0], owner, imports, nextSeen);
  }
  return null;
}

function markRuntimeAncestors(
  node: ts.Node,
  owners: Set<RuntimeFunctionLike>
): void {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (isRuntimeFunctionLike(current)) owners.add(current);
  }
}

function refIdentityMayChange(
  expression: ts.Expression,
  owner: RuntimeFunctionLike,
  imports: HookImports
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value) || ts.isCallExpression(value)) {
    return !ts.isCallExpression(value) || !isStableReactRefFactory(value, imports);
  }
  if (ts.isConditionalExpression(value)) {
    return refIdentityMayChange(value.whenTrue, owner, imports) ||
      refIdentityMayChange(value.whenFalse, owner, imports);
  }
  if (!ts.isIdentifier(value)) return false;
  if (localFunctionBinding(owner, value.text)) return true;
  const declaration = uniqueVariableDeclaration(owner, value.text);
  if (!declaration?.initializer) return false;
  const initializer = unwrapTransparentExpression(declaration.initializer);
  if (ts.isConditionalExpression(initializer)) {
    return refIdentityMayChange(initializer.whenTrue, owner, imports) ||
      refIdentityMayChange(initializer.whenFalse, owner, imports);
  }
  return ts.isCallExpression(initializer) && !isStableReactRefFactory(initializer, imports);
}

function isStableReactRefFactory(
  call: ts.CallExpression,
  imports: HookImports
): boolean {
  if (isImportedReactCall(call, imports.useRef, imports.reactNamespaces, "useRef")) return true;
  if (!isImportedReactCall(call, imports.useCallback, imports.reactNamespaces, "useCallback")) {
    return false;
  }
  const dependencies = call.arguments[1];
  if (!dependencies) return false;
  const value = unwrapTransparentExpression(dependencies);
  return ts.isArrayLiteralExpression(value) && value.elements.length === 0;
}

function hasNoDependencyArray(call: ts.CallExpression): boolean {
  const dependency = call.arguments[1];
  if (!dependency) return true;
  const value = unwrapTransparentExpression(dependency);
  if (value.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isVoidExpression(value)) return true;
  if (!ts.isIdentifier(value) || value.text !== "undefined") return false;
  const owner = findAncestor(call, isRuntimeFunctionLike);
  return owner === null || !hasLexicalBindingAt(call, owner, value.text);
}

function isReactEffectCall(
  call: ts.CallExpression,
  imports: HookImports
): boolean {
  return isImportedReactCall(call, imports.useEffect, imports.reactNamespaces, "useEffect") ||
    isImportedReactCall(call, imports.useLayoutEffect, imports.reactNamespaces, "useLayoutEffect") ||
    isImportedReactCall(
      call,
      imports.useInsertionEffect,
      imports.reactNamespaces,
      "useInsertionEffect"
    );
}

function isTransitionReference(node: ts.Node, imports: HookImports): boolean {
  if (
    ts.isCallExpression(node) &&
    isImportedReactCall(node, imports.useTransition, imports.reactNamespaces, "useTransition")
  ) {
    return true;
  }
  const owner = findAncestor(node, isRuntimeFunctionLike);
  if (ts.isIdentifier(node)) {
    return imports.startTransition.has(node.text) &&
      (owner === null || !hasLexicalBindingAt(node, owner, node.text));
  }
  return ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    imports.reactNamespaces.has(node.expression.text) &&
    node.name.text === "startTransition" &&
    (owner === null || !hasLexicalBindingAt(node, owner, node.expression.text));
}

function isImportedReactCall(
  call: ts.CallExpression,
  localNames: ReadonlySet<string>,
  namespaceNames: ReadonlySet<string>,
  canonicalName: string
): boolean {
  const owner = findAncestor(call, isRuntimeFunctionLike);
  return ts.isIdentifier(call.expression)
    ? localNames.has(call.expression.text) &&
        (owner === null || !hasLexicalBindingAt(call, owner, call.expression.text))
    : ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        namespaceNames.has(call.expression.expression.text) &&
        call.expression.name.text === canonicalName &&
        (owner === null || !hasLexicalBindingAt(call, owner, call.expression.expression.text));
}

function hasLexicalBindingAt(
  node: ts.Node,
  owner: RuntimeFunctionLike,
  name: string
): boolean {
  if (owner.parameters.some(parameter => bindingContainsName(parameter.name, name))) return true;
  if (!owner.body) return false;

  let functionScoped = false;
  visitSkippingNestedRuntimeFunctions(owner.body, current => {
    if (
      !functionScoped &&
      ts.isVariableDeclaration(current) &&
      ts.isVariableDeclarationList(current.parent) &&
      (current.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0 &&
      bindingContainsName(current.name, name)
    ) {
      functionScoped = true;
    }
  });
  if (functionScoped) return true;

  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (scopeDirectlyDeclares(current, name)) return true;
  }
  return false;
}

function scopeDirectlyDeclares(scope: ts.Node, name: string): boolean {
  if (ts.isCatchClause(scope) && scope.variableDeclaration) {
    return bindingContainsName(scope.variableDeclaration.name, name);
  }
  if (ts.isForStatement(scope) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
    return scope.initializer.declarations.some(declaration =>
      bindingContainsName(declaration.name, name)
    );
  }
  if (
    (ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    return scope.initializer.declarations.some(declaration =>
      bindingContainsName(declaration.name, name)
    );
  }
  if (!ts.isBlock(scope)) return false;
  return scope.statements.some(statement => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some(declaration =>
        bindingContainsName(declaration.name, name)
      );
    }
    return (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === name;
  });
}
