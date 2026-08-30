import {
  bindingContainsName,
  callbackIsEventRooted,
  localFunctionBinding,
  uniqueVariableDeclaration,
} from "./state-proofs.js";
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
import type { RuntimeFunctionLike } from "../ast.js";
import ts from "typescript";

export interface ReactCommitContext {
  directTransitionCallbacks: ReadonlyMap<RuntimeFunctionLike, readonly RuntimeFunctionLike[]>;
  eventTransitionCallbacks: ReadonlyMap<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>;
  effectCalls: readonly ts.CallExpression[];
  lifecycleRegions: ReadonlySet<ts.Node>;
  sensitiveOwners: ReadonlySet<RuntimeFunctionLike>;
}

type ReactHookImportName =
  | "startTransition"
  | "useCallback"
  | "useEffect"
  | "useInsertionEffect"
  | "useLayoutEffect"
  | "useRef"
  | "useTransition";

interface CommitScan {
  readonly effectCalls: ts.CallExpression[];
  readonly lifecycleRegions: Set<ts.Node>;
  readonly nonTransitionSensitiveOwners: Set<RuntimeFunctionLike>;
  readonly sensitiveOwners: Set<RuntimeFunctionLike>;
  readonly transitionOwners: Set<RuntimeFunctionLike>;
}

interface TransitionCallbackMaps {
  readonly direct: Map<RuntimeFunctionLike, readonly RuntimeFunctionLike[]>;
  readonly event: Map<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>;
}

export function collectReactCommitContext(
  sourceFile: ts.SourceFile,
  imports: HookImports,
): ReactCommitContext {
  const scan: CommitScan = {
    effectCalls: [],
    lifecycleRegions: new Set(),
    nonTransitionSensitiveOwners: new Set(),
    sensitiveOwners: new Set(),
    transitionOwners: new Set(),
  };
  visit(sourceFile, (node) => {
    collectCommitNode(node, scan, imports);
  });
  const transitions = transitionCallbackMaps(scan, imports);
  return {
    directTransitionCallbacks: transitions.direct,
    effectCalls: scan.effectCalls,
    eventTransitionCallbacks: transitions.event,
    lifecycleRegions: scan.lifecycleRegions,
    sensitiveOwners: scan.sensitiveOwners,
  };
}

function collectCommitNode(node: ts.Node, scan: CommitScan, imports: HookImports): void {
  if (ts.isJsxAttribute(node) && node.name.getText() === "ref") {
    collectRefAttribute(node, scan, imports);
    return;
  }
  if (ts.isCallExpression(node) && isReactEffectCall(node, imports)) {
    collectEffectCall(node, scan, imports);
    return;
  }
  if (isTransitionReference(node, imports)) {
    markRuntimeAncestors(node, scan.sensitiveOwners);
    markRuntimeAncestors(node, scan.transitionOwners);
  }
}

function markCommitSensitive(node: ts.Node, scan: CommitScan): void {
  markRuntimeAncestors(node, scan.sensitiveOwners);
  markRuntimeAncestors(node, scan.nonTransitionSensitiveOwners);
}

function collectRefAttribute(node: ts.JsxAttribute, scan: CommitScan, imports: HookImports): void {
  const expression =
    node.initializer && ts.isJsxExpression(node.initializer) ? node.initializer.expression : null;
  const owner = expression ? findAncestor(node, isRuntimeFunctionLike) : null;
  if (expression && owner && refIdentityMayChange(expression, owner, imports)) {
    markCommitSensitive(node, scan);
  }
}

function collectEffectCall(node: ts.CallExpression, scan: CommitScan, imports: HookImports): void {
  scan.lifecycleRegions.add(node);
  const owner = findAncestor(node, isRuntimeFunctionLike);
  const callback =
    owner && node.arguments[0]
      ? resolveLifecycleCallback(node.arguments[0], { imports, owner, seen: new Set() })
      : null;
  if (callback) {
    scan.lifecycleRegions.add(callback);
  }
  if (isImportedReactCall(node, imports, "useEffect")) {
    scan.effectCalls.push(node);
  }
  if (hasNoDependencyArray(node)) {
    markCommitSensitive(node, scan);
  }
}

