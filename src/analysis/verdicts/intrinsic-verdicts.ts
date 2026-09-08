import {
  setterCallsDiscardConfidence,
  stateOnlyReceivesItsInitialPrimitive,
  stateReadsOnlyCalculateOwnSetter,
} from "../discard-confidence.js";
import type { ClassifiedState } from "../model.js";
import type { StateClassificationContext } from "./classification-context.js";
import { asyncStatusBoundaryLabel } from "../ast-helpers.js";
import { controlledFilterLeafCut } from "../filter/filter-leaf-cut.js";
import { hasNoEffectReads } from "../state-usage.js";
import { isEvaluationInert } from "../../core/analysis-ast.js";
import { mutationRegionOnlyCallsStateSetters } from "../../rules/effect-drafts/draft-mutations.js";
import { nearestMutationFunction } from "../mutations.js";
import { stateMayHoldCallable } from "../../rules/state-proofs/state-proofs.js";

export function intrinsicStateVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { isPropertyLocalObjectDraft, state, usage } = context;
  if (state.setterName === null) {
    return {
      action: "keep-state",
      confidence: "certain",
      message: `Keep \`${state.valueName}\` as React state; it owns a stable component-lifetime value and has no setter.`,
    };
  }
  if (stateOnlyReceivesItsInitialPrimitive(state, usage)) {
    return {
      action: "review-state",
      abstentionReason: "no-proven-optimization",
      confidence: "certain",
      message: `Review \`${state.valueName}\` as dead-code cleanup only; every proven write repeats its primitive initializer, so React already bails out and no render or lifecycle improvement is established.`,
    };
  }
  if (isPropertyLocalObjectDraft) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace object draft \`${state.valueName}\` with one owner-scoped observable; clone its initial object once, write each controlled property directly, subscribe at each existing property leaf and pure aggregate leaf, and clone one non-tracking whole-draft snapshot at the start of submit or commit commands.`,
    };
  }
  return null;
}

export function controlledCutVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { childContracts, dialogPayloadCut, state, usage } = context;
  const filteredControlCut = controlledFilterLeafCut(state, usage, {
    childContracts,
    materiality: context.materiality,
  });
  if (filteredControlCut) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace filtered control state \`${state.valueName}\` with an owner-scoped observable and extract the \`${filteredControlCut.producer}\` render slot at line ${filteredControlCut.line} into one stable subscriber; move the exact filter and its repeated producer into that subscriber, pass their inputs as plain snapshots, preserve existing keys and conditional mounts, and keep the source-resolved \`${filteredControlCut.target}\` callback API unchanged.`,
    };
  }
  if (dialogPayloadCut) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: dialogPayloadCut.conditional
        ? `Replace nullable dialog payload \`${state.valueName}\` with a component-lifetime observable and replace the complete conditional ${dialogPayloadCut.consumerLabel} slot at line ${dialogPayloadCut.consumerLine} with one always-mounted stable leaf subscriber; evaluate the existing payload gate and call-free child projections there, use non-tracking snapshots in event commands, and preserve callbacks, write positions, and the dialog's conditional mount identity.`
        : `Replace nullable dialog payload \`${state.valueName}\` with a component-lifetime observable and wrap the complete always-mounted ${dialogPayloadCut.consumerLabel} call site at line ${dialogPayloadCut.consumerLine} in one stable leaf subscriber; subscribe there with \`useValue\`, use non-tracking snapshots in event commands, and preserve the existing open expression, callbacks, write positions, and mount identity.`,
    };
  }
  return null;
}

export function commandLifecycleVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { isDeferredReveal, isSelfRefreshingCommand, state } = context;
  if (isSelfRefreshingCommand) {
    return {
      action: "use-ref",
      confidence: "probable",
      message: `Replace self-refreshing command snapshot \`${state.valueName}\` with a ref; keep the memoized command, effects, listener registration and cleanup in place, compare and assign through \`.current\` at the same statement positions, and remove only this snapshot from the command dependency list.`,
    };
  }
  if (isDeferredReveal) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace the one-shot reveal flag \`${state.valueName}\` with a component-lifetime observable and subscribe only in its gated leaf; keep the existing deferred scheduler and exact cleanup, changing only the scheduled write to \`.set(true)\`.`,
    };
  }
  return null;
}

export function keyedSelectionVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { isKeyedLeafCollection, isKeyedLeafRecord, isKeyedLeafScalar, state } = context;
  if (isKeyedLeafCollection) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace keyed collection state \`${state.valueName}\` with a component-lifetime observable collection; extract the repeated row and subscribe there with an equivalent per-row \`useValue\` membership selector, preserve any proven filter inside the row and aggregate leaves, and read commands without subscribing.`,
    };
  }
  if (isKeyedLeafRecord) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace keyed record state \`${state.valueName}\` with a component-lifetime observable record; extract the stable-keyed row, subscribe there to only its dynamic entry with \`useValue(${state.valueName}$[rowKey])\`, and preserve every optimistic and rollback command position while replacing exact clone writes with child \`.set(...)\` and \`.delete()\` operations.`,
    };
  }
  if (isKeyedLeafScalar) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace scalar row-selection state \`${state.valueName}\` with a component-lifetime observable; extract a stable-keyed row component and subscribe with a per-item \`useValue(() => ${state.valueName}$.get() === rowDiscriminator)\` selector, while event commands read or update the cursor without subscribing.`,
    };
  }
  return null;
}

