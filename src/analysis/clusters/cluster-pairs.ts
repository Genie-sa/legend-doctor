import type { StateCandidate, StateUsage } from "../model.js";
import { PAIRED_CLUSTER_SIZE } from "../constants.js";

export interface ClusterPairUsage {
  readonly firstUsage: StateUsage | undefined;
  readonly secondUsage: StateUsage | undefined;
}

interface ClusterPair {
  readonly first: StateCandidate;
  readonly second: StateCandidate;
}

export function distinctClusterPair(
  members: readonly StateCandidate[],
  isFirst: (state: StateCandidate) => boolean,
  isSecond: (state: StateCandidate) => boolean,
): ClusterPair | null {
  if (members.length !== PAIRED_CLUSTER_SIZE) {
    return null;
  }
  const first = members.find((state) => isFirst(state));
  const second = members.find((state) => isSecond(state));
  return first && second && first !== second ? { first, second } : null;
}