function transitionCallbackMaps(scan: CommitScan, imports: HookImports): TransitionCallbackMaps {
  const direct = new Map<RuntimeFunctionLike, readonly RuntimeFunctionLike[]>();
  const event = new Map<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>();
  for (const owner of scan.transitionOwners) {
    if (scan.nonTransitionSensitiveOwners.has(owner)) {
      continue;
    }
    const transitions = directTransitionContext(owner, imports);
    if (transitions) {
      direct.set(owner, transitions.callbacks);
      event.set(owner, transitions.eventCallbacks);
    }
  }
  return { direct, event };
}

interface DirectTransitionContext {
  callbacks: readonly RuntimeFunctionLike[];
  eventCallbacks: ReadonlySet<RuntimeFunctionLike>;
}

interface TransitionWalk {
  readonly owner: RuntimeFunctionLike;
  readonly body: ts.Node;
  readonly imports: HookImports;
  readonly bindings: ReadonlySet<string>;
  readonly callbacks: RuntimeFunctionLike[];
  readonly eventCallbacks: Set<RuntimeFunctionLike>;
  safe: boolean;
}

function directTransitionContext(
  owner: RuntimeFunctionLike,
  imports: HookImports,
): DirectTransitionContext | null {
  if (!owner.body) {
    return null;
  }
  const walk: TransitionWalk = {
    bindings: transitionStartBindings(owner.body, imports),
    body: owner.body,
    callbacks: [],
    eventCallbacks: new Set(),
    imports,
    owner,
    safe: true,
  };
  collectDirectTransitions(walk);
  if (!walk.safe || transitionsEscapeCallPosition(walk)) {
    return null;
  }
  return { callbacks: walk.callbacks, eventCallbacks: walk.eventCallbacks };
}

function transitionStartBindings(body: ts.Node, imports: HookImports): ReadonlySet<string> {
  const bindings = new Set<string>();
  visitSkippingNestedRuntimeFunctions(body, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      isImportedReactCall(node.initializer, imports, "useTransition")
    ) {
      const [, start] = node.name.elements;
      if (start && !ts.isOmittedExpression(start) && ts.isIdentifier(start.name)) {
        bindings.add(start.name.text);
      }
    }
  });
  return bindings;
}

function collectDirectTransitions(walk: TransitionWalk): void {
  visit(walk.body, (node) => {
    if (walk.safe && ts.isCallExpression(node)) {
      collectTransitionCall(node, walk);
    }
  });
}

function isDirectTransitionCall(node: ts.CallExpression, walk: TransitionWalk): boolean {
  return (
    (ts.isIdentifier(node.expression) && walk.bindings.has(node.expression.text)) ||
    isImportedReactCall(node, walk.imports, "startTransition")
  );
}

function collectTransitionCall(node: ts.CallExpression, walk: TransitionWalk): void {
  if (!isDirectTransitionCall(node, walk)) {
    return;
  }
  const callback = node.arguments[0]
    ? directTransitionCallback(node.arguments[0]!, walk.owner)
    : null;
  if (!callback) {
    walk.safe = false;
    return;
  }
  walk.safe = !callbackReadsOwnerFunction(callback, walk.owner);
  walk.callbacks.push(callback);
  if (isEventRootedTransition(node, walk.owner)) {
    walk.eventCallbacks.add(callback);
  }
}

function callbackReadsOwnerFunction(
  callback: RuntimeFunctionLike,
  owner: RuntimeFunctionLike,
): boolean {
  let reads = false;
  visit(callback.body, (reference) => {
    if (
      ts.isIdentifier(reference) &&
      !isDeclarationName(reference) &&
      !isNonValueIdentifier(reference) &&
      localFunctionBinding(owner, reference.text)
    ) {
      reads = true;
    }
  });
  return reads;
}

function isEventRootedTransition(node: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const caller = findAncestor(node, isRuntimeFunctionLike);
  return (
    caller !== null &&
    caller !== owner &&
    (ts.isArrowFunction(caller) ||
      ts.isFunctionDeclaration(caller) ||
      ts.isFunctionExpression(caller)) &&
    callbackIsEventRooted({ callback: caller, owner, dependencyName: "", seen: new Set() })
  );
}

