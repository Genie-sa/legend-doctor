import {
  bindingDeclarationCount,
  hookCallName,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import { findAncestorUntil, nearestNestedFunction, nodeWithin, visit } from "../ast.js";
import ts from "typescript";

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

/** The callback input of one resolved hook, identified the way a caller passes it in. */
interface DeferredCallbackQuery {
  readonly argumentIndex: number;
  readonly property: string | null;
  readonly source: SourceHookDeclaration;
}

/** How far the trace has recursed, which hook inputs it already entered, and how to resolve more. */
interface ResolverTrace {
  readonly depth: number;
  readonly resolver: SourceHookResolver;
  readonly visited: ReadonlySet<string>;
}

/** The hook body being walked, together with the React imports of its source file. */
interface HookBody {
  readonly hooks: ReactHookImports;
  readonly source: SourceHookDeclaration;
}

/** Everything one deferral step needs: the hook body plus the trace state carried into it. */
interface CallbackTrace {
  readonly depth: number;
  readonly hooks: ReactHookImports;
  readonly resolver: SourceHookResolver;
  readonly source: SourceHookDeclaration;
  readonly visited: ReadonlySet<string>;
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
  return hookDefersCallback(
    { argumentIndex, property, source },
    { depth: 0, resolver, visited: new Set() },
  );
}

function hookDefersCallback(query: DeferredCallbackQuery, trace: ResolverTrace): boolean {
  const key = hookCallbackKey(query);
  if (trace.depth > MAX_CALLBACK_DEPTH || !query.source.owner.body || trace.visited.has(key)) {
    return false;
  }
  const { argumentIndex, property, source } = query;
  const binding = callbackBinding(source.owner, argumentIndex, property);
  if (!binding || bindingDeclarationCount(source.owner, binding.name.text) !== 1) {
    return false;
  }
  return bindingIsDeferred(binding.name, {
    depth: trace.depth,
    hooks: reactHookImports(source.sourceFile),
    resolver: trace.resolver,
    source,
    visited: new Set(trace.visited).add(key),
  });
}

/** Identifies one callback input of one hook declaration, so a trace never re-enters it. */
function hookCallbackKey(query: DeferredCallbackQuery): string {
  const { argumentIndex, property, source } = query;
  return `${source.file}\0${source.owner.pos}\0${argumentIndex}\0${property ?? ""}`;
}

/** The binding is refreshed through at most one latest-callback ref and never runs on render. */
function bindingIsDeferred(binding: ts.Identifier, trace: CallbackTrace): boolean {
  const storedRef = storedCallbackRef(binding, trace);
  if (storedRef && !refRefreshesCallback(binding, storedRef, trace)) {
    return false;
  }
  return (
    callbackBindingOnlyDefers(binding, storedRef, trace) &&
    (!storedRef || storedRefExecutesDeferred(storedRef, trace))
  );
}

/** Every value reference to the callback parameter either stores it in the ref or defers it. */
function callbackBindingOnlyDefers(
  binding: ts.Identifier,
  storedRef: StoredCallbackRef | null,
  trace: CallbackTrace,
): boolean {
  let references = 0;
  let safe = true;
  visit(trace.source.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== binding.text ||
      node === binding ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    references += 1;
    if (storedRef && callbackReferenceIsRefStorage(node, storedRef, trace)) {
      return;
    }
    if (!referenceExecutesDeferred(node, trace)) {
      safe = false;
    }
  });
  return safe && references > 0;
}

function referenceExecutesDeferred(reference: ts.Identifier, trace: CallbackTrace): boolean {
  const callback = nearestNestedFunction(reference, trace.source.owner);
  const deeper: CallbackTrace = { ...trace, depth: trace.depth + 1 };
  return callback && isTracedFunction(callback)
    ? callbackExecutesDeferred(callback, deeper)
    : referenceIsDirectDeferredHookArgument(reference, deeper);
}

function callbackExecutesDeferred(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  trace: CallbackTrace,
): boolean {
  if (trace.depth > MAX_CALLBACK_DEPTH) {
    return false;
  }
  if (callbackIsWithinReactEffect(callback, trace.source.owner, trace.hooks)) {
    return true;
  }
  if (callbackIsDeferredHookArgument(callback, trace)) {
    return true;
  }
  const name = localCallbackName(callback);
  if (!name || !trace.source.owner.body) {
    return false;
  }
  return localCallbackOnlyDefers(name, trace);
}

/** The callback is written inline as an argument of a React effect or of a deferring hook. */
function callbackIsDeferredHookArgument(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  trace: CallbackTrace,
): boolean {
  if (ts.isFunctionDeclaration(callback)) {
    return false;
  }
  const call = callback.parent;
  if (!ts.isCallExpression(call)) {
    return false;
  }
  const argumentIndex = call.arguments.indexOf(callback);
  return argumentIndex !== -1 && callDefersArgument(call, argumentIndex, trace);
}

