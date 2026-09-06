import {
  cohesiveControlledLeafOwner,
  stateReferencesConfinedTo,
} from "../controlled-leaf-call-site.js";
import {
  controlledLeafProjectionCut,
  controlledLeafRenderCut,
  controlledSameCallSiteProjectionCut,
} from "../controlled-leaf-cuts.js";
import {
  hasOnlyEventCommandReads,
  stateMayHoldCallable,
} from "../../rules/state-proofs/state-proofs.js";
import type { ClassifiedState } from "../model.js";
import { EMPTY_NODES } from "../constants.js";
import type { StateClassificationContext } from "./classification-context.js";
import { controlledStateReadsAreEventOnly } from "./transport-verdicts.js";
import { isCustomHookOwner } from "../ast-helpers.js";
import { isExactControlledArrayMembershipToggle } from "../membership-toggle.js";
import ts from "typescript";

export function controlledLeafVerdict(context: StateClassificationContext): ClassifiedState | null {
  const {
    eventTransitionCallbacks,
    hasCompanionWrites,
    hasIndependentDirectEventWrite,
    hasSafeCommands,
    localComponents,
    sourceComponents,
    state,
    usage,
  } = context;
  const controlledLeafCut =
    !isCustomHookOwner(state.owner) &&
    !stateMayHoldCallable(state) &&
    controlledStateReadsAreEventOnly(usage) &&
    (!usage.setterUsesPreviousValue || isExactControlledArrayMembershipToggle(state, usage)) &&
    !usage.shadowed &&
    !usage.escaped &&
    (!hasCompanionWrites || hasIndependentDirectEventWrite) &&
    hasSafeCommands &&
    hasOnlyEventCommandReads(state, EMPTY_NODES, eventTransitionCallbacks) &&
    controlledLeafRenderCut(state, usage, { localComponents, sourceComponents });
  if (controlledLeafCut) {
    const target = [...usage.valueTargets][0] ?? "the controlled child";
    const controlledSubtree: ts.Node = ts.isJsxOpeningElement(controlledLeafCut.opening)
      ? controlledLeafCut.opening.parent
      : controlledLeafCut.opening;
    if (stateReferencesConfinedTo(state, controlledSubtree)) {
      return {
        action: "move-state-down",
        confidence: "probable",
        message: `Extract one stable local wrapper around \`${target}\` and move React state \`${state.valueName}\` into it; every value read and command is confined to that controlled leaf.`,
      };
    }
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace controlled state \`${state.valueName}\` with an owner-scoped observable and wrap \`${target}\` in a stable leaf subscriber; keep its value callback API unchanged and use non-tracking reads in submit or commit commands, snapshotting once at command entry before deferred work.`,
    };
  }
  return null;
}

export function cohesiveControlledLeafVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { state, usage } = context;
  const cohesiveControlledLeaf = cohesiveControlledLeafOwner(state, usage);
  if (cohesiveControlledLeaf) {
    return {
      action: "keep-state",
      confidence: "certain",
      message: `Keep controlled state \`${state.valueName}\` in React; its value and setter are already confined to the cohesive \`${cohesiveControlledLeaf}\` leaf owner, so another observable subscriber would not narrow rendering.`,
    };
  }
  return null;
}

export function controlledCallSiteProjectionVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const {
    eventTransitionCallbacks,
    hasCompanionWrites,
    hasIndependentDirectEventWrite,
    hasSafeCommands,
    localComponents,
    sourceComponents,
    state,
    usage,
  } = context;
  const controlledCallSiteProjection =
    !isCustomHookOwner(state.owner) &&
    !stateMayHoldCallable(state) &&
    usage.localRenderReads > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences > 0 &&
    !usage.repeatedTransport &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped &&
    (!hasCompanionWrites || hasIndependentDirectEventWrite) &&
    hasSafeCommands &&
    hasOnlyEventCommandReads(state, new Set(usage.directRenderNodes), eventTransitionCallbacks)
      ? controlledSameCallSiteProjectionCut(state, usage, { localComponents, sourceComponents })
      : null;
  if (controlledCallSiteProjection) {
    const target = [...usage.valueTargets][0] ?? "the controlled child";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace controlled state \`${state.valueName}\` with an owner-scoped observable and wrap \`${target}\` in one stable leaf subscriber; derive every state-dependent prop inside that wrapper, keep the callback API unchanged, and preserve the owner's state lifetime.`,
    };
  }
  return null;
}

export function controlledProjectionCutVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const {
    eventTransitionCallbacks,
    hasCompanionWrites,
    hasIndependentDirectEventWrite,
    hasSafeCommands,
    localComponents,
    sourceComponents,
    state,
    usage,
  } = context;
  const controlledProjectionCut =
    !isCustomHookOwner(state.owner) &&
    !stateMayHoldCallable(state) &&
    usage.localRenderReads > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.transportedOccurrences > 0 &&
    !usage.repeatedTransport &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped &&
    (!hasCompanionWrites || hasIndependentDirectEventWrite) &&
    hasSafeCommands &&
    hasOnlyEventCommandReads(state, new Set(usage.directRenderNodes), eventTransitionCallbacks)
      ? controlledLeafProjectionCut(state, usage, { localComponents, sourceComponents })
      : null;
  if (controlledProjectionCut) {
    const target = [...usage.valueTargets][0] ?? "the controlled child";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace controlled state \`${state.valueName}\` with an owner-scoped observable; wrap \`${target}\` and the sibling ${controlledProjectionCut.consumerLabel} projection at line ${controlledProjectionCut.consumerLine} in stable leaf subscribers, derive validation from the subscribed value, keep the input callback API unchanged, and use non-tracking reads in event commands.`,
    };
  }
  return null;
}
