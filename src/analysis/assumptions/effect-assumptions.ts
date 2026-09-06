import type { ClassifiedEffect, EffectCandidate, StateCandidate } from "../model.js";
import type { HookFinding, ResearchStep, StateAssumption } from "../../core/types.js";
import { assumptionStatus, ownerFingerprint } from "./state-assumptions.js";
import type { ConfirmationSet } from "./confirmations.js";
import { jsxElementCount } from "../../rules/state-proofs/jsx-subtrees.js";
import { runtimeFunctionName } from "../ast-helpers.js";
import ts from "typescript";
import { useMountEffect } from "../../rules/effects/effect-verdicts.js";
import { verificationFor } from "./verification.js";

export interface EffectAssumptionScope {
  readonly confirmations: ConfirmationSet | null;
  readonly effect: EffectCandidate;
  readonly reportFile: string;
  readonly sourceFile: ts.SourceFile;
}

export interface EffectAssumptionResult {
  readonly assumption: StateAssumption;
  readonly confirmed: ClassifiedEffect | null;
}

const LIFECYCLE_REASON = "lifecycle-equivalence-unproven";

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function mountResearch(scope: EffectAssumptionScope): ResearchStep[] {
  const { effect, reportFile, sourceFile } = scope;
  const externalCalls: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      externalCalls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  if (effect.callback) {
    visit(effect.callback.body);
  }
  const callLines = [...new Set(externalCalls.map((call) => lineOf(call, sourceFile)))].toSorted(
    (left, right) => left - right,
  );
  return [
    {
      check:
        "this empty-dependency effect runs its setup once per mount and returns no cleanup; confirm the setup must not run twice under React Strict Mode's development replay and nothing expects it to re-run",
      file: reportFile,
      line: lineOf(effect.call, sourceFile),
    },
    ...callLines.map((line) => ({
      check:
        "this call is part of the one-time setup; confirm it is idempotent or intentionally once-only, and that no other effect or handler undoes it",
      file: reportFile,
      line,
    })),
  ];
}

/**
 * An empty-dependency setup effect with no cleanup is `useMount` when suppressing Strict Mode's
 * replay is intended, a fact only the code's author can confirm.
 */
export function effectAssumption(
  classification: ClassifiedEffect,
  scope: EffectAssumptionScope,
): EffectAssumptionResult | null {
  const { confirmations, effect, reportFile, sourceFile } = scope;
  if (
    classification.action !== "review-effect" ||
    classification.abstentionReason !== LIFECYCLE_REASON ||
    !effect.owner
  ) {
    return null;
  }
  const owner = runtimeFunctionName(effect.owner) ?? "anonymous";
  const id = `${reportFile}::${owner}::useEffect@L${lineOf(effect.call, sourceFile)}::${LIFECYCLE_REASON}`;
  const fingerprint = ownerFingerprint(effect.owner, sourceFile);
  const status = assumptionStatus(confirmations?.confirmationFor(id) ?? null, fingerprint);
  return {
    assumption: {
      facts: [LIFECYCLE_REASON],
      fingerprint,
      id,
      ifConfirmed: "use-mount",
      question:
        "this empty-dependency effect only sets things up and returns no cleanup; confirm it is meant to run exactly once per mount, so replacing it with `useMount` (which suppresses React Strict Mode's development replay) changes nothing the code relies on.",
      renderCost: jsxElementCount(effect.owner),
      research: mountResearch(scope),
      status,
      updateSites: 0,
    },
    confirmed: status === "confirmed" ? useMountEffect() : null,
  };
}

export interface EffectReview {
  readonly assumed: EffectAssumptionResult | null;
  readonly followed: ClassifiedEffect;
  readonly stateFindings: ReadonlyMap<StateCandidate, HookFinding>;
}

/** A confirmed lifecycle answer makes `use-mount` actionable; a waiting effect names its questions. */
export function applyEffectReview(
  finding: HookFinding,
  { assumed, followed, stateFindings }: EffectReview,
): HookFinding {
  if (assumed) {
    finding.assumption = assumed.assumption;
    if (assumed.confirmed) {
      finding.disposition = "change";
      finding.verification = verificationFor(
        assumed.assumption,
        "effect's owner",
        finding.location.file,
      );
    }
  }
  const waitsOn =
    followed.action === "review-effect"
      ? waitsOnQuestions(followed.stateDependencies, stateFindings)
      : [];
  if (waitsOn.length > 0) {
    finding.waitsOn = waitsOn;
  }
  return finding;
}

/**
 * A review effect that waits on a state's verdict names the open questions that would settle it,
 * so the agent answers the state instead of hunting for a fact about the effect.
 */
function waitsOnQuestions(
  dependencies: readonly StateCandidate[] | undefined,
  stateFindings: ReadonlyMap<StateCandidate, HookFinding>,
): string[] {
  return [
    ...new Set(
      (dependencies ?? []).flatMap((state) => {
        const assumption = stateFindings.get(state)?.assumption;
        return assumption && assumption.status !== "confirmed" ? [assumption.id] : [];
      }),
    ),
  ].toSorted();
}