/** Every reference to the named local callback is reached only from deferred code. */
function localCallbackOnlyDefers(name: string, trace: CallbackTrace): boolean {
  let references = 0;
  let safe = true;
  visit(trace.source.owner.body, (node) => {
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
    if (!localCallbackReferenceDefers(node, trace)) {
      safe = false;
    }
  });
  return safe && references > 0;
}

function localCallbackReferenceDefers(reference: ts.Identifier, trace: CallbackTrace): boolean {
  if (referenceIsDirectDeferredHookArgument(reference, trace)) {
    return true;
  }
  if (!ts.isCallExpression(reference.parent) || reference.parent.expression !== reference) {
    return false;
  }
  const caller = nearestNestedFunction(reference, trace.source.owner);
  if (!caller || !isTracedFunction(caller)) {
    return false;
  }
  return callbackExecutesDeferred(caller, { ...trace, depth: trace.depth + 1 });
}

function referenceIsDirectDeferredHookArgument(
  reference: ts.Identifier,
  trace: CallbackTrace,
): boolean {
  const call = findAncestorUntil(reference, ts.isCallExpression, trace.source.owner);
  if (!call) {
    return false;
  }
  const argumentIndex = call.arguments.findIndex((argument) => nodeWithin(reference, argument));
  return argumentIndex !== -1 && callDefersArgument(call, argumentIndex, trace);
}

/** The call is a React effect, or a resolved project hook that itself defers that argument. */
function callDefersArgument(
  call: ts.CallExpression,
  argumentIndex: number,
  trace: CallbackTrace,
): boolean {
  if (isImportedReactEffect(call, trace.hooks)) {
    return true;
  }
  const name = hookCallName(call);
  const target = name ? trace.resolver.resolveHook(trace.source.file, name) : null;
  return (
    target !== null && hookDefersCallback({ argumentIndex, property: null, source: target }, trace)
  );
}

function storedCallbackRef(callback: ts.Identifier, body: HookBody): StoredCallbackRef | null {
  const matches: StoredCallbackRef[] = [];
  visit(body.source.owner.body, (node) => {
    const stored = refStoringCallback(node, callback.text, body.hooks);
    if (stored) {
      matches.push(stored);
    }
  });
  return matches.length === 1 ? matches[0]! : null;
}

/** A `useRef({ ... })` declaration whose literal captures the given binding under one property. */
function refStoringCallback(
  node: ts.Node,
  binding: string,
  hooks: ReactHookImports,
): StoredCallbackRef | null {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
    return null;
  }
  const initializer = unwrapTransparentExpression(node.initializer);
  if (
    !ts.isCallExpression(initializer) ||
    !isImportedReactRef(initializer, hooks) ||
    !initializer.arguments[0]
  ) {
    return null;
  }
  const object = unwrapTransparentExpression(initializer.arguments[0]!);
  if (!ts.isObjectLiteralExpression(object)) {
    return null;
  }
  const property = objectPropertyForBinding(object, binding);
  return property ? { declaration: node, name: node.name.text, property } : null;
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
  body: HookBody,
): boolean {
  const member = objectLiteralMemberFor(reference);
  if (!member || objectPropertyName(member.property) !== storedRef.property) {
    return false;
  }
  if (nodeWithin(member.object, storedRef.declaration.initializer!)) {
    return true;
  }
  return refObjectIsAssignedInEffect(member.object, storedRef, body);
}

function refRefreshesCallback(
  callback: ts.Identifier,
  storedRef: StoredCallbackRef,
  body: HookBody,
): boolean {
  let refreshes = 0;
  visit(body.source.owner.body, (node) => {
    if (
      !ts.isIdentifier(node) ||
      node.text !== callback.text ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const member = objectLiteralMemberFor(node);
    if (
      member &&
      objectPropertyName(member.property) === storedRef.property &&
      refObjectIsAssignedInEffect(member.object, storedRef, body)
    ) {
      refreshes += 1;
    }
  });
  return refreshes === 1;
}

interface ObjectLiteralMember {
  readonly object: ts.ObjectLiteralExpression;
  readonly property: ts.ObjectLiteralElementLike;
}

/** The object literal member that carries this reference, either shorthand or as the value. */
function objectLiteralMemberFor(reference: ts.Node): ObjectLiteralMember | null {
  const property = reference.parent;
  if (ts.isShorthandPropertyAssignment(property) && property.name === reference) {
    return ts.isObjectLiteralExpression(property.parent)
      ? { object: property.parent, property }
      : null;
  }
  if (ts.isPropertyAssignment(property) && nodeWithin(reference, property.initializer)) {
    return ts.isObjectLiteralExpression(property.parent)
      ? { object: property.parent, property }
      : null;
  }
  return null;
}

/** The literal is the right side of a `ref.current = { ... }` written inside a React effect. */
function refObjectIsAssignedInEffect(
  object: ts.ObjectLiteralExpression,
  storedRef: StoredCallbackRef,
  body: HookBody,
): boolean {
  const assignment = object.parent;
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    assignment.right !== object ||
    !isRefCurrent(assignment.left, storedRef.name)
  ) {
    return false;
  }
  const effect = nearestNestedFunction(assignment, body.source.owner);
  return (
    effect !== null && isTracedFunction(effect) && callbackIsReactEffectArgument(effect, body.hooks)
  );
}

function objectPropertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name.text;
  }
  return ts.isPropertyAssignment(property) ? staticPropertyName(property.name) : null;
}

function storedRefExecutesDeferred(storedRef: StoredCallbackRef, trace: CallbackTrace): boolean {
  if (bindingDeclarationCount(trace.source.owner, storedRef.name) !== 1) {
    return false;
  }
  let calls = 0;
  let safe = true;
  visit(trace.source.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== storedRef.name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const outcome = storedRefReferenceOutcome(node, storedRef, trace);
    if (outcome === "unsafe") {
      safe = false;
      return;
    }
    if (outcome === "deferred-call") {
      calls += 1;
    }
  });
  return safe && calls > 0;
}

type StoredRefReferenceOutcome = "deferred-call" | "ignored" | "unsafe";

/** Classifies one use of the latest-callback ref binding inside the hook body. */
function storedRefReferenceOutcome(
  reference: ts.Identifier,
  storedRef: StoredCallbackRef,
  trace: CallbackTrace,
): StoredRefReferenceOutcome {
  if (refCurrentAssignment(reference, storedRef.name)) {
    return "ignored";
  }
  const callbackAccess = refObjectPropertyAccess(reference);
  if (!callbackAccess) {
    return "unsafe";
  }
  if (callbackAccess.name.text !== storedRef.property) {
    return "ignored";
  }
  return storedRefCallDefers(callbackAccess, trace) ? "deferred-call" : "unsafe";
}

/** The stored callback is invoked here, and the function holding that call is itself deferred. */
function storedRefCallDefers(access: ts.PropertyAccessExpression, trace: CallbackTrace): boolean {
  if (!ts.isCallExpression(access.parent) || access.parent.expression !== access) {
    return false;
  }
  const callback = nearestNestedFunction(access, trace.source.owner);
  if (!callback || !isTracedFunction(callback)) {
    return false;
  }
  return callbackExecutesDeferred(callback, { ...trace, depth: trace.depth + 1 });
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

function isTracedFunction(
  node: ts.Node,
): node is ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression {
  return (
    ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
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
    if (isTracedFunction(current) && callbackIsReactEffectArgument(current, hooks)) {
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
  return ts.isObjectBindingPattern(parameter.name)
    ? destructuredBinding(parameter.name, property)
    : null;
}

/** The plain element of an object binding pattern that reads the named source property. */
function destructuredBinding(
  pattern: ts.ObjectBindingPattern,
  property: string,
): CallbackBinding | null {
  for (const element of pattern.elements) {
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

interface MutableReactHookImports {
  readonly effectNames: Set<string>;
  readonly namespaces: Set<string>;
  readonly refNames: Set<string>;
}

function reactHookImports(sourceFile: ts.SourceFile): ReactHookImports {
  const cached = reactHookImportsCache.get(sourceFile);
  if (cached) {
    return cached;
  }
  const imports = collectReactHookImports(sourceFile);
  reactHookImportsCache.set(sourceFile, imports);
  return imports;
}

function collectReactHookImports(sourceFile: ts.SourceFile): ReactHookImports {
  const collected = {
    effectNames: new Set<string>(),
    namespaces: new Set<string>(),
    refNames: new Set<string>(),
  };
  for (const statement of sourceFile.statements) {
    if (isReactImportDeclaration(statement)) {
      addReactImportBindings(statement.importClause, collected);
    }
  }
  return collected;
}

function isReactImportDeclaration(statement: ts.Statement): statement is ts.ImportDeclaration {
  return (
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === "react"
  );
}

function addReactImportBindings(
  clause: ts.ImportClause | undefined,
  into: MutableReactHookImports,
): void {
  if (clause?.name) {
    into.namespaces.add(clause.name.text);
  }
  const bindings = clause?.namedBindings;
  if (!bindings) {
    return;
  }
  if (ts.isNamespaceImport(bindings)) {
    into.namespaces.add(bindings.name.text);
  } else if (ts.isNamedImports(bindings)) {
    addNamedReactHookImports(bindings, into);
  }
}

function addNamedReactHookImports(bindings: ts.NamedImports, into: MutableReactHookImports): void {
  for (const element of bindings.elements) {
    const imported = element.propertyName?.text ?? element.name.text;
    if (REACT_EFFECT_HOOKS.has(imported)) {
      into.effectNames.add(element.name.text);
    }
    if (imported === "useRef") {
      into.refNames.add(element.name.text);
    }
  }
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
