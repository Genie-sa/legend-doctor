import ts from "typescript";

import {
  bindingDeclarationCount,
  hookCallName,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import { findAncestorUntil, nearestNestedFunction, nodeWithin, visit } from "../ast.js";

export interface SourceHookDeclaration {
  readonly file: string;
  readonly owner: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;
  readonly sourceFile: ts.SourceFile;
}

export interface SourceHookResolver {
  resolveHook: (importerFile: string, name: string) => SourceHookDeclaration | null;
}

interface CallbackBinding {
  readonly name: ts.Identifier;
}

interface StoredCallbackRef {
  readonly declaration: ts.VariableDeclaration;
  readonly name: string;
  readonly property: string;
}

const MAX_CALLBACK_DEPTH = 8;
const REACT_EFFECT_HOOKS = new Set(["useEffect", "useInsertionEffect", "useLayoutEffect"]);
const reactHookImportsCache = new WeakMap<ts.SourceFile, ReactHookImports>();

/**
 * Proves that one callback input to a resolved project hook cannot execute
 * during render. The trace may cross other resolved hooks and one exact
 * latest-callback ref, but every terminal invocation must remain under a
 * React effect. Unknown calls, stale ref storage, aliases, and escapes fail.
 */
export function sourceHookDefersCallback(
  source: SourceHookDeclaration,
  argumentIndex: number,
  property: string | null,
  resolver: SourceHookResolver,
): boolean {
  return hookDefersCallback(source, argumentIndex, property, resolver, new Set(), 0);
}

function hookDefersCallback(
  source: SourceHookDeclaration,
  argumentIndex: number,
  property: string | null,
  resolver: SourceHookResolver,
  visited: ReadonlySet<string>,
  depth: number,
): boolean {
  if (depth > MAX_CALLBACK_DEPTH || !source.owner.body) {
    return false;
  }
  const key = `${source.file}\0${source.owner.pos}\0${argumentIndex}\0${property ?? ""}`;
  if (visited.has(key)) {
    return false;
  }
  const binding = callbackBinding(source.owner, argumentIndex, property);
  if (!binding || bindingDeclarationCount(source.owner, binding.name.text) !== 1) {
    return false;
  }
  const nextVisited = new Set(visited).add(key);
  const hooks = reactHookImports(source.sourceFile);
  const storedRef = storedCallbackRef(source, binding.name, hooks);
  if (storedRef && !refRefreshesCallback(source, binding.name, storedRef, hooks)) {
    return false;
  }
  let references = 0;
  let safe = true;
  visit(source.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== binding.name.text ||
      node === binding.name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    references += 1;
    if (storedRef && callbackReferenceIsRefStorage(node, storedRef, source.owner, hooks)) {
      return;
    }
    if (!referenceExecutesDeferred(node, source, resolver, hooks, nextVisited, depth)) {
      safe = false;
    }
  });
  return (
    safe &&
    references > 0 &&
    (!storedRef ||
      storedRefExecutesDeferred(storedRef, source, resolver, hooks, nextVisited, depth))
  );
}

function referenceExecutesDeferred(
  reference: ts.Identifier,
  source: SourceHookDeclaration,
  resolver: SourceHookResolver,
  hooks: ReactHookImports,
  visited: ReadonlySet<string>,
  depth: number,
): boolean {
  const callback = nearestNestedFunction(reference, source.owner);
  if (
    callback &&
    (ts.isArrowFunction(callback) ||
      ts.isFunctionDeclaration(callback) ||
      ts.isFunctionExpression(callback))
  ) {
    return callbackExecutesDeferred(callback, source, resolver, hooks, visited, depth + 1);
  }
  return referenceIsDirectDeferredHookArgument(reference, source, resolver, visited, depth + 1);
}

