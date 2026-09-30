import type {
  StateClassificationContext,
  StateClassificationInputs,
  StateVerdict,
} from "./classification-context.js";
import {
  asyncStatusVerdict,
  boundaryMoveVerdict,
  commandLifecycleVerdict,
  controlledCutVerdict,
  intrinsicStateVerdict,
  keyedCursorVerdict,
  keyedSelectionVerdict,
  lazyCallbackLeafVerdict,
  pairedAsyncStatusVerdict,
  unusedStateVerdict,
} from "./intrinsic-verdicts.js";
import {
  booleanConsumerVerdict,
  confinedSubtreeVerdict,
  effectProjectionSubtreeVerdict,
  effectProjectionVerdict,
  functionalSnapshotVerdict,
  gatedSubtreeVerdict,
  multiSurfaceVerdict,
  refCommandSnapshotVerdict,
  splitEffectProjectionVerdict,
  unsafeOwnershipVerdict,
  wideOwnerTransportVerdict,
} from "./subtree-verdicts.js";
import {
  broadTransportVerdict,
  delayedPendingVerdict,
  renderReadVerdict,
  residualStateVerdict,
  singleTargetTransportVerdict,
} from "./residual-verdicts.js";
import {
  cohesiveControlledLeafVerdict,
  controlledCallSiteProjectionVerdict,
  controlledLeafVerdict,
  controlledProjectionCutVerdict,
} from "./controlled-verdicts.js";
import {
  compactTransportCutVerdict,
  descendantControlledCutVerdict,
  visibilityTransportVerdict,
} from "./transport-verdicts.js";
import {
  hookConsumerLeafVerdict,
  hookPresentationConsumerVerdict,
  smallOwnerEffectWrittenVerdict,
} from "./small-owner-verdicts.js";
import { stateCommandSnapshotEvidence, stateRenderCutEvidence } from "./classification-context.js";
import type { ClassifiedState } from "../model.js";
import { ownerHasMutableRenderRead } from "../../rules/state-proofs/render-purpose.js";
import { renderedByClonedPropElement } from "../../rules/child-contract/element-identity.js";
import { siteSubscriptionVerdict } from "./site-subscription-verdict.js";
import { splitCommitVerdict } from "./split-commit-verdict.js";

const STATE_VERDICTS: readonly StateVerdict[] = [
  intrinsicStateVerdict,
  controlledCutVerdict,
  commandLifecycleVerdict,
  keyedSelectionVerdict,
  keyedCursorVerdict,
  boundaryMoveVerdict,
  unusedStateVerdict,
  lazyCallbackLeafVerdict,
  asyncStatusVerdict,
  pairedAsyncStatusVerdict,
  compactTransportCutVerdict,
  descendantControlledCutVerdict,
  visibilityTransportVerdict,
  controlledLeafVerdict,
  cohesiveControlledLeafVerdict,
  controlledCallSiteProjectionVerdict,
  controlledProjectionCutVerdict,
  refCommandSnapshotVerdict,
  functionalSnapshotVerdict,
  effectProjectionSubtreeVerdict,
  splitEffectProjectionVerdict,
  effectProjectionVerdict,
  booleanConsumerVerdict,
  smallOwnerEffectWrittenVerdict,
  hookConsumerLeafVerdict,
  hookPresentationConsumerVerdict,
  unsafeOwnershipVerdict,
  confinedSubtreeVerdict,
  gatedSubtreeVerdict,
  multiSurfaceVerdict,
  wideOwnerTransportVerdict,
  siteSubscriptionVerdict,
  delayedPendingVerdict,
  renderReadVerdict,
  singleTargetTransportVerdict,
  broadTransportVerdict,
];

export function classifyState(inputs: StateClassificationInputs): ClassifiedState {
  return splitCommitVerdict(firstStateVerdict(inputs), inputs.state, inputs.splitCommitCompanions);
}

function firstStateVerdict(inputs: StateClassificationInputs): ClassifiedState {
  const context: StateClassificationContext = {
    ...inputs,
    commandSnapshot: stateCommandSnapshotEvidence(inputs),
    renderCut: stateRenderCutEvidence(inputs),
  };
  for (const verdict of STATE_VERDICTS) {
    const classified = verdict(context);
    if (classified) {
      if (
        (classified.action === "use-ref" || classified.action === "delete-unused-state") &&
        ownerHasMutableRenderRead(inputs.state.owner)
      ) {
        return {
          action: "review-state",
          abstentionReason: "render-cut-unproven",
          confidence: "probable",
          message: `Review \`${inputs.state.valueName}\`; its render may refresh mutable refs or imperative reads even though the state value does not render. Preserve the update until every refreshed value has an independent subscription.`,
        };
      }
      return withDetachedEffectNote(withClonedElementReview(classified, context), context);
    }
  }
  return residualStateVerdict(context);
}

/** A leaf that replaces a cloned `refreshControl` element must forward the props injected into it. */
function withClonedElementReview(
  classified: ClassifiedState,
  { state, usage }: StateClassificationContext,
): ClassifiedState {
  const extracts =
    classified.action === "use-observable" || classified.action === "move-state-down";
  const reads = [...usage.directRenderNodes, ...[...usage.transportNodes.values()].flat()];
  if (!extracts || !reads.some((read) => renderedByClonedPropElement(read))) {
    return classified;
  }
  return {
    action: "review-state",
    abstentionReason: "child-contract-unresolved",
    confidence: "probable",
    message: `Review \`${state.valueName}\`; it renders in the element passed as \`refreshControl\`, which React Native's Android ScrollView clones to inject \`style\` and the scroll view as \`children\`. A leaf subscriber around that element must forward every prop it receives, or the list disappears on Android.`,
  };
}

const DETACHED_EFFECT_NOTE =
  " Keep the React effect that writes it, with its dependencies and cleanup, and write the observable at the same position; the effect never reads or schedules on this state, so its timing is unchanged.";

/**
 * An effect that writes a state without reading it or listing it as a dependency stays in React;
 * only its write target changes, so the migrated state's instruction carries that note.
 */
function withDetachedEffectNote(
  classified: ClassifiedState,
  { hasDetachedEffectWrites }: StateClassificationContext,
): ClassifiedState {
  if (!hasDetachedEffectWrites || classified.action !== "use-observable") {
    return classified;
  }
  return { ...classified, message: `${classified.message}${DETACHED_EFFECT_NOTE}` };
}