function referenceIsCalledOrListed(node: ts.Node): boolean {
  return (
    (ts.isCallExpression(node.parent) && node.parent.expression === node) ||
    ts.isArrayLiteralExpression(node.parent)
  );
}

function isBareTransitionIdentifier(
  node: ts.Node,
  transitionBindings: ReadonlySet<string>,
): boolean {
  return (
    ts.isIdentifier(node) &&
    transitionBindings.has(node.text) &&
    !isDeclarationName(node) &&
    !isNonValueIdentifier(node) &&
    !referenceIsCalledOrListed(node)
  );
}

function isBareNamespacedStartTransition(node: ts.Node, imports: HookImports): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    imports.reactNamespaces.has(node.expression.text) &&
    node.name.text === "startTransition" &&
    !referenceIsCalledOrListed(node)
  );
}

function transitionsEscapeCallPosition(walk: TransitionWalk): boolean {
  const transitionBindings = new Set([...walk.bindings, ...walk.imports.startTransition]);
  let escapes = false;
  visit(walk.body, (node) => {
    if (
      isBareTransitionIdentifier(node, transitionBindings) ||
      isBareNamespacedStartTransition(node, walk.imports)
    ) {
      escapes = true;
    }
  });
  return escapes;
}

function constInitializer(owner: RuntimeFunctionLike, name: string): ts.Expression | null {
  const declaration = uniqueVariableDeclaration(owner, name);
  if (
    !declaration?.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  return unwrapTransparentExpression(declaration.initializer);
}

function isSoleReference(owner: RuntimeFunctionLike, value: ts.Identifier): boolean {
  let references = 0;
  let unique = true;
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === value.text &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references += 1;
      if (node !== value) {
        unique = false;
      }
    }
  });
  return unique && references === 1;
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
  const callback = constInitializer(owner, value.text);
  if (callback === null || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return null;
  }
  return isSoleReference(owner, value) ? callback : null;
}

interface LifecycleResolution {
  readonly owner: RuntimeFunctionLike;
  readonly imports: HookImports;
  readonly seen: ReadonlySet<string>;
}

type LifecycleCallback = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

function resolveLifecycleCallback(
  expression: ts.Expression,
  resolution: LifecycleResolution,
): LifecycleCallback | null {
  const value = unwrapTransparentExpression(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    return value;
  }
  if (!ts.isIdentifier(value) || resolution.seen.has(value.text)) {
    return null;
  }
  return (
    localFunctionBinding(resolution.owner, value.text) ?? resolveLifecycleAlias(value, resolution)
  );
}

