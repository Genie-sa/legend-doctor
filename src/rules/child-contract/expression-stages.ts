import { CALLBACK_IDENTITY_HOOKS, reactNamespacesFor } from "./callback-identity-hooks.js";
import type {
  CallbackExpressionProbe,
  CallbackReturnTarget,
  CallbackTrace,
  ChildComponentSource,
} from "./model.js";
import { atJsxInvocation, jsxOwnerIsDeferredEventTarget, jsxOwnerTarget } from "./jsx-owner.js";
import { callbackInvocationIsDeferred, callbackIsDeferredByJsx } from "./invocation-trace.js";
import { climbTransparentExpression, directConstAlias } from "./carried-values.js";
import {
  directCallArgument,
  forwardedObjectCall,
  returnedCallbackPath,
} from "./hook-boundary-paths.js";
import { findAncestorUntil, nearestNestedFunction, nodeWithin } from "../../core/ast.js";
import { baseUiRenderEventStage } from "./base-ui-render-events.js";
import { callbackReferenceIsObservationOnly } from "./observation-only-reads.js";
import { contextPropertyConsumersAreDeferred } from "./context-consumers.js";
import { deeperTrace } from "./model.js";
import { deferredArrayItemCallbackPublication } from "./array-item-callbacks.js";
import { isHookDependencyReference } from "../state-proofs/callback-sites.js";
import { jsxAttributeCarriesCallbackIdentity } from "./jsx-event-attributes.js";
import { memoizedContextPublication } from "./context-publication.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

function constAliasStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  const alias = directConstAlias(value, source.owner);
  return alias
    ? trace.deferral.trackedPath(
        source,
        { name: alias.text, path },
        deeperTrace(trace, trace.returnTarget),
      )
    : null;
}

function returnTargetStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  const { returnTarget } = trace;
  if (!returnTarget) {
    return null;
  }
  const returnedPath = returnedCallbackPath(value, path, source.owner);
  if (returnedPath === "ignored") {
    return true;
  }
  return returnedPath &&
    callResultCallbackIsDeferred(returnTarget, returnedPath, deeperTrace(trace, null))
    ? true
    : null;
}

function jsxAttributeIsDeferredEvent(
  attribute: ts.JsxAttribute | ts.JsxSpreadAttribute,
  source: ChildComponentSource,
  trace: CallbackTrace,
): boolean {
  const target = jsxOwnerTarget(attribute);
  return (
    jsxOwnerIsDeferredEventTarget(attribute, source) ||
    (target !== null && trace.resolver.frameworkEventComponent(source.file, target))
  );
}

function childInputIsDeferred(options: {
  readonly attribute: ts.JsxAttribute | ts.JsxSpreadAttribute;
  readonly path: readonly string[];
  readonly probe: CallbackExpressionProbe;
}): boolean {
  const { attribute, path, probe } = options;
  const { source, trace } = probe;
  const target = jsxOwnerTarget(attribute);
  const child = target ? trace.resolver.resolveComponent(source.file, target) : null;
  return (
    child !== null &&
    trace.deferral.sourceInput({
      argumentIndex: 0,
      path,
      source: atJsxInvocation(child, attribute, source),
      trace: deeperTrace(trace, null),
    })
  );
}

function jsxAttributeStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  const attribute = findAncestorUntil(value, ts.isJsxAttribute, source.owner);
  if (
    !attribute?.initializer ||
    !nodeWithin(value, attribute.initializer) ||
    !jsxAttributeCarriesCallbackIdentity(attribute, value)
  ) {
    return null;
  }
  const prop = attribute.name.getText();
  if (
    path.length === 0 &&
    /^on[A-Z]/u.test(prop) &&
    jsxAttributeIsDeferredEvent(attribute, source, trace)
  ) {
    return true;
  }
  return childInputIsDeferred({ attribute, path: [prop, ...path], probe });
}

function jsxSpreadStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  const spread = findAncestorUntil(value, ts.isJsxSpreadAttribute, source.owner);
  if (
    !spread ||
    !nodeWithin(value, spread.expression) ||
    unwrapTransparentExpression(spread.expression) !== unwrapTransparentExpression(value)
  ) {
    return null;
  }
  if (
    jsxOwnerTarget(spread) !== null &&
    path.length === 1 &&
    /^on[A-Z]/u.test(path[0] ?? "") &&
    jsxAttributeIsDeferredEvent(spread, source, trace)
  ) {
    return true;
  }
  return childInputIsDeferred({ attribute: spread, path, probe });
}

function hookDependencyStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, source } = probe;
  return ts.isIdentifier(value) &&
    isHookDependencyReference(
      value,
      CALLBACK_IDENTITY_HOOKS,
      reactNamespacesFor(source.owner.getSourceFile()),
    )
    ? true
    : null;
}

function observationOnlyStage(probe: CallbackExpressionProbe): boolean | null {
  return probe.path.length === 0 && callbackReferenceIsObservationOnly(probe.expression)
    ? true
    : null;
}

function arrayPublicationStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  if (path.length > 0) {
    return null;
  }
  return deferredArrayItemCallbackPublication(source, value, trace);
}

function contextPublicationStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  if (path.length > 0) {
    return null;
  }
  const publication = memoizedContextPublication(value, source.owner);
  if (!publication) {
    return null;
  }
  return contextPropertyConsumersAreDeferred({
    contextName: publication.contextName,
    property: publication.property,
    providerFile: source.file,
    trace: deeperTrace(trace, null),
  })
    ? true
    : null;
}

function nestedCallbackStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  if (path.length > 0) {
    return null;
  }
  const callback = nearestNestedFunction(value, source.owner);
  if (
    !callback ||
    (!ts.isArrowFunction(callback) &&
      !ts.isFunctionDeclaration(callback) &&
      !ts.isFunctionExpression(callback))
  ) {
    return null;
  }
  const deferred =
    callbackIsDeferredByJsx(callback, source, deeperTrace(trace, null)) ||
    callbackInvocationIsDeferred({
      callback,
      deferral: trace.deferral,
      deferredCallbackHooks: source.deferredCallbackHooks,
      depth: trace.depth + 1,
      owner: source.owner,
      resolver: trace.resolver,
      seenCallbacks: new Set(),
      source,
      visited: trace.visited,
    });
  return deferred ? true : null;
}

function forwardedObjectStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  const objectForward = forwardedObjectCall(value, source.owner);
  if (!objectForward) {
    return null;
  }
  const hook = trace.resolver.resolveHook(source.file, objectForward.hookName);
  return (
    hook !== null &&
    trace.deferral.sourceInput({
      argumentIndex: objectForward.argumentIndex,
      path: [objectForward.property, ...path],
      source: hook,
      trace: deeperTrace(trace, { call: objectForward.call, source }),
    })
  );
}

function directCallStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  const directCall = directCallArgument(value, source.owner);
  if (!directCall) {
    return null;
  }
  if (
    path.length === 0 &&
    trace.resolver.hookCallbackIsDeferred(
      source.file,
      directCall.hookName,
      directCall.argumentIndex,
    )
  ) {
    return true;
  }
  const hook = trace.resolver.resolveHook(source.file, directCall.hookName);
  return (
    hook !== null &&
    trace.deferral.sourceInput({
      argumentIndex: directCall.argumentIndex,
      path,
      source: hook,
      trace: deeperTrace(trace, { call: directCall.call, source }),
    })
  );
}

const CALLBACK_EXPRESSION_STAGES: readonly ((probe: CallbackExpressionProbe) => boolean | null)[] =
  [
    constAliasStage,
    returnTargetStage,
    jsxAttributeStage,
    jsxSpreadStage,
    hookDependencyStage,
    observationOnlyStage,
    arrayPublicationStage,
    contextPublicationStage,
    nestedCallbackStage,
    baseUiRenderEventStage,
    forwardedObjectStage,
    directCallStage,
  ];

export function callbackPathExpressionIsDeferred(probe: CallbackExpressionProbe): boolean {
  const resolved: CallbackExpressionProbe = {
    expression: climbTransparentExpression(probe.expression),
    path: probe.path,
    source: probe.source,
    trace: probe.trace,
  };
  for (const stage of CALLBACK_EXPRESSION_STAGES) {
    const verdict = stage(resolved);
    if (verdict !== null) {
      return verdict;
    }
  }
  return false;
}

function callResultCallbackIsDeferred(
  target: CallbackReturnTarget,
  path: readonly string[],
  trace: CallbackTrace,
): boolean {
  const expression = climbTransparentExpression(target.call);
  const alias = directConstAlias(expression, target.source.owner);
  return (
    alias !== null && trace.deferral.trackedPath(target.source, { name: alias.text, path }, trace)
  );
}
