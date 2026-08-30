import type { StateCandidate, StateUsage } from "../analyze-source.js";
import {
  hasIndependentRenderCutWitness,
  nearestRepeatedRenderCall,
  stateMayHoldCallable,
} from "./state-proofs.js";
import { nearestNestedFunction, nodeWithin, visit } from "../ast.js";
import type { RuntimeFunctionLike } from "../ast.js";
import ts from "typescript";

export interface LazyCallbackLeafProofs {
  hasUnstableSubtreeLifetime: (node: ts.JsxElement, boundary: ts.Node) => boolean;
  uniqueReturnedExpression: (owner: RuntimeFunctionLike) => ts.Expression | null;
}

export interface LazyCallbackLeaf {
  line: number;
  target: string;
}

interface LazyCallbackLeafRequest {
  localComponents: ReadonlySet<string>;
  proofs: LazyCallbackLeafProofs;
  sourceComponents: ReadonlySet<string>;
  state: StateCandidate;
  usage: StateUsage;
}

interface TransportedCallbackOpening {
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  target: string;
}

export function findLazyCallbackLeaf(
  state: StateCandidate,
  usage: StateUsage,
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>,
  proofs: LazyCallbackLeafProofs,
): LazyCallbackLeaf | null {
  return lazyCallbackLeaf({ localComponents, proofs, sourceComponents, state, usage });
}

function lazyCallbackLeaf(request: LazyCallbackLeafRequest): LazyCallbackLeaf | null {
  const transported = transportedCallbackOpening(request);
  if (!transported) {
    return null;
  }
  const callbackOwner = callbackWrappedElement(transported.opening, request.state.owner);
  if (!callbackOwner || !isIndependentRenderCut(callbackOwner, request)) {
    return null;
  }
  const { opening } = transported;
  return {
    line: opening.getSourceFile().getLineAndCharacterOfPosition(opening.getStart()).line + 1,
    target: transported.target,
  };
}

function transportedCallbackOpening(
  request: LazyCallbackLeafRequest,
): TransportedCallbackOpening | null {
  const { localComponents, sourceComponents, state, usage } = request;
  const [initializer] = state.call.arguments;
  const [valueSite] = [...usage.valueTransportSites];
  const [target] = [...usage.valueTargets];
  if (
    !isLazyInitializer(initializer) ||
    stateMayHoldCallable(state) ||
    valueSite === undefined ||
    !transportsExactlyOnce(usage) ||
    target === undefined ||
    (!localComponents.has(target) && !sourceComponents.has(target))
  ) {
    return null;
  }
  const opening = uniqueJsxOpeningAtSite(state.owner, valueSite);
  if (!opening || nearestRepeatedRenderCall(opening, state.owner)) {
    return null;
  }
  return { opening, target };
}

function isLazyInitializer(
  initializer: ts.Expression | undefined,
): initializer is ts.ArrowFunction | ts.FunctionExpression {
  return (
    initializer !== undefined &&
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
    initializer.parameters.length === 0 &&
    !initializer.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    !initializer.asteriskToken
  );
}

function transportsExactlyOnce(usage: StateUsage): boolean {
  return (
    usage.localRenderReads === 0 &&
    usage.transportedOccurrences === 1 &&
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1
  );
}

function uniqueJsxOpeningAtSite(
  owner: RuntimeFunctionLike,
  valueSite: number,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const { body } = owner;
  if (!body) {
    return null;
  }
  const openings: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  visit(body, (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.getStart() === valueSite
    ) {
      openings.push(node);
    }
  });
  return openings.length === 1 ? openings[0]! : null;
}

function callbackWrappedElement(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  owner: RuntimeFunctionLike,
): ts.JsxElement | null {
  const callback = nearestNestedFunction(opening, owner);
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !ts.isJsxExpression(callback.parent) ||
    callback.parent.expression !== callback ||
    !ts.isJsxElement(callback.parent.parent)
  ) {
    return null;
  }
  return callback.parent.parent;
}

function isIndependentRenderCut(
  callbackOwner: ts.JsxElement,
  request: LazyCallbackLeafRequest,
): boolean {
  const { localComponents, proofs, sourceComponents, state } = request;
  const returned = proofs.uniqueReturnedExpression(state.owner);
  return (
    returned !== null &&
    nodeWithin(callbackOwner, returned) &&
    !nearestRepeatedRenderCall(callbackOwner, state.owner) &&
    !proofs.hasUnstableSubtreeLifetime(callbackOwner, state.owner) &&
    hasIndependentRenderCutWitness(returned, [callbackOwner], localComponents, sourceComponents)
  );
}
