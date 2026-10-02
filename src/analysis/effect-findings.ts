import type {
  BrowserStoragePersistence,
  ClassifiedEffect,
  EffectCandidate,
  StateCandidate,
} from "./model.js";
import { effectEvidence, findingFor } from "./finding-format.js";
import {
  keepEffectForKeptState,
  keepEffectForMigratedState,
  persistMigratedStateEffect,
} from "../rules/effects/effect-verdicts.js";
import { EMPTY_STATE_CANDIDATES } from "./constants.js";
import type { EffectAssumptionResult } from "./assumptions/effect-assumptions.js";
import type { HookFinding } from "../core/types.js";
import type { StateAnalysisResult } from "./proofs/contracts.js";
import { effectAssumption } from "./assumptions/effect-assumptions.js";
import { identityClaim } from "../rules/effects/render-phase-resets.js";
import path from "node:path";
import { verificationFor } from "./assumptions/verification.js";

const PAIRED_DRAFT_EFFECT_CLASSIFICATION: ClassifiedEffect = {
  action: "review-effect",
  abstentionReason: "paired-draft-effect-preserved",
  confidence: "probable",
  derivedState: null,
  message:
    "Preserve this React synchronization effect and its dependency timing; when migrating the paired draft, replace only its setter calls with one atomic observable assignment.",
};

export function effectFindingFor(
  effect: EffectCandidate,
  result: StateAnalysisResult,
  stateFindings: ReadonlyMap<StateCandidate, HookFinding>,
): HookFinding | null {
  const resolved = resolveEffectClassification(effect, result, stateFindings);
  if (!resolved) {
    return null;
  }
  const { assumed, classification } = resolved;
  const finding = findingFor(effect.call, classification, {
    evidence: effectFindingEvidence(effect, result, assumed),
    fileName: result.analysis.fileName,
    hook: "useEffect",
    name: null,
    sourceFile: result.analysis.sourceFile,
  });
  const waitsOn =
    classification.action === "review-effect"
      ? waitsOnQuestions(classification.stateDependencies, stateFindings)
      : [];
  if (waitsOn.length > 0) {
    finding.waitsOn = waitsOn;
  }
  attachAssumption(finding, assumed, result.analysis.fileName);
  return finding;
}

function effectFindingEvidence(
  effect: EffectCandidate,
  { analysis, ownership }: StateAnalysisResult,
  assumed: EffectAssumptionResult | null,
): string[] {
  const scope = effect.owner ? ownership.effectStateScopes.get(effect.owner) : undefined;
  return [
    ...effectEvidence(effect, analysis.sourceFile, scope?.bySetter ?? EMPTY_STATE_CANDIDATES),
    ...(assumed?.confirmed
      ? [`assumption confirmed by ${assumed.assumption.id}: ${assumed.assumption.question}`]
      : []),
  ];
}

interface ResolvedEffect {
  readonly assumed: EffectAssumptionResult | null;
  readonly classification: ClassifiedEffect;
}

function resolveEffectClassification(
  effect: EffectCandidate,
  { analysis, clusters, effectProofs }: StateAnalysisResult,
  stateFindings: ReadonlyMap<StateCandidate, HookFinding>,
): ResolvedEffect | null {
  const base =
    !analysis.nonProductionHarness && clusters.effectDrafts.effects.has(effect)
      ? PAIRED_DRAFT_EFFECT_CLASSIFICATION
      : effectProofs.effectClassifications.get(effect);
  if (!base) {
    return null;
  }
  const followed =
    renderPhaseResetClassification(base, stateFindings) ??
    stateFollowingEffectClassification(base, stateFindings) ??
    base;
  const assumed = effectAssumption(followed, {
    confirmations: analysis.confirmations,
    effect,
    reportFile: path.normalize(analysis.fileName),
    sourceFile: analysis.sourceFile,
  });
  return { assumed, classification: assumed?.confirmed ?? followed };
}