function resolveLifecycleAlias(
  value: ts.Identifier,
  resolution: LifecycleResolution,
): LifecycleCallback | null {
  const initializer = constInitializer(resolution.owner, value.text);
  if (initializer === null) {
    return null;
  }
  const next = { ...resolution, seen: new Set(resolution.seen).add(value.text) };
  if (ts.isIdentifier(initializer)) {
    return resolveLifecycleCallback(initializer, next);
  }
  if (
    ts.isCallExpression(initializer) &&
    isImportedReactCall(initializer, resolution.imports, "useCallback") &&
    initializer.arguments[0]
  ) {
    return resolveLifecycleCallback(initializer.arguments[0], next);
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

function conditionalRefIdentityMayChange(
  value: ts.ConditionalExpression,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): boolean {
  return (
    refIdentityMayChange(value.whenTrue, owner, imports) ||
    refIdentityMayChange(value.whenFalse, owner, imports)
  );
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
    return conditionalRefIdentityMayChange(value, owner, imports);
  }
  return ts.isIdentifier(value) && aliasedRefIdentityMayChange(value, owner, imports);
}

function aliasedRefIdentityMayChange(
  value: ts.Identifier,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): boolean {
  if (localFunctionBinding(owner, value.text)) {
    return true;
  }
  const declaration = uniqueVariableDeclaration(owner, value.text);
  if (!declaration?.initializer) {
    return false;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  if (ts.isConditionalExpression(initializer)) {
    return conditionalRefIdentityMayChange(initializer, owner, imports);
  }
  return ts.isCallExpression(initializer) && !isStableReactRefFactory(initializer, imports);
}

function isStableReactRefFactory(call: ts.CallExpression, imports: HookImports): boolean {
  if (isImportedReactCall(call, imports, "useRef")) {
    return true;
  }
  if (!isImportedReactCall(call, imports, "useCallback")) {
    return false;
  }
  const [, dependencies] = call.arguments;
  if (!dependencies) {
    return false;
  }
  const value = unwrapTransparentExpression(dependencies);
  return ts.isArrayLiteralExpression(value) && value.elements.length === 0;
}

function isAbsentDependencyExpression(value: ts.Expression): boolean {
  return value.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(value);
}

function hasNoDependencyArray(call: ts.CallExpression): boolean {
  const [, dependency] = call.arguments;
  if (!dependency) {
    return true;
  }
  const value = unwrapTransparentExpression(dependency);
  if (isAbsentDependencyExpression(value)) {
    return true;
  }
  if (!ts.isIdentifier(value) || value.text !== "undefined") {
    return false;
  }
  return bindingIsUnshadowed(call, value.text);
}

function isReactEffectCall(call: ts.CallExpression, imports: HookImports): boolean {
  return (
    isImportedReactCall(call, imports, "useEffect") ||
    isImportedReactCall(call, imports, "useLayoutEffect") ||
    isImportedReactCall(call, imports, "useInsertionEffect")
  );
}

function isTransitionReference(node: ts.Node, imports: HookImports): boolean {
  if (ts.isCallExpression(node) && isImportedReactCall(node, imports, "useTransition")) {
    return true;
  }
  if (ts.isIdentifier(node)) {
    return imports.startTransition.has(node.text) && bindingIsUnshadowed(node, node.text);
  }
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    imports.reactNamespaces.has(node.expression.text) &&
    node.name.text === "startTransition" &&
    bindingIsUnshadowed(node, node.expression.text)
  );
}

function reactCallBinding(
  expression: ts.LeftHandSideExpression,
  imports: HookImports,
  hook: ReactHookImportName,
): string | null {
  if (ts.isIdentifier(expression) && imports[hook].has(expression.text)) {
    return expression.text;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    imports.reactNamespaces.has(expression.expression.text) &&
    expression.name.text === hook
  ) {
    return expression.expression.text;
  }
  return null;
}

function isImportedReactCall(
  call: ts.CallExpression,
  imports: HookImports,
  hook: ReactHookImportName,
): boolean {
  const binding = reactCallBinding(call.expression, imports, hook);
  return binding !== null && bindingIsUnshadowed(call, binding);
}

function bindingIsUnshadowed(node: ts.Node, name: string): boolean {
  const owner = findAncestor(node, isRuntimeFunctionLike);
  return owner === null || !hasLexicalBindingAt(node, owner, name);
}

const functionScopedBindingsByOwner = new WeakMap<RuntimeFunctionLike, ReadonlySet<string>>();

function functionScopedBindings(owner: RuntimeFunctionLike, body: ts.Node): ReadonlySet<string> {
  const cached = functionScopedBindingsByOwner.get(owner);
  if (cached) {
    return cached;
  }
  const collected = new Set<string>();
  visitSkippingNestedRuntimeFunctions(body, (current) => {
    if (
      ts.isVariableDeclaration(current) &&
      ts.isVariableDeclarationList(current.parent) &&
      (current.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0
    ) {
      collectBindingNames(current.name, collected);
    }
  });
  functionScopedBindingsByOwner.set(owner, collected);
  return collected;
}

function enclosingScopeDeclares(node: ts.Node, owner: RuntimeFunctionLike, name: string): boolean {
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

function hasLexicalBindingAt(node: ts.Node, owner: RuntimeFunctionLike, name: string): boolean {
  if (owner.parameters.some((parameter) => bindingContainsName(parameter.name, name))) {
    return true;
  }
  if (!owner.body) {
    return false;
  }
  return (
    functionScopedBindings(owner, owner.body).has(name) || enclosingScopeDeclares(node, owner, name)
  );
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
