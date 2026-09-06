import type { ClassifiedState, StateCandidate, StateUsage } from "../model.js";
import { DEFAULT_PRESENTATION_LEAF_COUNT, WIDE_OWNER_LINE_SPAN } from "../constants.js";
import { isCustomHookOwner, ownerLineSpan } from "../ast-helpers.js";
import { isStructuralLegendCandidate, legendCandidateMessage } from "../finding-format.js";
import type { StateClassificationContext } from "./classification-context.js";
import { hasNoEffectReads } from "../state-usage.js";
import { jsxElementCount } from "../../rules/state-proofs/jsx-subtrees.js";
import { repeatedSubscriptionSuffix } from "../subtree/materiality.js";
import { stateFeedsReturnedSwitchCommand } from "../../rules/command-only-state/returned-switch-command.js";
import { stateMayHoldCallable } from "../../rules/state-proofs/state-proofs.js";
import { statePublishesReadOnlyGetter } from "../../rules/command-only-state/published-getter.js";
import { stateReadCallbackEscapesThroughUnknownHook } from "../../rules/command-only-state/unknown-hook-escape.js";

export function refCommandSnapshotVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { state, usage } = context;
  if (
    isCustomHookOwner(state.owner) &&
    usage.localRenderReads === 0 &&
    hasNoEffectReads(usage) &&
    usage.deferredReads === 1 &&
    usage.transportedOccurrences === 0 &&
    usage.jsxTargets.size === 0 &&
    usage.effectWrites > 0 &&
    usage.setterCalls === usage.effectWrites &&
    usage.setterReferences === usage.effectWrites &&
    !usage.shadowed &&
    !usage.escaped &&
    stateFeedsReturnedSwitchCommand(state)
  ) {
    return {
      action: "use-ref",
      confidence: "probable",
      message: `Replace effect-written command cursor \`${state.valueName}\` with a ref; preserve the effect and update its current value at the same statement positions, then read it only as the returned navigation switch discriminant.`,
    };
  }
  return null;
}

export function functionalSnapshotVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { childContracts, deferredCallbackHooks, state, usage } = context;
  const {
    hasCommandSnapshotHazard,
    hasEventCommandReadProof,
    hasFunctionalSnapshotHazard,
    preservesFunctionalSnapshot,
  } = context.commandSnapshot;
  if (
    usage.localRenderReads === 0 &&
    hasNoEffectReads(usage) &&
    usage.deferredReads > 0 &&
    usage.transportedOccurrences === 0 &&
    usage.jsxTargets.size === 0 &&
    (!hasFunctionalSnapshotHazard || preservesFunctionalSnapshot) &&
    (!hasCommandSnapshotHazard || preservesFunctionalSnapshot) &&
    !stateReadCallbackEscapesThroughUnknownHook(
      state,
      deferredCallbackHooks,
      childContracts
        ? (hookName, argumentIndex, property) =>
            childContracts.callbackPropertyIsDeferred(hookName, argumentIndex, property)
        : undefined,
    ) &&
    !statePublishesReadOnlyGetter(state) &&
    !usage.shadowed &&
    !usage.escaped &&
    ((usage.eventReads === 0 && usage.effectWrites === 0) || hasEventCommandReadProof)
  ) {
    return {
      action: "use-ref",
      confidence: "probable",
      message: preservesFunctionalSnapshot
        ? `Replace \`${state.valueName}\` with a ref; inside the source-proven deferred callback, capture the ref's pre-update snapshot, evaluate the counter updater from that snapshot, and keep every later read on the captured value so the command preserves React's current ordering without rerendering.`
        : `Replace \`${state.valueName}\` with a ref; preserve any existing React lifecycle hook timing and statement order, write \`.current\` at the same setter positions${usage.setterUsesPreviousValue ? ", evaluate functional updaters against the current handle value" : ""}, read \`.current\` inside deferred commands, and remove only this value from their dependency arrays.`,
    };
  }
  return null;
}

export function effectProjectionSubtreeVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { hasCompanionWrites, state, subtree } = context;
  const effectCommandProjectionSubtree =
    subtree?.kind === "effect-command-projection" ? subtree : null;
  if (effectCommandProjectionSubtree && !hasCompanionWrites) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace presentation state \`${state.valueName}\` with an owner-scoped observable, preserve the memoized command, React effect and cleanup, dependencies, and statement order, and wrap the full ${effectCommandProjectionSubtree.label} render boundary at line ${effectCommandProjectionSubtree.line} in an always-mounted leaf subscriber.`,
    };
  }
  return null;
}