function callbackExecutesDeferred(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  source: SourceHookDeclaration,
  resolver: SourceHookResolver,
  hooks: ReactHookImports,
  visited: ReadonlySet<string>,
  depth: number,
): boolean {
  if (depth > MAX_CALLBACK_DEPTH) {
    return false;
  }
  if (callbackIsWithinReactEffect(callback, source.owner, hooks)) {
    return true;
  }
  if (!ts.isFunctionDeclaration(callback)) {
    const call = callback.parent;
    if (ts.isCallExpression(call)) {
      const argumentIndex = call.arguments.indexOf(callback);
      if (argumentIndex !== -1) {
        if (isImportedReactEffect(call, hooks)) {
          return true;
        }
        const name = hookCallName(call);
        const target = name ? resolver.resolveHook(source.file, name) : null;
        if (target && hookDefersCallback(target, argumentIndex, null, resolver, visited, depth)) {
          return true;
        }
      }
    }
  }

  const name = localCallbackName(callback);
  if (!name || !source.owner.body) {
    return false;
  }
  let references = 0;
  let safe = true;
  visit(source.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    references += 1;
    if (referenceIsDirectDeferredHookArgument(node, source, resolver, visited, depth)) {
      return;
    }
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      const caller = nearestNestedFunction(node, source.owner);
      if (
        caller &&
        (ts.isArrowFunction(caller) ||
          ts.isFunctionDeclaration(caller) ||
          ts.isFunctionExpression(caller)) &&
        callbackExecutesDeferred(caller, source, resolver, hooks, visited, depth + 1)
      ) {
        return;
      }
    }
    safe = false;
  });
  return safe && references > 0;
}

function referenceIsDirectDeferredHookArgument(
  reference: ts.Identifier,
  source: SourceHookDeclaration,
  resolver: SourceHookResolver,
  visited: ReadonlySet<string>,
  depth: number,
): boolean {
  const call = findAncestorUntil(reference, ts.isCallExpression, source.owner);
  if (!call) {
    return false;
  }
  const argumentIndex = call.arguments.findIndex((argument) => nodeWithin(reference, argument));
  if (argumentIndex === -1) {
    return false;
  }
  const hooks = reactHookImports(source.sourceFile);
  if (isImportedReactEffect(call, hooks)) {
    return true;
  }
  const name = hookCallName(call);
  const target = name ? resolver.resolveHook(source.file, name) : null;
  return (
    target !== null && hookDefersCallback(target, argumentIndex, null, resolver, visited, depth)
  );
}

function storedCallbackRef(
  source: SourceHookDeclaration,
  callback: ts.Identifier,
  hooks: ReactHookImports,
): StoredCallbackRef | null {
  const matches: StoredCallbackRef[] = [];
  visit(source.owner.body, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
      return;
    }
    const initializer = unwrapTransparentExpression(node.initializer);
    if (
      !ts.isCallExpression(initializer) ||
      !isImportedReactRef(initializer, hooks) ||
      !initializer.arguments[0]
    ) {
      return;
    }
    const object = unwrapTransparentExpression(initializer.arguments[0]!);
    if (!ts.isObjectLiteralExpression(object)) {
      return;
    }
    const property = objectPropertyForBinding(object, callback.text);
    if (property) {
      matches.push({ declaration: node, name: node.name.text, property });
    }
  });
  return matches.length === 1 ? matches[0]! : null;
}

function objectPropertyForBinding(
  object: ts.ObjectLiteralExpression,
  binding: string,
): string | null {
  const matches = object.properties.flatMap((property) => {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === binding) {
      return [property.name.text];
    }
    const value = ts.isPropertyAssignment(property)
      ? unwrapTransparentExpression(property.initializer)
      : null;
    if (
      ts.isPropertyAssignment(property) &&
      value &&
      ts.isIdentifier(value) &&
      value.text === binding
    ) {
      const name = staticPropertyName(property.name);
      return name ? [name] : [];
    }
    return [];
  });
  return matches.length === 1 ? matches[0]! : null;
}

