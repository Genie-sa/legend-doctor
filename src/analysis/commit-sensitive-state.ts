import type { ClassifiedState, StateCandidate, StateUsage } from "./model.js";
import type { SourceAnalysis } from "./proofs/contracts.js";
import { nodeWithin } from "../core/ast.js";

export function stateIsCommitSensitive(
  state: StateCandidate,
  usage: StateUsage,
  { commitSensitiveOwners, nonProductionHarness, reactCommit }: SourceAnalysis,
): boolean {
  const directTransitionCallbacks = reactCommit.directTransitionCallbacks.get(state.owner);
  const transitionTouchesState =
    directTransitionCallbacks?.some((callback) =>
      usage.setterCallNodes.some((call) => nodeWithin(call, callback)),
    ) ?? true;
  return (
    commitSensitiveOwners.has(state.owner) &&
    transitionTouchesState &&
    state.setterName !== null &&
    !nonProductionHarness
  );
}

export function commitSensitiveStateClassification(state: StateCandidate): ClassifiedState {
  return {
    action: "review-state",
    abstentionReason: "react-commit-sensitive",
    confidence: "probable",
    message: `Review React state \`${state.valueName}\`; updating it currently participates in a React transition, every-commit effect, or callback-ref lifecycle in this owner, so isolating the render could change priority or commit cadence.`,
  };
}
