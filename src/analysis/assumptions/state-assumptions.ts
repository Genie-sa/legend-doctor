import type {
  AbstentionReason,
  AssumptionStatus,
  ResearchStep,
  StateAssumption,
} from "../../core/types.js";
import type { ClassifiedState, StateCandidate } from "../model.js";
import type { Confirmation, ConfirmationSet } from "./confirmations.js";
import { hypothesisFor, leafWrapHypothesis } from "./hypotheses.js";
import type { StateClassificationInputs } from "../verdicts/classification-context.js";
import { classifyState } from "../verdicts/classify-state.js";
import { createHash } from "node:crypto";
import { jsxElementCount } from "../../rules/state-proofs/jsx-subtrees.js";
import { runtimeFunctionName } from "../ast-helpers.js";
import type ts from "typescript";

type ReviewState = Extract<ClassifiedState, { action: "review-state" }>;

export interface AssumptionScope {
  readonly analysisRoot: string | null;
  readonly confirmations: ConfirmationSet | null;
  readonly inputs: StateClassificationInputs;
  readonly partners: readonly StateCandidate[];
  /** The report-relative file name, part of the stable assumption id. */
  readonly reportFile: string;
}

/** A review finding's open question, and the verdict a confirmed answer replaces it with. */
export interface StateAssumptionResult {
  readonly assumption: StateAssumption;
  readonly confirmed: ClassifiedState | null;
}

type ConfirmableAction = StateAssumption["ifConfirmed"];

const FINGERPRINT_LENGTH = 12;

/** Deleting state needs a complete proof; an assumed fact can only justify moving or rehoming it. */
function confirmableAction(classified: ClassifiedState): ConfirmableAction | null {
  const { action } = classified;
  if (
    action === "delete-derived-state" ||
    action === "delete-unused-state" ||
    action === "keep-state" ||
    action === "review-state"
  ) {
    return null;
  }
  return action;
}

/**
 * An answer is honoured only while the owner it was given for is unchanged: the fingerprint is a
 * digest of the owner's source with whitespace collapsed, so reformatting does not invalidate it.
 */
export function ownerFingerprint(owner: ts.Node, sourceFile: ts.SourceFile): string {
  const text = owner.getText(sourceFile).replaceAll(/\s+/gu, " ");
  return createHash("sha1").update(text).digest("hex").slice(0, FINGERPRINT_LENGTH);
}

export function assumptionStatus(
  answer: Confirmation | null,
  fingerprint: string,
): AssumptionStatus {
  if (answer === null) {
    return "open";
  }
  if (answer.fingerprint !== undefined && answer.fingerprint !== fingerprint) {
    return "stale";
  }
  return answer.answer === "yes" ? "confirmed" : "rejected";
}

function ownerLabel(inputs: StateClassificationInputs): string {
  const { owner } = inputs.state;
  const name = runtimeFunctionName(owner);
  if (name !== null) {
    return name;
  }
  const line = inputs.sourceFile.getLineAndCharacterOfPosition(owner.getStart(inputs.sourceFile));
  return `anonymous@L${line.line + 1}`;
}

export function assumptionId(
  reportFile: string,
  inputs: StateClassificationInputs,
  facts: readonly AbstentionReason[],
): string {
  return `${reportFile}::${ownerLabel(inputs)}::${inputs.state.valueName}::${facts.join("+")}`;
}

/** A hypothesis whose hypothetical verdict has been computed, ready to chain or to ask. */
interface ResolvedHypothesis {
  readonly facts: readonly AbstentionReason[];
  readonly question: string;
  readonly research: readonly ResearchStep[];
  readonly verdict: ClassifiedState;
}

const MAX_CHAINED_FACTS = 2;

function resolveOnce(
  reason: AbstentionReason,
  scope: AssumptionScope,
  inputs: StateClassificationInputs,
): ResolvedHypothesis | null {
  const hypothesis = hypothesisFor(reason, { ...scope, inputs });
  if (!hypothesis) {
    return null;
  }
  return {
    facts: [reason],
    question: hypothesis.question,
    research: hypothesis.research,
    verdict: hypothesis.directVerdict ?? classifyState(hypothesis.inputs),
  };
}

/**
 * One step per line. Chaining a second fact often reaches a line the first fact already named, and
 * both asks belong to whoever opens it, so distinct checks join instead of one displacing the other.
 */
