import type { ClassifiedState, StateCandidate, StateUsage } from "../model.js";
import {
  callSiteIsKeyed,
  directUniqueReturnCallSite,
  stableOwnerLevelCallSite,
} from "../return-call-sites.js";
import { competingSubscriptionsNote, isCustomHookOwner } from "../ast-helpers.js";
import { isStructuralLegendCandidate, legendCandidateMessage } from "../finding-format.js";
import {
  setterCallsAssignBooleanLiterals,
  stateHasNoEffectOrDeferredUse,
  stateWritesAreUntracked,
} from "./transport-verdicts.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import type { ForwardedSetterProp } from "./setter-forwarding.js";
import { SMALL_OWNER_JSX_ELEMENTS } from "../constants.js";
import type { StateClassificationContext } from "./classification-context.js";
import { forwardedSetterProp } from "./setter-forwarding.js";
import { isCohesiveDelayedPendingState } from "../delayed-pending.js";
import { jsxElementCount } from "../../rules/state-proofs/jsx-subtrees.js";
import { setterOwnedByValueTransitionCallSite } from "../controlled-leaf-cuts.js";
import { stateMayHoldCallable } from "../../rules/state-proofs/state-proofs.js";

type AbstentionReason = Extract<ClassifiedState, { action: "review-state" }>["abstentionReason"];

function mutationAbstentionReason(context: StateClassificationContext): AbstentionReason | null {
  const { hasCompanionWrites, hasDetachedEffectWrites, hasReactiveMutationPath, usage } = context;
  if (hasCompanionWrites) {
    return "atomic-transition-unproven";
  }
  if (hasReactiveMutationPath) {
    return "ownership-flow-unresolved";
  }
  if (usage.effectWrites > 0 && !hasDetachedEffectWrites) {
    return "effect-write-ownership-unresolved";
  }
  return null;
}

function flowAbstentionReason(context: StateClassificationContext): AbstentionReason | null {
  const { hasSafeCommands, usage } = context;
  if (usage.shadowed || usage.escaped) {
    return "ownership-flow-unresolved";
  }
  if (usage.deferredReads > 0 && !hasSafeCommands) {
    return "callback-timing-unresolved";
  }
  return null;
}

function ownershipAbstentionReason(context: StateClassificationContext): AbstentionReason | null {
  return mutationAbstentionReason(context) ?? flowAbstentionReason(context);
}

function renderAbstentionReason(context: StateClassificationContext): AbstentionReason {
  const { state, subtree, usage } = context;
  if (stateMayHoldCallable(state)) {
    return "state-type-unresolved";
  }
  if (usage.unstableTransport || subtree?.unstable) {
    return "mount-identity-unproven";
  }
  if (usage.transportedOccurrences > 0 || usage.jsxTargets.size > 0) {
    return "child-contract-unresolved";
  }
  if (usage.localRenderReads > 0) {
    return "render-cut-unproven";
  }
  return "no-proven-optimization";
}

function residualAbstentionReason(context: StateClassificationContext): AbstentionReason {
  return ownershipAbstentionReason(context) ?? renderAbstentionReason(context);
}

export function delayedPendingVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { ownerObservableSubscriptions, state, usage } = context;
  if (isCohesiveDelayedPendingState(state, usage)) {
    return {
      action: "keep-state",
      confidence: "certain",
      message: `Keep \`${state.valueName}\` as React state; its cohesive button owner intentionally delays the pending transition and clears that timer before the final reset.`,
    };
  }
  if (usage.localRenderReads > 0) {
    if (
      isCustomHookOwner(state.owner) ||
      jsxElementCount(state.owner) >= SMALL_OWNER_JSX_ELEMENTS
    ) {
      const boundary = isCustomHookOwner(state.owner)
        ? "its unknown hook consumers"
        : `this owner with ${jsxElementCount(state.owner)} JSX elements`;
      const competing = competingSubscriptionsNote(ownerObservableSubscriptions);
      return {
        action: "review-state",
        abstentionReason: residualAbstentionReason(context),
        confidence: "probable",
        message: `Legend-first restructuring candidate: replace \`${state.valueName}\` with observable ownership and move its subscription into the smallest rendered subtree; updates currently invalidate ${boundary}.${competing}`,
      };
    }
    return {
      action: "keep-state",
      confidence: "certain",
      message: `Keep \`${state.valueName}\` as React state for now; its owner is already a small render boundary.`,
    };
  }
  return null;
}

export function renderReadVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { sourceComponents, state, usage } = context;
  if (
    usage.repeatedTransport &&
    usage.deferredReads === 0 &&
    usage.setterCalls === 0 &&
    !stateMayHoldCallable(state)
  ) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace \`${state.valueName}\` with \`useObservable\` and subscribe in the transported leaves so updates do not invalidate this owner.`,
    };
  }
  if (usage.jsxTargets.size > 1) {
    return {
      action: "review-state",
      abstentionReason: residualAbstentionReason(context),
      confidence: "probable",
      message: isStructuralLegendCandidate(state, usage, context)
        ? legendCandidateMessage(state, usage, sourceComponents)
        : `Review React state \`${state.valueName}\`; it fans out to multiple leaves, but local evidence does not prove that observable transport beats a smaller React boundary.`,
    };
  }
  return null;
}

