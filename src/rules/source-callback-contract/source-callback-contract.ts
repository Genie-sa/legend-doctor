import type {
  CallbackBinding,
  CallbackTrace,
  DeferredCallbackQuery,
  ResolverTrace,
  SourceHookDeclaration,
  SourceHookResolver,
  StoredCallbackRef,
} from "./model.js";
import {
  bindingDeclarationCount,
  hookCallName,
  isDeclarationName,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import {
  callbackIsWithinReactEffect,
  isImportedReactEffect,
  isTracedFunction,
  reactHookImports,
} from "./react-effects.js";
import {
  callbackReferenceIsRefStorage,
  refCurrentAssignment,
  refObjectPropertyAccess,
  refRefreshesCallback,
  storedCallbackRef,
} from "./latest-callback-ref.js";
import { findAncestorUntil, nearestNestedFunction, nodeWithin, visit } from "../../core/ast.js";
import ts from "typescript";

const MAX_CALLBACK_DEPTH = 8;

/**
 * Proves that one callback input to a resolved project hook cannot execute
 * during render. The trace may cross other resolved hooks and one exact
 * latest-callback ref, but every terminal invocation must remain under a
 * React effect. Unknown calls, stale ref storage, aliases, and escapes fail.
 */
export interface SourceHookCallbackQuery {
  readonly argumentIndex: number;
  readonly property: string | null;
  readonly resolver: SourceHookResolver;
  readonly source: SourceHookDeclaration;
}

export function sourceHookDefersCallback({
  argumentIndex,
  property,
  resolver,
  source,
}: SourceHookCallbackQuery): boolean {
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
