import type { ClassifiedState, StateCandidate } from "../model.js";
import type { HookFinding, StateAssumption } from "../../core/types.js";
import { cowrittenGroup, groupAssumption } from "./group-assumptions.js";
import type { FindingsScope } from "../finding-clusters.js";
import type { GroupAssumptionResult } from "./group-assumptions.js";
import type { StateClassificationInputs } from "../verdicts/classification-context.js";
import path from "node:path";
import { stateAssumption } from "./state-assumptions.js";

/** The verdict a state finding reports, and the review question it carries when one exists. */
export interface ResolvedStateClassification {
  readonly assumption: StateAssumption | null;
  readonly classification: ClassifiedState;
  /** Evidence lines recording every answer that shaped the verdict. */
  readonly evidence: readonly string[];
  /** A confirmed group answer clusters the converting members under one instruction. */
  readonly group: NonNullable<HookFinding["group"]> | null;
}

type ReviewState = Extract<ClassifiedState, { action: "review-state" }>;

interface SingleAssumptionQuery {
  readonly classified: ReviewState;
  readonly inputs: StateClassificationInputs;
  readonly partners: readonly StateCandidate[];
  readonly result: FindingsScope;
}

function reportFileOf(result: FindingsScope): string {
  return path.normalize(result.analysis.fileName);
}

function isReview(classified: ClassifiedState): classified is ReviewState {
  return classified.action === "review-state";
}

function confirmedLine(assumption: StateAssumption): string {
  return `assumption confirmed by ${assumption.id}: ${assumption.question}`;
}

function unchanged(classification: ClassifiedState): ResolvedStateClassification {
  return { assumption: null, classification, evidence: [], group: null };
}

function singleAssumption({
  classified,
  inputs,
  partners,
  result,
}: SingleAssumptionQuery): ResolvedStateClassification {
  const assumed = stateAssumption(classified, {
    analysisRoot: result.analysis.analysisRoot,
    confirmations: result.analysis.confirmations,
    inputs,
    partners,
    reportFile: reportFileOf(result),
  });
  return {
    assumption: assumed?.assumption ?? null,
    classification: assumed?.confirmed ?? classified,
    evidence: assumed?.confirmed ? [confirmedLine(assumed.assumption)] : [],
    group: null,
  };
}

/** After a confirmed group answer, a still-blocked member is asked about its next blocker at once. */
function chainedAssumption(
  remaining: ReviewState,
  inputs: StateClassificationInputs,
  result: FindingsScope,
): ResolvedStateClassification {
  return singleAssumption({
    classified: remaining,
    inputs: { ...inputs, hasCompanionWrites: false, hasNonClosingCompanionWrites: false },
    partners: [],
    result,
  });
}

/**
 * A co-written group answers as one. Once confirmed, a member the group alone could not convert
 * drops the co-write blocker and is asked about whatever blocks it next, in the same scan.
 */
function cowrittenAssumption(
  classified: ReviewState,
  inputs: StateClassificationInputs,
  result: FindingsScope,
): ResolvedStateClassification {
  const members = cowrittenGroup(inputs.state, result.ownership.companionWrites.partners);
  const grouped = groupAssumption({
    confirmations: result.analysis.confirmations,
    inputs,
    members,
    reportFile: reportFileOf(result),
    result,
  });
  if (!grouped) {
    const partners = members.filter((member) => member !== inputs.state);
    return singleAssumption({ classified, inputs, partners, result });
  }
  return grouped.confirmed
    ? settledGroup(grouped, inputs, result)
    : { ...unchanged(classified), assumption: grouped.assumption };
}

function settledGroup(
  grouped: GroupAssumptionResult,
  inputs: StateClassificationInputs,
  result: FindingsScope,
): ResolvedStateClassification {
  // SAFETY: callers reach settledGroup only when the group answer is confirmed, so the verdict is set.
  const confirmed = grouped.confirmed!;
  const evidence = [confirmedLine(grouped.assumption)];
  if (!isReview(confirmed)) {
    return {
      assumption: grouped.assumption,
      classification: confirmed,
      evidence,
      group: grouped.group,
    };
  }
  const chained = chainedAssumption(confirmed, inputs, result);
  return { ...chained, evidence: [...evidence, ...chained.evidence] };
}

/** A confirmed assumption replaces the review verdict with the conversion it justified. */
export function resolveStateClassification(
  classified: ClassifiedState,
  inputs: StateClassificationInputs,
  result: FindingsScope,
): ResolvedStateClassification {
  if (!isReview(classified)) {
    return unchanged(classified);
  }
  if (classified.abstentionReason === "atomic-transition-unproven") {
    return cowrittenAssumption(classified, inputs, result);
  }
  return singleAssumption({ classified, inputs, partners: [], result });
}