export function singleTargetTransportVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { hasCompanionWrites, materiality, state, usage } = context;
  if (
    !isCustomHookOwner(state.owner) &&
    jsxElementCount(state.owner) >= materiality.broadOwnerJsx &&
    !stateMayHoldCallable(state) &&
    usage.transportedOccurrences > 0 &&
    usage.jsxTargets.size === 1 &&
    usage.effectReads === 0 &&
    usage.deferredReads === 0 &&
    usage.valueTargets.size === 1 &&
    usage.valueTransportSites.size === 1 &&
    setterOwnedByValueTransitionCallSite(state, usage) &&
    directUniqueReturnCallSite(usage, state.owner) !== null &&
    !hasCompanionWrites &&
    usage.effectWrites === 0 &&
    !usage.unstableTransport &&
    !usage.shadowed &&
    !usage.escaped
  ) {
    const [target] = usage.jsxTargets;
    return {
      action: "move-state-down",
      confidence: "probable",
      message: `Extract one stable local wrapper around \`${target ?? "the receiving child"}\` and move \`${state.valueName}\` into it; this broad owner only transports the value and setter to that leaf.`,
    };
  }
  return null;
}

interface VerifiedLeafRenderProp {
  readonly propName: string;
  readonly target: string;
}

function verifiedLeafRenderProp(
  usage: StateUsage,
  childContracts: ChildContractResolver,
): VerifiedLeafRenderProp | null {
  const [target] = [...usage.jsxTargets];
  if (target === undefined) {
    return null;
  }
  const propNames = usage.valueProps.get(target);
  const [propName] = propNames?.size === 1 ? [...propNames] : [];
  if (
    propName === undefined ||
    !childContracts.componentPropIsLeafRenderConsumer(target, propName)
  ) {
    return null;
  }
  return { propName, target };
}

export function broadTransportVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { childContracts, hasReactiveMutationPath, hasSafeCommands, state, usage } = context;
  const ownerCallSite = stableOwnerLevelCallSite(usage, state.owner);
  if (!childContracts || usage.jsxTargets.size !== 1 || ownerCallSite === null) {
    return null;
  }
  const forwardedSetter =
    usage.setterReferences === usage.setterCalls
      ? null
      : forwardedSetterProp(state, usage, childContracts);
  if (
    usage.localRenderReads === 0 &&
    hasSafeCommands &&
    !hasReactiveMutationPath &&
    stateHasNoEffectOrDeferredUse(usage, context.hasDetachedEffectWrites) &&
    (usage.setterCalls >= 1 || forwardedSetter !== null) &&
    (usage.setterReferences === usage.setterCalls || forwardedSetter !== null) &&
    !usage.repeatedTransport &&
    stateWritesAreUntracked(usage) &&
    !stateMayHoldCallable(state) &&
    !callSiteIsKeyed(ownerCallSite) &&
    setterCallsAssignBooleanLiterals(usage)
  ) {
    const leafProp = verifiedLeafRenderProp(usage, childContracts);
    if (leafProp) {
      return {
        action: "use-observable",
        confidence: "probable",
        message: leafTransportMessage(state, leafProp, forwardedSetter),
      };
    }
  }
  return null;
}

function leafTransportMessage(
  state: StateCandidate,
  leafProp: VerifiedLeafRenderProp,
  forwardedSetter: ForwardedSetterProp | null,
): string {
  const forwarding = forwardedSetter
    ? ` Forward the setter through the wrapper as \`${forwardedSetter.propName}={(next) => ${state.valueName}$.set(next)}\`; the child only calls it after render.`
    : "";
  return `Replace \`${state.valueName}\` with a component-lifetime observable and wrap the stable \`${leafProp.target}\` call site in a leaf subscriber; subscribe once with \`useValue\`, pass the same plain value, and leave the child API unchanged.${forwarding} The child contract is verified: \`${leafProp.target}\` renders the \`${leafProp.propName}\` value directly and owns none of its lifecycle.`;
}

export function residualStateVerdict(context: StateClassificationContext): ClassifiedState {
  const { sourceComponents, state, usage } = context;
  return {
    action: "review-state",
    abstentionReason: residualAbstentionReason(context),
    confidence: "probable",
    message:
      isStructuralLegendCandidate(state, usage, context) ||
      [...usage.jsxTargets].some((target) => sourceComponents.has(target))
        ? legendCandidateMessage(state, usage, sourceComponents)
        : `Review React state \`${state.valueName}\`; local evidence does not prove a render-boundary improvement.`,
  };
}