function callbackReferenceIsRefStorage(
  reference: ts.Identifier,
  storedRef: StoredCallbackRef,
  owner: SourceHookDeclaration["owner"],
  hooks: ReactHookImports,
): boolean {
  const property = reference.parent;
  if (
    !(
      (ts.isShorthandPropertyAssignment(property) && property.name === reference) ||
      (ts.isPropertyAssignment(property) && nodeWithin(reference, property.initializer))
    ) ||
    property.parent.kind !== ts.SyntaxKind.ObjectLiteralExpression
  ) {
    return false;
  }
  // SAFETY: The parent kind check above proves this node is an object literal.
  const object = property.parent as ts.ObjectLiteralExpression;
  const propertyName = objectPropertyName(property);
  if (propertyName !== storedRef.property) {
    return false;
  }
  if (nodeWithin(object, storedRef.declaration.initializer!)) {
    return true;
  }
  const assignment = object.parent;
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    assignment.right !== object ||
    !isRefCurrent(assignment.left, storedRef.name)
  ) {
    return false;
  }
  const callback = nearestNestedFunction(assignment, owner);
  return (
    callback !== null &&
    (ts.isArrowFunction(callback) ||
      ts.isFunctionDeclaration(callback) ||
      ts.isFunctionExpression(callback)) &&
    callbackIsReactEffectArgument(callback, hooks)
  );
}

function refRefreshesCallback(
  source: SourceHookDeclaration,
  callback: ts.Identifier,
  storedRef: StoredCallbackRef,
  hooks: ReactHookImports,
): boolean {
  let refreshes = 0;
  visit(source.owner.body, (node) => {
    if (
      !ts.isIdentifier(node) ||
      node.text !== callback.text ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const property = node.parent;
    if (
      !(
        (ts.isShorthandPropertyAssignment(property) && property.name === node) ||
        (ts.isPropertyAssignment(property) && nodeWithin(node, property.initializer))
      ) ||
      !ts.isObjectLiteralExpression(property.parent) ||
      objectPropertyName(property) !== storedRef.property
    ) {
      return;
    }
    const assignment = property.parent.parent;
    const effect = nearestNestedFunction(assignment, source.owner);
    if (
      ts.isBinaryExpression(assignment) &&
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      assignment.right === property.parent &&
      isRefCurrent(assignment.left, storedRef.name) &&
      effect &&
      (ts.isArrowFunction(effect) ||
        ts.isFunctionDeclaration(effect) ||
        ts.isFunctionExpression(effect)) &&
      callbackIsReactEffectArgument(effect, hooks)
    ) {
      refreshes += 1;
    }
  });
  return refreshes === 1;
}

function objectPropertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name.text;
  }
  return ts.isPropertyAssignment(property) ? staticPropertyName(property.name) : null;
}

function storedRefExecutesDeferred(
  storedRef: StoredCallbackRef,
  source: SourceHookDeclaration,
  resolver: SourceHookResolver,
  hooks: ReactHookImports,
  visited: ReadonlySet<string>,
  depth: number,
): boolean {
  if (bindingDeclarationCount(source.owner, storedRef.name) !== 1) {
    return false;
  }
  let calls = 0;
  let safe = true;
  visit(source.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== storedRef.name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (refCurrentAssignment(node, storedRef.name)) {
      return;
    }
    const callbackAccess = refObjectPropertyAccess(node);
    if (!callbackAccess) {
      safe = false;
      return;
    }
    if (callbackAccess.name.text !== storedRef.property) {
      return;
    }
    if (
      !ts.isCallExpression(callbackAccess.parent) ||
      callbackAccess.parent.expression !== callbackAccess
    ) {
      safe = false;
      return;
    }
    calls += 1;
    const callback = nearestNestedFunction(callbackAccess, source.owner);
    if (
      !callback ||
      (!ts.isArrowFunction(callback) &&
        !ts.isFunctionDeclaration(callback) &&
        !ts.isFunctionExpression(callback)) ||
      !callbackExecutesDeferred(callback, source, resolver, hooks, visited, depth + 1)
    ) {
      safe = false;
    }
  });
  return safe && calls > 0;
}

function refCurrentAssignment(reference: ts.Identifier, refName: string): boolean {
  const current = reference.parent;
  return (
    ts.isPropertyAccessExpression(current) &&
    current.expression === reference &&
    current.name.text === "current" &&
    ts.isBinaryExpression(current.parent) &&
    current.parent.left === current &&
    current.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    isRefCurrent(current, refName)
  );
}