export function keyedCursorVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { hasCompanionWrites, hasReturnedKeyedCursorConsumer, isKeyedScalarWithSecondary, state } =
    context;
  if (isKeyedScalarWithSecondary) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace keyed selection state \`${state.valueName}\` with a component-lifetime observable; keep repeated row events command-only, subscribe per row where equality is rendered, move selected-item or non-null projections into one footer or detail leaf, and snapshot event commands without subscribing.`,
    };
  }
  if (hasReturnedKeyedCursorConsumer && !hasCompanionWrites) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace effect-owned custom-hook cursor \`${state.valueName}\` with a component-lifetime observable; keep every effect and cleanup, use non-tracking reads in registered commands, remove cursor-only dependencies and the list \`extraData\` broadcast, and subscribe with an equality selector only in the stable-keyed row.`,
    };
  }
  return null;
}

export function boundaryMoveVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { branchUnmountMove, localComponents, siblingRenderCut, sourceComponents, state, usage } =
    context;
  if (siblingRenderCut && usage.effectWrites === 0) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace \`${state.valueName}\` with a component-lifetime observable; keep the producer sibling command-only and subscribe only in the sibling ${siblingRenderCut.consumerLabel} boundary at line ${siblingRenderCut.consumerLine}, passing state-independent projection inputs as ordinary snapshots.`,
    };
  }
  if (
    branchUnmountMove &&
    (localComponents.has(branchUnmountMove.target) ||
      sourceComponents.has(branchUnmountMove.target))
  ) {
    return {
      action: "move-state-down",
      confidence: "probable",
      message: `Move React state \`${state.valueName}\` into \`${branchUnmountMove.target}\`; every read and interactive write belongs to that branch, and the owner resets it only when that branch unmounts.`,
    };
  }
  return null;
}

export function unusedStateVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { state, usage } = context;
  const unusedStateDeletionConfidence = setterCallsDiscardConfidence(usage.setterCallNodes);
  const onlyCalculatesOwnSetter = stateReadsOnlyCalculateOwnSetter(state, usage);
  if (
    usage.setterCalls > 0 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.escaped &&
    !usage.shadowed &&
    !stateMayHoldCallable(state) &&
    state.call.arguments.length <= 1 &&
    (state.call.arguments[0] === undefined || isEvaluationInert(state.call.arguments[0])) &&
    usage.localRenderReads === 0 &&
    hasNoEffectReads(usage) &&
    (usage.deferredReads === 0 || onlyCalculatesOwnSetter) &&
    usage.transportedOccurrences === 0 &&
    (unusedStateDeletionConfidence !== null || onlyCalculatesOwnSetter)
  ) {
    return {
      action: "delete-unused-state",
      confidence: unusedStateDeletionConfidence ?? "certain",
      message:
        unusedStateDeletionConfidence === "probable"
          ? `Delete React state \`${state.valueName}\`; replace each setter call with a \`void\` expression that evaluates the same argument at the same position, because the assigned value is never consumed but property evaluation must be preserved.`
          : `Delete React state \`${state.valueName}\` and its setter calls; assigned values are never consumed.`,
    };
  }
  return null;
}

export function lazyCallbackLeafVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { hasCompanionWrites, hasReactiveMutationPath, hasSafeCommands, state, usage } = context;
  const { callbackLeaf } = context.renderCut;
  if (
    callbackLeaf &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    !hasCompanionWrites &&
    !hasReactiveMutationPath &&
    hasSafeCommands &&
    state.setterName !== null &&
    usage.setterCallNodes.some((call) =>
      mutationRegionOnlyCallsStateSetters(
        nearestMutationFunction(call, state.owner),
        new Set([state.setterName!]),
      ),
    ) &&
    usage.setterReferences > 0 &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped
  ) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace lazy-initialized state \`${state.valueName}\` with one owner-lifetime observable created exactly once from the existing initializer (do not turn the initializer into a computed); keep the current render-callback placement and setter timing, and subscribe only in the nested \`${callbackLeaf.target}\` leaf at line ${callbackLeaf.line}.`,
    };
  }
  return null;
}

export function asyncStatusVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { isAsyncLeafStatus, state, usage } = context;
  if (isAsyncLeafStatus) {
    const [target] = [...usage.valueTargets];
    const callSiteCount = usage.valueTransportSites.size;
    const boundary = asyncStatusBoundaryLabel(callSiteCount, target);
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace async pending flag \`${state.valueName}\` with a component-lifetime observable and wrap ${boundary} in ${callSiteCount > 1 ? "separate leaf subscribers" : "a leaf subscriber"}; preserve the event command's async completion boundary exactly, changing only the true/false writes so pending transitions do not invalidate independent owner content.`,
    };
  }
  return null;
}

export function pairedAsyncStatusVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { isCohesiveAsyncStatus, isUnprovenAsyncStatus, state } = context;
  if (isCohesiveAsyncStatus) {
    return {
      action: "keep-state",
      confidence: "certain",
      message: `Keep async pending flag \`${state.valueName}\` as React state; its exact status consumer is already the cohesive owner boundary, so an observable cannot narrow rendering.`,
    };
  }
  if (isUnprovenAsyncStatus) {
    return {
      action: "review-state",
      abstentionReason: "async-command-origin-unresolved",
      confidence: "probable",
      message: `Review \`${state.valueName}\`; its async pending interval and leaf boundary are proven, but source does not prove that every command runs from a deferred event. Do not publish these writes through an observable until the callback contract resolves.`,
    };
  }
  return null;
}