function dedupeResearch(steps: readonly ResearchStep[]): ResearchStep[] {
  const byLine = new Map<string, ResearchStep>();
  for (const step of steps) {
    const key = `${step.file}:${step.line}`;
    const merged = byLine.get(key);
    if (!merged) {
      byLine.set(key, step);
    } else if (!merged.check.includes(step.check)) {
      byLine.set(key, { ...merged, check: `${merged.check}; also ${step.check}` });
    }
  }
  return [...byLine.values()];
}

function chainSecond(
  first: ResolvedHypothesis,
  reason: AbstentionReason,
  scope: AssumptionScope,
): ResolvedHypothesis {
  const next = first.verdict.action === "review-state" ? first.verdict.abstentionReason : null;
  const hypothesis = hypothesisFor(reason, scope);
  if (next === null || next === reason || !hypothesis) {
    return first;
  }
  const second = resolveOnce(next, scope, hypothesis.inputs);
  if (!second || second.verdict.action === "review-state") {
    return first;
  }
  return {
    facts: [...first.facts, ...second.facts],
    question: `${first.question} Additionally, ${second.question}`,
    research: dedupeResearch([...first.research, ...second.research]),
    verdict: second.verdict,
  };
}

/** Without a child-contract resolver, the leaf-subscriber rewrite is the only confirmable fact. */
function leafWrapAlone(
  reason: AbstentionReason,
  scope: AssumptionScope,
): ResolvedHypothesis | null {
  const leaf = leafWrapHypothesis(scope);
  return leaf?.directVerdict
    ? {
        facts: [reason],
        question: leaf.question,
        research: leaf.research,
        verdict: leaf.directVerdict,
      }
    : null;
}

/**
 * When the specific hypothesis leaves the owner still subscribed, the generic leaf-subscriber rewrite
 * is the remaining fact: a second one when the blocker differs, the only one when it is the same.
 */
function leafWrapFallback(
  first: ResolvedHypothesis,
  reason: AbstentionReason,
  scope: AssumptionScope,
): ResolvedHypothesis | null {
  const leaf = leafWrapHypothesis(scope);
  if (!leaf?.directVerdict) {
    return null;
  }
  const remaining: AbstentionReason =
    scope.inputs.usage.localRenderReads > 0 ? "render-cut-unproven" : "child-contract-unresolved";
  const research = dedupeResearch([...first.research, ...leaf.research]);
  if (remaining === reason) {
    return { facts: [reason], question: leaf.question, research, verdict: leaf.directVerdict };
  }
  return {
    facts: [...first.facts, remaining],
    question: `${first.question} Additionally, ${leaf.question}`,
    research,
    verdict: leaf.directVerdict,
  };
}

/**
 * Assumes the finding's blocker away; when another blocker then stands alone, assumes that one too
 * and asks both facts in one question. Two facts is the cap: beyond that a "yes" stops being a review.
 */
function resolveChain(reason: AbstentionReason, scope: AssumptionScope): ResolvedHypothesis | null {
  const first = resolveOnce(reason, scope, scope.inputs);
  if (!first) {
    return reason === "child-contract-unresolved" ? leafWrapAlone(reason, scope) : null;
  }
  if (first.verdict.action !== "review-state" || first.facts.length >= MAX_CHAINED_FACTS) {
    return first;
  }
  const chained = chainSecond(first, reason, scope);
  if (chained.verdict.action !== "review-state") {
    return chained;
  }
  return leafWrapFallback(first, reason, scope) ?? chained;
}

/**
 * Re-runs the verdict pipeline with the finding's blocker assumed away. A question is asked only
 * when that hypothetical run yields a conversion, so every "yes" has a concrete instruction.
 */
export function stateAssumption(
  classified: ReviewState,
  scope: AssumptionScope,
): StateAssumptionResult | null {
  const { inputs } = scope;
  const resolved = resolveChain(classified.abstentionReason, scope);
  const ifConfirmed = resolved ? confirmableAction(resolved.verdict) : null;
  if (!resolved || ifConfirmed === null) {
    return null;
  }
  const id = assumptionId(scope.reportFile, inputs, resolved.facts);
  const fingerprint = ownerFingerprint(inputs.state.owner, inputs.sourceFile);
  const status = assumptionStatus(scope.confirmations?.confirmationFor(id) ?? null, fingerprint);
  return {
    assumption: {
      facts: [...resolved.facts],
      fingerprint,
      id,
      ifConfirmed,
      question: resolved.question,
      renderCost: jsxElementCount(inputs.state.owner),
      research: [...resolved.research],
      status,
      updateSites: inputs.usage.setterCalls,
    },
    confirmed: status === "confirmed" ? resolved.verdict : null,
  };
}