function refObjectPropertyAccess(reference: ts.Identifier): ts.PropertyAccessExpression | null {
  const current = reference.parent;
  if (
    !ts.isPropertyAccessExpression(current) ||
    current.expression !== reference ||
    current.name.text !== "current"
  ) {
    return null;
  }
  const callback = current.parent;
  return ts.isPropertyAccessExpression(callback) && callback.expression === current
    ? callback
    : null;
}

function isRefCurrent(expression: ts.Expression, refName: string): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === refName &&
    expression.name.text === "current"
  );
}

function callbackIsWithinReactEffect(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: SourceHookDeclaration["owner"],
  hooks: ReactHookImports,
): boolean {
  for (
    let current: ts.Node | undefined = callback;
    current && current !== owner;
    current = current.parent
  ) {
    if (
      (ts.isArrowFunction(current) ||
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current)) &&
      callbackIsReactEffectArgument(current, hooks)
    ) {
      return true;
    }
  }
  return false;
}

function callbackIsReactEffectArgument(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  hooks: ReactHookImports,
): boolean {
  if (ts.isFunctionDeclaration(callback) || !ts.isCallExpression(callback.parent)) {
    return false;
  }
  return (
    callback.parent.arguments.includes(callback) && isImportedReactEffect(callback.parent, hooks)
  );
}

function staticPropertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
}

function callbackBinding(
  owner: SourceHookDeclaration["owner"],
  argumentIndex: number,
  property: string | null,
): CallbackBinding | null {
  const parameter = owner.parameters[argumentIndex];
  if (!parameter) {
    return null;
  }
  if (property === null) {
    return ts.isIdentifier(parameter.name) ? { name: parameter.name } : null;
  }
  if (!ts.isObjectBindingPattern(parameter.name)) {
    return null;
  }
  for (const element of parameter.name.elements) {
    if (
      !ts.isBindingElement(element) ||
      element.dotDotDotToken ||
      element.initializer ||
      !ts.isIdentifier(element.name)
    ) {
      continue;
    }
    const sourceName =
      element.propertyName && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : element.name.text;
    if (sourceName === property) {
      return { name: element.name };
    }
  }
  return null;
}

function localCallbackName(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
): string | null {
  if (ts.isFunctionDeclaration(callback)) {
    return callback.name?.text ?? null;
  }
  return ts.isVariableDeclaration(callback.parent) && ts.isIdentifier(callback.parent.name)
    ? callback.parent.name.text
    : null;
}

interface ReactHookImports {
  readonly effectNames: ReadonlySet<string>;
  readonly namespaces: ReadonlySet<string>;
  readonly refNames: ReadonlySet<string>;
}

function reactHookImports(sourceFile: ts.SourceFile): ReactHookImports {
  const cached = reactHookImportsCache.get(sourceFile);
  if (cached) {
    return cached;
  }
  const effectNames = new Set<string>();
  const namespaces = new Set<string>();
  const refNames = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "react"
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (clause?.name) {
      namespaces.add(clause.name.text);
    }
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (REACT_EFFECT_HOOKS.has(imported)) {
          effectNames.add(element.name.text);
        }
        if (imported === "useRef") {
          refNames.add(element.name.text);
        }
      }
    }
  }
  const imports = { effectNames, namespaces, refNames };
  reactHookImportsCache.set(sourceFile, imports);
  return imports;
}

function isImportedReactEffect(call: ts.CallExpression, imports: ReactHookImports): boolean {
  if (ts.isIdentifier(call.expression)) {
    return imports.effectNames.has(call.expression.text);
  }
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    imports.namespaces.has(call.expression.expression.text) &&
    REACT_EFFECT_HOOKS.has(call.expression.name.text)
  );
}

function isImportedReactRef(call: ts.CallExpression, imports: ReactHookImports): boolean {
  if (ts.isIdentifier(call.expression)) {
    return imports.refNames.has(call.expression.text);
  }
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    imports.namespaces.has(call.expression.expression.text) &&
    call.expression.name.text === "useRef"
  );
}
