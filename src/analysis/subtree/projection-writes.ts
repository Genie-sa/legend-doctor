import type { StateSubtree, StateUsage } from "../model.js";
import { findAncestorUntil, nearestNestedFunction } from "../../core/ast.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { ancestorCallInSet } from "../ast-helpers.js";
import { jsxEventAttributeIsDeferred } from "../callbacks/deferred-events.js";
import { nearestMutationFunction } from "../mutations.js";
import { outermostTransparentParent } from "../../core/analysis-ast.js";
import ts from "typescript";

export function projectionSubtreeKind(
  effectOwnedMemoizedCommand: boolean,
  effectWrittenPresentation: boolean,
  isGateProjection: boolean,
): StateSubtree["kind"] {
  if (effectOwnedMemoizedCommand) {
    return "effect-command-projection";
  }
  if (effectWrittenPresentation) {
    return "effect-projection";
  }
  return isGateProjection ? "gate" : "projection";
}

interface DeferredProjectionScope {
  readonly childContracts: ChildContractResolver | null;
  readonly directEffectCalls: ReadonlySet<ts.CallExpression>;
}

export function projectionWritesAreDeferred(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
  { childContracts, directEffectCalls }: DeferredProjectionScope,
): boolean {
  return usage.setterCallNodes.every((call) =>
    setterWriteIsDeferred(call, owner, { childContracts, directEffectCalls }),
  );
}

function setterWriteIsDeferred(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
  { childContracts, directEffectCalls }: DeferredProjectionScope,
): boolean {
  if (ancestorCallInSet(call, directEffectCalls, owner)) {
    return true;
  }
  const callback = nearestMutationFunction(call, owner);
  const attribute =
    callback === owner ? null : findAncestorUntil(callback, ts.isJsxAttribute, owner);
  return attribute !== null && jsxEventAttributeIsDeferred(attribute, childContracts);
}

function sharedNestedCallback(
  nodes: readonly ts.Node[],
  owner: RuntimeFunctionLike,
): ts.ArrowFunction | ts.FunctionExpression | null {
  let common: ts.ArrowFunction | ts.FunctionExpression | null = null;
  for (const node of nodes) {
    const callback = nearestNestedFunction(node, owner);
    if (
      !callback ||
      (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
      (common !== null && common !== callback)
    ) {
      return null;
    }
    common = callback;
  }
  return common;
}

export function sharesJsxChildRenderCallback(
  nodes: readonly ts.Node[],
  owner: RuntimeFunctionLike,
): boolean {
  const common = sharedNestedCallback(nodes, owner);
  if (!common) {
    return false;
  }
  const container = outermostTransparentParent(common).parent;
  return (
    ts.isJsxExpression(container) &&
    (ts.isJsxElement(container.parent) || ts.isJsxFragment(container.parent))
  );
}