export function splitEffectProjectionVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { hasCompanionWrites, state, subtree } = context;
  const splitEffectProjectionSubtree = subtree?.kind === "effect-split-projection" ? subtree : null;
  if (splitEffectProjectionSubtree && !hasCompanionWrites) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace effect-written scalar \`${state.valueName}\` with an owner-scoped observable; preserve the React effect, cleanup, dependencies, calculations, and write order, then subscribe only in its ${splitEffectProjectionSubtree.leafCount ?? DEFAULT_PRESENTATION_LEAF_COUNT} bounded presentation leaves. Keep keyed repeated rows keyed and calculate each existing projection once inside its containing subscriber.`,
    };
  }
  return null;
}

export function effectProjectionVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { hasCompanionWrites, state, subtree } = context;
  const effectProjectionSubtree = subtree?.kind === "effect-projection" ? subtree : null;
  if (effectProjectionSubtree && !hasCompanionWrites) {
    const selector = repeatedSubscriptionSuffix(effectProjectionSubtree);
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace effect-written presentation state \`${state.valueName}\` with an owner-scoped observable, preserve the React effect, cleanup, dependencies, and statement order, and wrap the full ${effectProjectionSubtree.label} render boundary at line ${effectProjectionSubtree.line} in an always-mounted leaf subscriber${selector}; evaluate the existing projection or gate inside that subscriber.`,
    };
  }
  return null;
}

export function booleanConsumerVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const {
    hasAdjacentEffectBooleanConsumers,
    hasReactiveHostPropScalarConsumer,
    hasSourceEventScalarConsumers,
    state,
  } = context;
  if (hasAdjacentEffectBooleanConsumers) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace effect-written boolean \`${state.valueName}\` with one component-lifetime observable and extract its adjacent conditional presentation surfaces into one stable leaf subscriber; keep the React effect, dependencies, cleanup, boolean calculation, write position, and each existing conditional mount unchanged.`,
    };
  }
  if (hasSourceEventScalarConsumers) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace event-owned numeric state \`${state.valueName}\` with one component-lifetime observable; keep the source-proven event callback and write position unchanged, and subscribe separately in each bounded projection leaf inside the existing render branch so the broad owner and its branch condition do not subscribe.`,
    };
  }
  if (hasReactiveHostPropScalarConsumer) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace event-owned scalar state \`${state.valueName}\` with one component-lifetime observable and make its single host prop reactive; preserve the source-proven event callback, calculation, write position, host children, and mount identity so the host prop updates without rerendering the broad owner.`,
    };
  }
  return null;
}

export function unsafeOwnershipVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { belongsToObservableSelection, hasDetachedEffectWrites, state, usage } = context;
  if (usage.shadowed || usage.escaped || (usage.effectWrites > 0 && !hasDetachedEffectWrites)) {
    return {
      action: "review-state",
      abstentionReason:
        usage.effectWrites > 0 ? "effect-write-ownership-unresolved" : "ownership-flow-unresolved",
      confidence: "probable",
      message:
        !usage.shadowed && isStructuralLegendCandidate(state, usage, context)
          ? legendCandidateMessage(state, usage)
          : `Review React state \`${state.valueName}\`; its value or setter crosses a boundary this local analysis cannot prove safe.`,
    };
  }
  if (
    usage.setterCalls > 0 &&
    usage.setterReferences === usage.legendReactionWrites &&
    usage.setterCalls === usage.legendReactionWrites &&
    usage.localRenderReads > 0
  ) {
    return {
      action: "use-value",
      confidence: "probable",
      message: `Delete the React mirror \`${state.valueName}\` and derive it with \`useValue\` from the observable read in its Legend reaction.`,
    };
  }
  if (belongsToObservableSelection && !usage.shadowed) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace the selection hook's React state cluster with one observable model; expose observable fields and subscribe per row or control with \`useValue\`.`,
    };
  }
  return null;
}

