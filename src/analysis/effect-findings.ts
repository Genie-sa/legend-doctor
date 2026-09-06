import type {
  BrowserStoragePersistence,
  ClassifiedEffect,
  EffectCandidate,
  StateCandidate,
} from "./model.js";
import { applyEffectReview, effectAssumption } from "./assumptions/effect-assumptions.js";
import { effectEvidence, findingFor } from "./finding-format.js";
import {
  keepEffectForKeptState,
  keepEffectForMigratedState,
  persistMigratedStateEffect,
} from "../rules/effects/effect-verdicts.js";
import { EMPTY_STATE_CANDIDATES } from "./constants.js";
import type { HookFinding } from "../core/types.js";
import type { StateAnalysisResult } from "./proofs/contracts.js";
import path from "node:path";

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
  { analysis, clusters, effectProofs, ownership }: StateAnalysisResult,
  stateFindings: ReadonlyMap<StateCandidate, HookFinding>,
): HookFinding | null {
  const base =
    !analysis.nonProductionHarness && clusters.effectDrafts.effects.has(effect)
      ? PAIRED_DRAFT_EFFECT_CLASSIFICATION
      : effectProofs.effectClassifications.get(effect);
  if (!base) {
    return null;
  }
  const followed = stateFollowingEffectClassification(base, stateFindings) ?? base;
  const assumed = effectAssumption(followed, {
    confirmations: analysis.confirmations,
    effect,
    reportFile: path.normalize(analysis.fileName),
    sourceFile: analysis.sourceFile,
  });
  const classification = assumed?.confirmed ?? followed;
  const scope = effect.owner ? ownership.effectStateScopes.get(effect.owner) : undefined;
  const finding = findingFor(effect.call, classification, {
    evidence: [
      ...effectEvidence(effect, analysis.sourceFile, scope?.bySetter ?? EMPTY_STATE_CANDIDATES),
      ...(assumed?.confirmed
        ? [`assumption confirmed by ${assumed.assumption.id}: ${assumed.assumption.question}`]
        : []),
    ],
    fileName: analysis.fileName,
    hook: "useEffect",
    name: null,
    sourceFile: analysis.sourceFile,
  });
  return applyEffectReview(finding, { assumed, followed, stateFindings });
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
