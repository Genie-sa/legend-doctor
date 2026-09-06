import type { StateSubtree, StateUsage } from "../model.js";
import { ancestorCallInSet, isCustomJsxTarget, jsxTargetName } from "../ast-helpers.js";
import { findAncestorUntil, nearestNestedFunction } from "../../core/ast.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { nearestMutationFunction } from "../mutations.js";
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

interface EventHandlerAttributeTarget {
  readonly prop: string;
  readonly target: string;
}

function eventHandlerAttributeTarget(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): EventHandlerAttributeTarget | null {
  const callback = nearestMutationFunction(call, owner);
  const attribute =
    callback === owner ? null : findAncestorUntil(callback, ts.isJsxAttribute, owner);
  const prop = attribute?.name.getText() ?? null;
  const target = attribute ? jsxTargetName(attribute) : null;
  if (!prop || !target || !/^on[A-Z]/u.test(prop)) {
    return null;
  }
  return { prop, target };
}

function setterWriteIsDeferred(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
  { childContracts, directEffectCalls }: DeferredProjectionScope,
): boolean {
  if (ancestorCallInSet(call, directEffectCalls, owner)) {
    return true;
  }
  const handler = eventHandlerAttributeTarget(call, owner);
  if (!handler) {
    return false;
  }
  if (!isCustomJsxTarget(handler.target)) {
    return true;
  }
  return (
    childContracts?.frameworkEventComponent(handler.target) === true ||
    childContracts?.componentCallbackPropIsDeferred(handler.target, handler.prop) === true
  );
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

function outermostTransparentExpression(expression: ts.Expression): ts.Expression {
  let outermost = expression;
  while (
    (ts.isParenthesizedExpression(outermost.parent) ||
      ts.isAsExpression(outermost.parent) ||
      ts.isTypeAssertionExpression(outermost.parent) ||
      ts.isSatisfiesExpression(outermost.parent) ||
      ts.isNonNullExpression(outermost.parent)) &&
    outermost.parent.expression === outermost
  ) {
    outermost = outermost.parent;
  }
  return outermost;
}

export function sharesJsxChildRenderCallback(
  nodes: readonly ts.Node[],
  owner: RuntimeFunctionLike,
): boolean {
  const common = sharedNestedCallback(nodes, owner);
  if (!common) {
    return false;
  }
  const container = outermostTransparentExpression(common).parent;
  return (
    ts.isJsxExpression(container) &&
    (ts.isJsxElement(container.parent) || ts.isJsxFragment(container.parent))
  );
}
