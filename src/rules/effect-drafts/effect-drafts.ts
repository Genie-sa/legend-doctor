import type {
  DraftContext,
  DraftEffect,
  DraftMatch,
  DraftSynchronization,
  EffectDraftAnalysis,
  EffectDraftCluster,
  EffectDraftProofs,
  EffectDraftScope,
} from "./model.js";
import type { EffectCandidate, StateCandidate, StateUsage } from "../../analysis/model.js";
import {
  draftEditProof,
  hasExternalCompanionWrites,
  stateIsWrittenOnlyByEffect,
} from "./draft-mutations.js";
import {
  hasStaleUseCallbackCapture,
  stateControlsHookOrRepeatedBoundary,
} from "./member-boundary-controls.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { hasDraftRenderCut } from "./draft-render-cuts.js";
import { stateMayHoldCallable } from "../state-proofs/state-proofs.js";
import { synchronousDraftSetters } from "./draft-setter-statements.js";
import ts from "typescript";

export interface EffectDraftSearch {
  readonly effects: readonly EffectCandidate[];
  readonly localComponents: ReadonlySet<string>;
  readonly proofs: EffectDraftProofs;
  readonly scopes: ReadonlyMap<RuntimeFunctionLike, EffectDraftScope>;
  readonly siblingRenderCuts: ReadonlyMap<StateCandidate, unknown>;
  readonly sourceComponents: ReadonlySet<string>;
  readonly states: readonly StateCandidate[];
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

export function findEffectSynchronizedDrafts({
  effects,
  localComponents,
  proofs,
  scopes,
  siblingRenderCuts,
  sourceComponents,
  states,
  usageByState,
}: EffectDraftSearch): EffectDraftAnalysis {
  const context: DraftContext = {
    effects,
    localComponents,
    proofs,
    siblingRenderCuts,
    sourceComponents,
    states,
    usageByState,
  };
  const analysis: DraftSynchronization = {
    clusters: new Map(),
    effects: new Set(),
    singletons: new Set(),
  };
  for (const effect of effects) {
    const match = synchronizedDraftMatch(effect, scopes, context);
    if (match) {
      recordDraftCluster(analysis, match);
    }
  }
  return {
    clusters: analysis.clusters,
    effects: analysis.effects,
    singletons: analysis.singletons,
  };
}

function synchronizedDraftMatch(
  effect: EffectCandidate,
  scopes: ReadonlyMap<RuntimeFunctionLike, EffectDraftScope>,
  context: DraftContext,
): DraftMatch | null {
  const { callback, dependencies, owner } = effect;
  if (!owner || !callback || !dependencies || dependencies.elements.length === 0) {
    return null;
  }
  const scope = scopes.get(owner);
  const members = scope ? synchronousDraftSetters(callback, scope.bySetter) : null;
  if (!members || members.length === 0 || context.proofs.isCustomHookOwner(owner)) {
    return null;
  }
  const draft: DraftEffect = { callback, context, effect, owner };
  return isCompleteDraftCluster(draft, members) ? { draft, members } : null;
}

function isCompleteDraftCluster(draft: DraftEffect, members: readonly StateCandidate[]): boolean {
  const ownerSetters = new Set(
    draft.context.states.flatMap((state) =>
      state.owner === draft.owner && state.setterName ? [state.setterName] : [],
    ),
  );
  const editProofs = members.map((state) => draftEditProof(state, draft, ownerSetters));
  if (
    !members.every((state) => isCompleteDraftMember(state, draft)) ||
    !editProofs.every((proof) => proof.reachable) ||
    !editProofs.some((proof) => proof.independent)
  ) {
    return false;
  }
  return !hasExternalCompanionWrites(draft, members) && hasDraftRenderCut(draft, members);
}

function isCompleteDraftMember(state: StateCandidate, draft: DraftEffect): boolean {
  const usage = draft.context.usageByState.get(state);
  return (
    usage !== undefined &&
    stateIsWrittenOnlyByEffect(usage, draft.effect, draft.context.effects) &&
    usage.setterReferences > usage.effectWrites &&
    usage.effectReads === 0 &&
    !hasStaleUseCallbackCapture(state) &&
    usage.localRenderReads + usage.transportedOccurrences > 0 &&
    !usage.shadowed &&
    !usage.escaped &&
    !stateMayHoldCallable(state) &&
    !stateControlsHookOrRepeatedBoundary(state)
  );
}

function recordDraftCluster(analysis: DraftSynchronization, match: DraftMatch): void {
  analysis.effects.add(match.draft.effect);
  const ordered = [...match.members].toSorted(
    (left, right) => left.call.getStart() - right.call.getStart(),
  );
  if (ordered.length === 1) {
    analysis.singletons.add(ordered[0]!);
    return;
  }
  const cluster = draftCluster(match.draft, ordered);
  for (const state of ordered) {
    analysis.clusters.set(state, cluster);
  }
}

function draftCluster(draft: DraftEffect, ordered: readonly StateCandidate[]): EffectDraftCluster {
  const names = ordered.map((state) => `\`${state.valueName}\``).join(", ");
  const initialization = ordered.some((state) => hasLazyStateInitializer(state))
    ? " Preserve every lazy initializer as a once-only owner snapshot; do not pass it to Legend as a computed function."
    : "";
  return {
    action: "use-observable",
    id: `state-cluster:effect-draft:${draft.owner.getStart()}:${draft.effect.call.getStart()}`,
    members: ordered,
    message: `Replace the effect-synchronized React draft cluster (${names}) with one component-lifetime observable model; preserve the React synchronization effect and its dependencies, assign the draft atomically there, mutate from edit commands, snapshot once at command entry before deferred work, and subscribe only in rendered leaves.${initialization}`,
    primary: ordered[0]!,
  };
}

export function hasLazyStateInitializer(state: StateCandidate): boolean {
  const [initializer] = state.call.arguments;
  return (
    initializer !== undefined &&
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
  );
}
