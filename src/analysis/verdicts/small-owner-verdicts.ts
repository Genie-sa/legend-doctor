import type {
  ChildContractResolver,
  HookPresentationConsumer,
} from "../../rules/child-contract/model.js";
import type { ClassifiedState, StateCandidate, StateUsage } from "../model.js";
import {
  hookReturnMembers,
  hookStateValueIsOnlyReturned,
} from "../../rules/hook-consumer-contract/hook-consumer-contract.js";
import { isCustomHookOwner, runtimeFunctionName } from "../ast-helpers.js";
import type { MaterialityPolicy } from "../constants.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { SMALL_OWNER_JSX_ELEMENTS } from "../constants.js";
import type { StateClassificationContext } from "./classification-context.js";
import { jsxElementCount } from "../../rules/state-proofs/jsx-subtrees.js";
import { nearestNestedFunction } from "../../core/ast.js";
import { stateMayHoldCallable } from "../../rules/state-proofs/state-proofs.js";
import ts from "typescript";

/**
 * Effect-written state whose every read renders a component that is already a leaf boundary cannot
 * save a render by migrating; the effect that writes it stays in React lifecycle either way.
 */
export function smallOwnerEffectWrittenVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { state, usage } = context;
  if (!isSmallOwnerEffectWrittenState(state, usage)) {
    return null;
  }
  return {
    action: "keep-state",
    confidence: "certain",
    message: `Keep \`${state.valueName}\` as React state; its owner is already a small render boundary, so moving the effect that writes it to an observable cannot remove a render.`,
  };
}

function isSmallOwnerEffectWrittenState(state: StateCandidate, usage: StateUsage): boolean {
  return (
    usage.effectWrites > 0 &&
    !usage.escaped &&
    !usage.shadowed &&
    usage.localRenderReads > 0 &&
    usage.transportedOccurrences === 0 &&
    usage.jsxTargets.size === 0 &&
    usage.setterTargets.size === 0 &&
    isSmallComponentOwner(state.owner) &&
    usage.directRenderNodes.every((node) => isOwnerRenderPosition(node, state))
  );
}

/**
 * A custom hook's state whose only project consumer is a leaf-sized component that keeps the value
 * and setter inside its own render cannot save a render by migrating, whatever the hook does with it.
 */
export function hookConsumerLeafVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { childContracts, state, usage } = context;
  const hookName = runtimeFunctionName(state.owner);
  if (
    !childContracts ||
    hookName === null ||
    !isCustomHookOwner(state.owner) ||
    usage.shadowed ||
    usage.transportedOccurrences > 0 ||
    usage.jsxTargets.size > 0
  ) {
    return null;
  }
  const members = hookReturnMembers(state);
  if (!members || !childContracts.hookStateHasSingleLeafConsumer(hookName, members)) {
    return null;
  }
  return {
    action: "keep-state",
    confidence: "certain",
    message: `Keep \`${state.valueName}\` as React state; the only component that consumes \`${hookName}\` is already a small render boundary and keeps the value inside its own render, so observable ownership could not narrow rendering.`,
  };
}

interface HookPresentationStateScope {
  readonly childContracts: ChildContractResolver | null;
  readonly materiality: MaterialityPolicy;
  readonly ownerIsCommitSensitive: boolean;
  readonly state: StateCandidate;
  readonly usage: StateUsage;
}

export function hookPresentationConsumerForState({
  childContracts,
  materiality,
  ownerIsCommitSensitive,
  state,
  usage,
}: HookPresentationStateScope): HookPresentationConsumer | null {
  const hookName = runtimeFunctionName(state.owner);
  if (
    !childContracts ||
    hookName === null ||
    !isCustomHookOwner(state.owner) ||
    state.setterName === null ||
    usage.setterCalls === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.setterCallNodes.some((call) => nearestNestedFunction(call, state.owner) === null) ||
    usage.escaped ||
    usage.shadowed ||
    ownerIsCommitSensitive ||
    stateMayHoldCallable(state) ||
    !hookStateValueIsOnlyReturned(state)
  ) {
    return null;
  }
  const members = hookReturnMembers(state);
  return members?.setter === null
    ? childContracts.hookStatePresentationConsumer(hookName, members, materiality.broadOwnerJsx)
    : null;
}

/**
 * A hook may retain mutation and lifecycle ownership while publishing an observable handle. The
 * component consumers then subscribe only at their proven presentation sites.
 */
export function hookPresentationConsumerVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  if (context.hasCompanionWrites) {
    return null;
  }
  const consumer = hookPresentationConsumerForState(context);
  if (!consumer) {
    return null;
  }
  const hookName = runtimeFunctionName(context.state.owner)!;
  const derived =
    consumer.derivedBindings.length > 0
      ? ` Recompute ${consumer.derivedBindings.map((name) => `\`${name}\``).join(", ")} inside the subscribing site.`
      : "";
  const consumerNames = consumer.consumerNames.map((name) => `\`${name}\``).join(", ");
  return {
    action: "use-observable",
    confidence: "probable",
    message: `Replace \`${context.state.valueName}\` with a hook-lifetime observable and publish the observable from \`${hookName}\` instead of its plain snapshot. Keep every write at the same hook position, then subscribe at the ${consumer.renderSites} stable render ${consumer.renderSites === 1 ? "site" : "sites"} ${consumer.consumerNames.length === 1 ? `inside ${consumerNames}` : `across ${consumerNames}`}; pass the same plain values into existing children.${derived} ${consumer.consumerNames.length === 1 ? `${consumerNames} no longer renders` : "Those consumers no longer render"} when \`${context.state.valueName}\` changes.`,
  };
}

function isSmallComponentOwner(owner: RuntimeFunctionLike): boolean {
  const elements = jsxElementCount(owner);
  if (elements >= SMALL_OWNER_JSX_ELEMENTS || isCustomHookOwner(owner)) {
    return false;
  }
  return runtimeFunctionName(owner) !== null || elements > 0;
}

function isOwnerRenderPosition(node: ts.Node, state: StateCandidate): boolean {
  if (nearestNestedFunction(node, state.owner) !== null) {
    return false;
  }
  for (let current = node.parent; current && current !== state.owner; current = current.parent) {
    if (
      ts.isReturnStatement(current) ||
      ts.isIfStatement(current) ||
      ts.isJsxAttribute(current) ||
      ts.isJsxExpression(current)
    ) {
      return true;
    }
    if (ts.isVariableDeclaration(current)) {
      return false;
    }
  }
  return false;
}