function attachAssumption(
  finding: HookFinding,
  assumed: EffectAssumptionResult | null,
  fileName: string,
): void {
  if (!assumed) {
    return;
  }
  finding.assumption = assumed.assumption;
  if (assumed.confirmed) {
    finding.verification = verificationFor(assumed.assumption, "effect's owner", fileName);
  }
}

const REACT_STATE_VERDICTS: ReadonlySet<HookFinding["action"]> = new Set([
  "keep-state",
  "review-state",
]);

/**
 * A reset runs during render only while every state it writes stays React state; a migrating
 * state rewrites the effect's writes instead. Unproven dependency identities leave one question.
 */
function renderPhaseResetClassification(
  { renderPhaseReset: reset }: ClassifiedEffect,
  stateFindings: ReadonlyMap<StateCandidate, HookFinding>,
): ClassifiedEffect | null {
  if (
    !reset ||
    !reset.targets.every((state) =>
      REACT_STATE_VERDICTS.has(stateFindings.get(state)?.action ?? "use-observable"),
    )
  ) {
    return null;
  }
  return reset.unprovenDependencies.length === 0
    ? {
        action: "reset-during-render",
        confidence: "probable",
        derivedState: null,
        message: reset.instruction,
      }
    : {
        action: "review-effect",
        abstentionReason: "dependency-identity-unproven",
        confidence: "probable",
        derivedState: null,
        message: `Review this reset effect; it can run during render once ${identityClaim(reset.unprovenDependencies)} between renders, which no local fact proves.`,
        renderPhaseReset: reset,
      };
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

const MIGRATING_STATE_ACTIONS: ReadonlySet<HookFinding["action"]> = new Set([
  "use-observable",
  "use-ref",
]);

/**
 * A review effect whose every local state dependency already has a settled state verdict inherits
 * it: kept states leave no Legend effect action, and a migrating state that the effect only writes
 * keeps the effect with rewritten writes.
 */
function stateFollowingEffectClassification(
  classification: ClassifiedEffect,
  stateFindings: ReadonlyMap<StateCandidate, HookFinding>,
): ClassifiedEffect | null {
  if (classification.persistence) {
    return persistedStateEffectClassification(classification.persistence, stateFindings);
  }
  if (classification.action !== "review-effect" || !classification.stateDependencies?.length) {
    return null;
  }
  const settled = settledStateFindings(classification.stateDependencies, stateFindings);
  return settled
    ? inheritedEffectClassification(
        classification.stateDependencies.map((state) => state.valueName),
        settled,
        classification.abstentionReason === "effect-write-ownership-unresolved",
      )
    : null;
}

function inheritedEffectClassification(
  names: readonly string[],
  settled: readonly HookFinding[],
  writesOnly: boolean,
): ClassifiedEffect | null {
  if (settled.every((finding) => finding.action === "keep-state")) {
    const certain = settled.every((finding) => finding.confidence === "certain");
    return keepEffectForKeptState(names, certain ? "certain" : "probable");
  }
  const migrating = settled.every(
    (finding) => finding.action === "keep-state" || MIGRATING_STATE_ACTIONS.has(finding.action),
  );
  const migratingNames = names.filter((_name, index) =>
    MIGRATING_STATE_ACTIONS.has(settled[index]?.action ?? "keep-state"),
  );
  return writesOnly && migrating ? keepEffectForMigratedState(migratingNames) : null;
}

/** A persistence effect earns its Legend replacement only once every persisted state migrates to an observable. */
function persistedStateEffectClassification(
  persistence: BrowserStoragePersistence,
  stateFindings: ReadonlyMap<StateCandidate, HookFinding>,
): ClassifiedEffect | null {
  const settled = settledStateFindings(persistence.states, stateFindings);
  return settled?.every((finding) => finding.action === "use-observable")
    ? persistMigratedStateEffect(persistence)
    : null;
}

function settledStateFindings(
  states: readonly StateCandidate[],
  stateFindings: ReadonlyMap<StateCandidate, HookFinding>,
): readonly HookFinding[] | null {
  const settled: HookFinding[] = [];
  for (const state of states) {
    const finding = stateFindings.get(state);
    if (!finding) {
      return null;
    }
    settled.push(finding);
  }
  return settled;
}
