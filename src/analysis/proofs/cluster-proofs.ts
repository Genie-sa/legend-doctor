import type { ClusterProofs, CommandProofs, OwnershipProofs, SourceAnalysis } from "./contracts.js";
import type { SiblingRenderCut, StateCandidate } from "../model.js";
import { analyzeKeyedSelections } from "../../rules/keyed-selection/keyed-selection.js";
import { effectDraftProofs } from "./rule-proofs.js";
import { findContextHeldStateClusters } from "../context/context-held-state.js";
import { findEffectSynchronizedDrafts } from "../../rules/effect-drafts/effect-drafts.js";
import { findListenerRefStateClusters } from "../../rules/listener-ref-state/listener-ref-state.js";
import { findObservableStateClusters } from "../clusters/observable-clusters.js";
import { findStateSubtreeClusters } from "../clusters/subtree-clusters.js";
import { siblingProducerConsumerCut } from "../sibling-render-cut.js";

export function collectClusterProofs(
  analysis: SourceAnalysis,
  proofs: CommandProofs & OwnershipProofs,
): ClusterProofs {
  const {
    childContracts,
    effects,
    imports,
    knownComponents,
    materiality,
    sourceFile,
    stateFlow,
    states,
    usageByState,
  } = analysis;
  const {
    companionWrites,
    effectStateScopes,
    safeCommandStates,
    statesWithCompanionWrites,
    subtreeByState,
  } = proofs;
  const siblingRenderCuts = collectSiblingRenderCuts(analysis, proofs);
  return {
    contextClusters: findContextHeldStateClusters(analysis),
    effectDrafts: collectEffectDrafts(analysis, effectStateScopes, siblingRenderCuts),
    keyedSelections: analyzeKeyedSelections({
      states,
      usageByState,
      safeCommandStates,
      statesWithCompanionWrites,
      imports,
      childContracts,
    }),
    listenerRefClusters: findListenerRefStateClusters({ states, usageByState, effects, imports }),
    observableClusters: findObservableStateClusters(states, {
      childContracts,
      knownComponents,
      materiality,
      sourceFile,
      stateFlow,
      usageByState,
    }),
    siblingRenderCuts,
    subtreeClusters: findStateSubtreeClusters(subtreeByState, companionWrites),
  };
}

function collectEffectDrafts(
  analysis: SourceAnalysis,
  scopes: OwnershipProofs["effectStateScopes"],
  siblingRenderCuts: ClusterProofs["siblingRenderCuts"],
): ClusterProofs["effectDrafts"] {
  const { effects, localComponents, sourceComponents, stateFlow, states, usageByState } = analysis;
  return findEffectSynchronizedDrafts({
    effects,
    states,
    scopes,
    usageByState,
    siblingRenderCuts,
    localComponents,
    sourceComponents,
    proofs: effectDraftProofs(stateFlow),
  });
}

function collectSiblingRenderCuts(
  analysis: SourceAnalysis,
  proofs: CommandProofs & OwnershipProofs,
): ReadonlyMap<StateCandidate, SiblingRenderCut> {
  const { lifecycleRegions, states, usageByState } = analysis;
  const { safeCommandStates, statesWithCompanionWrites } = proofs;
  const siblingRenderCuts = new Map<StateCandidate, SiblingRenderCut>();
  for (const state of states) {
    const usage = usageByState.get(state);
    const cut =
      usage && safeCommandStates.has(state) && !statesWithCompanionWrites.has(state)
        ? siblingProducerConsumerCut(state, usage, lifecycleRegions)
        : null;
    if (cut) {
      siblingRenderCuts.set(state, cut);
    }
  }
  return siblingRenderCuts;
}
