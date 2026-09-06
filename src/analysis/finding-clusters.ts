import type { ClassifiedState, StateCandidate, StateCluster } from "./model.js";
import type { HookFinding } from "../core/types.js";
import type { StateAnalysisResult } from "./proofs/contracts.js";
import { findCowrittenStateClusters } from "./clusters/cowritten-clusters.js";
import { hookPresentationConsumerForState } from "./verdicts/small-owner-verdicts.js";

export interface FindingsScope extends StateAnalysisResult {
  /** Classifies one state as if no other React state were written alongside it. */
  readonly classifyAlone: (state: StateCandidate) => ClassifiedState;
  readonly cowrittenClusters: ReadonlyMap<StateCandidate, StateCluster>;
}

export function findingsScope(
  result: StateAnalysisResult,
  classifyAlone: (state: StateCandidate) => ClassifiedState,
): FindingsScope {
  const { analysis } = result;
  return {
    ...result,
    classifyAlone,
    cowrittenClusters: findCowrittenStateClusters(analysis.states, {
      classifyAlone,
      hasCustomHookPresentationConsumer: (state) => {
        const usage = analysis.usageByState.get(state);
        return (
          usage !== undefined &&
          hookPresentationConsumerForState({
            childContracts: analysis.childContracts,
            materiality: analysis.materiality,
            ownerIsCommitSensitive: analysis.commitSensitiveOwners.has(state.owner),
            state,
            usage,
          }) !== null
        );
      },
      sourceFile: analysis.sourceFile,
      stateFlow: analysis.stateFlow,
    }),
  };
}

export function stateClusterFor(
  state: StateCandidate,
  { clusters, cowrittenClusters }: FindingsScope,
): StateCluster | undefined {
  return (
    clusters.contextClusters.get(state) ??
    clusters.effectDrafts.clusters.get(state) ??
    clusters.listenerRefClusters.get(state) ??
    clusters.observableClusters.get(state) ??
    clusters.subtreeClusters.get(state) ??
    cowrittenClusters.get(state)
  );
}

export function clusterStateClassification(
  cluster: StateCluster | undefined,
  state: StateCandidate,
): ClassifiedState | null {
  if (!cluster) {
    return null;
  }
  return {
    action: cluster.action,
    confidence: "probable",
    message: cluster.memberMessages?.get(state) ?? cluster.message,
  };
}

export function attachClusterGroup(
  finding: HookFinding,
  state: StateCandidate,
  cluster: StateCluster | undefined,
): void {
  if (!cluster) {
    return;
  }
  finding.group = {
    id: cluster.id,
    kind: "state-cluster",
    members: cluster.members.map((member) => member.valueName),
    primary: state === cluster.primary,
  };
}
