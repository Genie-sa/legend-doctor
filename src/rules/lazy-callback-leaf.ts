import ts from "typescript";

import { nearestNestedFunction, nodeWithin, visit } from "../ast.js";
import type { RuntimeFunctionLike } from "../ast.js";
import type { StateCandidate, StateUsage } from "../analyze-source.js";
import {
  hasIndependentRenderCutWitness,
  nearestRepeatedRenderCall,
  stateMayHoldCallable,
} from "./state-proofs.js";

export interface LazyCallbackLeafProofs {
  hasUnstableSubtreeLifetime(node: ts.JsxElement, boundary: ts.Node): boolean;
  uniqueReturnedExpression(owner: RuntimeFunctionLike): ts.Expression | null;
}

export interface LazyCallbackLeaf {
  line: number;
  target: string;
}

export function findLazyCallbackLeaf(
  state: StateCandidate,
  usage: StateUsage,
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>,
  proofs: LazyCallbackLeafProofs,
): LazyCallbackLeaf | null {
  const initializer = state.call.arguments[0],
    valueSite = [...usage.valueTransportSites][0],
    target = [...usage.valueTargets][0];
  if (
    !initializer ||
    (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) ||
    initializer.parameters.length > 0 ||
    initializer.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    initializer.asteriskToken ||
    stateMayHoldCallable(state) ||
    !state.owner.body ||
    valueSite === undefined ||
    usage.localRenderReads !== 0 ||
    usage.transportedOccurrences !== 1 ||
    usage.valueTransportSites.size !== 1 ||
    usage.valueTargets.size !== 1 ||
    !target ||
    (!localComponents.has(target) && !sourceComponents.has(target))
  ) {
    return null;
  }

  const openings: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  visit(state.owner.body, (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.getStart() === valueSite
    ) {
      openings.push(node);
    }
  });
  const opening = openings.length === 1 ? openings[0]! : null;
  if (!opening || nearestRepeatedRenderCall(opening, state.owner)) {
    return null;
  }

  const callback = nearestNestedFunction(opening, state.owner);
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !ts.isJsxExpression(callback.parent) ||
    callback.parent.expression !== callback ||
    !ts.isJsxElement(callback.parent.parent)
  ) {
    return null;
  }
  const callbackOwner = callback.parent.parent,
    returned = proofs.uniqueReturnedExpression(state.owner);
  if (
    !returned ||
    !nodeWithin(callbackOwner, returned) ||
    nearestRepeatedRenderCall(callbackOwner, state.owner) ||
    proofs.hasUnstableSubtreeLifetime(callbackOwner, state.owner) ||
    !hasIndependentRenderCutWitness(returned, [callbackOwner], localComponents, sourceComponents)
  ) {
    return null;
  }
  return {
    line: opening.getSourceFile().getLineAndCharacterOfPosition(opening.getStart()).line + 1,
    target,
  };
}