export function confinedSubtreeVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { hasCompanionWrites, state, subtree, usage } = context;
  const directSubtree = subtree?.kind === "direct" ? subtree : null;
  if (directSubtree && !hasCompanionWrites) {
    if (directSubtree.repeated) {
      return {
        action: "use-observable",
        confidence: "probable",
        message: `Replace \`${state.valueName}\` with a component-lifetime observable and subscribe with a per-item \`useValue\` selector inside the repeated row under the ${directSubtree.label} subtree at line ${directSubtree.line}; do not subscribe the list owner.`,
      };
    }
    const moved = movedDeclarationsNote(directSubtree.movedDeclarations);
    if (directSubtree.unstable) {
      return {
        action: "use-observable",
        confidence: "probable",
        message: `Replace \`${state.valueName}\` with a component-lifetime observable, extract the ${directSubtree.label} subtree at line ${directSubtree.line} into a leaf wrapper, and subscribe there with \`useValue\`; keeping ownership here preserves conditional mount lifetime.${moved}${forwardedSetterNote(state, usage)}`,
      };
    }
    return {
      action: "move-state-down",
      confidence: "probable",
      message: `Extract the ${directSubtree.label} subtree at line ${directSubtree.line} into a leaf component and move \`${state.valueName}\` into it; every read and command is confined to that stable subtree.${moved}`,
    };
  }
  return null;
}

function forwardedSetterNote(state: StateCandidate, usage: StateUsage): string {
  return usage.setterTransportSites.size > 0
    ? ` Where the subtree passes \`${state.setterName}\` to a child, forward \`(next) => ${state.valueName}$.set(next)\` instead.`
    : "";
}

function movedDeclarationsNote(movedDeclarations: readonly string[]): string {
  if (movedDeclarations.length === 0) {
    return "";
  }
  const names = movedDeclarations.map((name) => `\`${name}\``).join(", ");
  return ` Move ${names} into that leaf as well; every use sits inside the subtree, so pass the owner values they still read as props.`;
}

export function gatedSubtreeVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { hasCompanionWrites, state, subtree, usage } = context;
  const projectionSubtree = subtree?.kind === "projection" ? subtree : null;
  const gateSubtree = subtree?.kind === "gate" ? subtree : null;
  if (gateSubtree && !hasCompanionWrites) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace \`${state.valueName}\` with a component-lifetime observable and replace the full state-controlled render expression at the ${gateSubtree.label} boundary on line ${gateSubtree.line} with one always-mounted leaf subscriber; evaluate the complete gate and its selected content inside that wrapper so an initially hidden child can still open.`,
    };
  }
  if (projectionSubtree && !hasCompanionWrites) {
    const selector = repeatedSubscriptionSuffix(projectionSubtree);
    return {
      action: "use-observable",
      confidence: "probable",
      message:
        usage.transportedOccurrences > 0
          ? `Replace \`${state.valueName}\` with a component-lifetime observable and wrap the ${projectionSubtree.label} call site at line ${projectionSubtree.line} in a leaf subscriber${selector}; subscribe to the raw value once, pass that snapshot unchanged, derive every existing projection from the same snapshot, and leave the child API unchanged.`
          : `Replace \`${state.valueName}\` with a component-lifetime observable and wrap the ${projectionSubtree.label} call site at line ${projectionSubtree.line} in a leaf subscriber${selector}; evaluate its existing pure projections inside that wrapper and leave the child API unchanged.`,
    };
  }
  return null;
}

export function multiSurfaceVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { hasAdjacentEventBooleanConsumers, hasMultiSurfaceBooleanConsumers, state } = context;
  if (hasAdjacentEventBooleanConsumers) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace event-computed boolean \`${state.valueName}\` with one component-lifetime observable and extract its adjacent conditional presentation surfaces into one stable leaf subscriber; keep the event callback, boolean calculation, write position, and each existing conditional mount unchanged, while passing state-independent inputs as ordinary props.`,
    };
  }
  if (hasMultiSurfaceBooleanConsumers) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace event-owned boolean \`${state.valueName}\` with one component-lifetime observable; keep the existing event callbacks and write positions, use reactive props for the proven class/style projections, use \`Show\` only at the bounded conditional presentation leaves, and do not subscribe the large owner.`,
    };
  }
  return null;
}

export function wideOwnerTransportVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const {
    hasCompanionWrites,
    hasReactiveMutationPath,
    hasSafeCommands,
    localComponents,
    materiality,
    sourceFile,
    state,
    usage,
  } = context;
  if (
    ownerLineSpan(state.owner, sourceFile) >= WIDE_OWNER_LINE_SPAN &&
    jsxElementCount(state.owner) >= materiality.broadOwnerJsx &&
    !stateMayHoldCallable(state) &&
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences > 0 &&
    usage.valueTargets.size === 1 &&
    localComponents.has([...usage.valueTargets][0] ?? "") &&
    usage.setterReferences > 0 &&
    hasSafeCommands &&
    !hasCompanionWrites &&
    !hasReactiveMutationPath &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped
  ) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace \`${state.valueName}\` with \`useObservable\` at this owner and subscribe with \`useValue\` only in the transported leaf consumers.`,
    };
  }
  return null;
}
