import { CALLBACK_IDENTITY_HOOKS, reactNamespacesFor } from "./callback-identity-hooks.js";
import type {
  CallbackContractSourceResolver,
  CallbackDeferral,
  CallbackTrace,
  ChildComponentSource,
} from "./model.js";
import { atJsxInvocation, jsxOwnerIsDeferredEventTarget, jsxOwnerTarget } from "./jsx-owner.js";
import {
  callbackBindingName,
  callbackIsStoredInProperty,
  callbackRunsInImmediateReactHook,
  callbackRunsInProvenDeferredHook,
  identifierRunsInProvenDeferredHook,
} from "./callback-hosting.js";
import { findAncestorUntil, identifiersNamed, nearestNestedFunction } from "../../core/ast.js";
import {
  isHookDependencyReference,
  isSynchronousRenderCallback,
} from "../state-proofs/callback-sites.js";
import {
  jsxAttributeCarriesCallbackIdentity,
  jsxEventAttributeIsDeferred,
} from "./jsx-event-attributes.js";
import { MAX_CALLBACK_PATH_DEPTH } from "./model.js";
import { callbackReferenceIsObservationOnly } from "./observation-only-reads.js";
import { climbTransparentExpression } from "./carried-values.js";
import { higherOrderCallDefersCallback } from "./higher-order-factories.js";
import { isBindingName } from "./prop-bindings.js";
import { isNonValueIdentifier } from "../../core/analysis-ast.js";
import ts from "typescript";

interface CallbackInvocationProbe {
  readonly callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;
  readonly deferral: CallbackDeferral;
  readonly deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>;
  readonly depth: number;
  readonly owner: ChildComponentSource["owner"];
  readonly resolver: CallbackContractSourceResolver | undefined;
  readonly seenCallbacks: ReadonlySet<number>;
  readonly source: ChildComponentSource | undefined;
  readonly visited: ReadonlySet<string>;
}

function jsxReferenceIsDeferred(node: ts.Identifier, probe: CallbackInvocationProbe): boolean {
  const { deferral, depth, owner, resolver, source, visited } = probe;
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
  if (
    !attribute ||
    !/^on[A-Z]/u.test(attribute.name.getText()) ||
    !jsxAttributeCarriesCallbackIdentity(attribute, node)
  ) {
    return false;
  }
  const target = jsxOwnerTarget(attribute);
  if (
    jsxOwnerIsDeferredEventTarget(attribute, source) ||
    (source !== undefined &&
      resolver !== undefined &&
      target !== null &&
      resolver.frameworkEventComponent(source.file, target))
  ) {
    return true;
  }
  const child =
    source && resolver && target ? resolver.resolveComponent(source.file, target) : null;
  return (
    child !== null &&
    resolver !== undefined &&
    deferral.sourceInput({
      argumentIndex: 0,
      path: [attribute.name.getText()],
      source: atJsxInvocation(child, attribute, source),
      trace: { deferral, depth: depth + 1, resolver, returnTarget: null, visited },
    })
  );
}

function higherOrderReferenceIsDeferred(
  node: ts.Identifier,
  probe: CallbackInvocationProbe,
): boolean {
  const { deferral, depth, resolver, source, visited } = probe;
  return (
    source !== undefined &&
    resolver !== undefined &&
    higherOrderCallDefersCallback(node, source, {
      deferral,
      depth: depth + 1,
      resolver,
      returnTarget: null,
      visited,
    })
  );
}

function invokingCallerIsDeferred(
  node: ts.Identifier,
  nextCallbacks: ReadonlySet<number>,
  probe: CallbackInvocationProbe,
): boolean {
  const { deferral, deferredCallbackHooks, depth, owner, resolver, source, visited } = probe;
  if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) {
    return false;
  }
  const caller = nearestNestedFunction(node, owner);
  if (
    !caller ||
    (!ts.isArrowFunction(caller) &&
      !ts.isFunctionDeclaration(caller) &&
      !ts.isFunctionExpression(caller)) ||
    caller === owner
  ) {
    return false;
  }
  return (
    callbackRunsInProvenDeferredHook(caller, deferredCallbackHooks) ||
    callbackInvocationIsDeferred({
      callback: caller,
      deferral,
      deferredCallbackHooks,
      depth: depth + 1,
      owner,
      resolver,
      seenCallbacks: nextCallbacks,
      source,
      visited,
    })
  );
}

function callbackReferenceIsDeferred(
  node: ts.Identifier,
  nextCallbacks: ReadonlySet<number>,
  probe: CallbackInvocationProbe,
): boolean {
  const { deferredCallbackHooks, owner } = probe;
  if (
    isHookDependencyReference(
      node,
      CALLBACK_IDENTITY_HOOKS,
      reactNamespacesFor(owner.getSourceFile()),
    ) ||
    callbackReferenceIsObservationOnly(node)
  ) {
    return true;
  }
  if (jsxReferenceIsDeferred(node, probe)) {
    return true;
  }
  if (identifierRunsInProvenDeferredHook(node, deferredCallbackHooks)) {
    return true;
  }
  if (higherOrderReferenceIsDeferred(node, probe)) {
    return true;
  }
  return invokingCallerIsDeferred(node, nextCallbacks, probe);
}

function callbackReferencesAreDeferred(
  name: string,
  nextCallbacks: ReadonlySet<number>,
  probe: CallbackInvocationProbe,
): boolean {
  let referenced = false;
  let safe = true;
  for (const node of identifiersNamed(probe.owner.body, name)) {
    if (!safe) {
      break;
    }
    if (isBindingName(node) || isNonValueIdentifier(node)) {
      continue;
    }
    referenced = true;
    safe = callbackReferenceIsDeferred(node, nextCallbacks, probe);
  }
  return referenced && safe;
}

export function callbackInvocationIsDeferred(probe: CallbackInvocationProbe): boolean {
  const { callback, deferredCallbackHooks, depth, owner, seenCallbacks } = probe;
  if (depth > MAX_CALLBACK_PATH_DEPTH || seenCallbacks.has(callback.pos)) {
    return false;
  }
  if (isSynchronousRenderCallback(callback) || callbackRunsInImmediateReactHook(callback)) {
    return false;
  }
  const name = callbackBindingName(callback, owner);
  if (!name) {
    return (
      !ts.isFunctionDeclaration(callback) &&
      (callbackIsStoredInProperty(callback) ||
        callbackRunsInProvenDeferredHook(callback, deferredCallbackHooks))
    );
  }
  return callbackReferencesAreDeferred(name, new Set(seenCallbacks).add(callback.pos), probe);
}

export function callbackIsDeferredByJsx(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  source: ChildComponentSource,
  trace: CallbackTrace,
): boolean {
  if (ts.isFunctionDeclaration(callback) || trace.depth > MAX_CALLBACK_PATH_DEPTH) {
    return false;
  }
  const expression = climbTransparentExpression(callback);
  const attribute = findAncestorUntil(expression, ts.isJsxAttribute, source.owner);
  if (
    !attribute ||
    !/^on[A-Z]/u.test(attribute.name.getText()) ||
    !jsxAttributeCarriesCallbackIdentity(attribute, expression)
  ) {
    return false;
  }
  return jsxEventAttributeIsDeferred(attribute, source, trace);
}
