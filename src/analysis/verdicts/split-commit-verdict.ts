import type { ClassifiedState, StateCandidate } from "../model.js";

/**
 * An observable conversion publishes through `useSyncExternalStore`. When the renderer may commit
 * that notification before a rendered React state updated in the same transition, the converted
 * leaf commits first and alone, so one atomic transition becomes two commits.
 */
export function splitCommitVerdict(
  classified: ClassifiedState,
  state: StateCandidate,
  companions: readonly StateCandidate[],
): ClassifiedState {
  if (classified.action !== "use-observable" || companions.length === 0) {
    return classified;
  }
  const reasons = companions.map(
    (companion) =>
      `React state \`${companion.valueName}\` is set in another stretch of the same command, which may run after React commits the observable's notification`,
  );
  return {
    action: "review-state",
    abstentionReason: "atomic-transition-unproven",
    confidence: "probable",
    message: `Review \`${state.valueName}\`; converting it alone may split one transition into two commits. ${reasons.join("; ")}. Keep \`${state.valueName}\` in React unless the co-written states convert together with their writes moved into one synchronous stretch.`,
  };
}
