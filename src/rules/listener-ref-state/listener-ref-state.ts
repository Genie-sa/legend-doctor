import type { EffectCandidate, StateCandidate, StateUsage } from "../../analysis/model.js";
import { nearestNestedFunction, visitSkippingNestedFunctions } from "../../core/ast.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isListenerRefCandidate } from "./listener-ref-candidates.js";
import { listenerCallbacks } from "./listener-callbacks.js";
import { mutationRegionOnlyCallsStateSetters } from "../effect-drafts/draft-mutations.js";
import { regionIsSynchronousEvent } from "./synchronous-regions.js";
import ts from "typescript";

const MINIMUM_CLUSTER_MEMBERS = 2;

export interface ListenerRefStateCluster {
  action: "use-ref";
  id: string;
  members: readonly StateCandidate[];
  message: string;
  primary: StateCandidate;
}

interface OwnerScan {
  readonly effects: readonly EffectCandidate[];
  readonly imports: HookImports;
  readonly owner: RuntimeFunctionLike;
  readonly ownerStates: readonly StateCandidate[];
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

interface RegionScan {
  readonly claimed: ReadonlySet<StateCandidate>;
  readonly region: RuntimeFunctionLike;
  readonly regionMembers: ReadonlySet<StateCandidate>;
  readonly scan: OwnerScan;
  readonly stateBySetter: ReadonlyMap<string, StateCandidate>;
}

export interface ListenerRefStateScan {
  readonly effects: readonly EffectCandidate[];
  readonly imports: HookImports;
  readonly states: readonly StateCandidate[];
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

export function findListenerRefStateClusters({
  effects,
  imports,
  states,
  usageByState,
}: ListenerRefStateScan): ReadonlyMap<StateCandidate, ListenerRefStateCluster> {
  const result = new Map<StateCandidate, ListenerRefStateCluster>();
  for (const [owner, ownerStates] of groupByOwner(states)) {
    for (const [state, cluster] of ownerClusters({
      effects,
      imports,
      owner,
      ownerStates,
      usageByState,
    })) {
      result.set(state, cluster);
    }
  }
  return result;
}

function ownerClusters(scan: OwnerScan): ReadonlyMap<StateCandidate, ListenerRefStateCluster> {
  const callbacks = listenerCallbacks(scan.owner, scan.effects, scan.imports);
  if (callbacks.size === 0) {
    return new Map();
  }
  const candidates = new Set(
    scan.ownerStates.filter((state) =>
      isListenerRefCandidate(state, scan.usageByState.get(state), callbacks),
    ),
  );
  if (candidates.size < MINIMUM_CLUSTER_MEMBERS) {
    return new Map();
  }
  return clustersByRegion(scan, candidates);
}

function clustersByRegion(
  scan: OwnerScan,
  candidates: ReadonlySet<StateCandidate>,
): ReadonlyMap<StateCandidate, ListenerRefStateCluster> {
  const stateBySetter = settersByName(scan.ownerStates);
  const clusters = new Map<StateCandidate, ListenerRefStateCluster>();
  const claimed = new Set<StateCandidate>();
  for (const [region, regionMembers] of orderedCandidateRegions(scan, candidates)) {
    const cluster = regionCluster({ claimed, region, regionMembers, scan, stateBySetter });
    if (cluster) {
      recordCluster(clusters, claimed, cluster);
    }
  }
  return clusters;
}

function recordCluster(
  clusters: Map<StateCandidate, ListenerRefStateCluster>,
  claimed: Set<StateCandidate>,
  cluster: ListenerRefStateCluster,
): void {
  for (const member of cluster.members) {
    claimed.add(member);
    clusters.set(member, cluster);
  }
}

function regionCluster(scanned: RegionScan): ListenerRefStateCluster | null {
  const { claimed, region, regionMembers, scan, stateBySetter } = scanned;
  if (
    regionMembers.size < MINIMUM_CLUSTER_MEMBERS ||
    [...regionMembers].some((state) => claimed.has(state)) ||
    !regionIsSynchronousEvent(region, scan.owner) ||
    !regionWritesOnlyMembers(region, regionMembers, stateBySetter)
  ) {
    return null;
  }
  const members = [...regionMembers].toSorted(
    (left, right) => left.call.getStart() - right.call.getStart(),
  );
  const [primary] = members;
  if (!primary) {
    return null;
  }
  const names = members.map((state) => state.valueName);
  return {
    action: "use-ref",
    id: `state-cluster:listener-ref:${scan.owner.getStart()}:${names.join(",")}`,
    members,
    message: `Replace the listener-only state cluster (${names.map((name) => `\`${name}\``).join(", ")}) with refs as one migration; rewrite every read and write through \`.current\`, remove those values from memoized callback dependencies, and preserve each existing listener effect, registration target, event, guard, and cleanup.`,
    primary,
  };
}

function settersByName(
  ownerStates: readonly StateCandidate[],
): ReadonlyMap<string, StateCandidate> {
  return new Map(
    ownerStates.flatMap((state) => (state.setterName ? [[state.setterName, state] as const] : [])),
  );
}

function setterRegions(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
): readonly RuntimeFunctionLike[] {
  return usage.setterCallNodes.flatMap((call) => {
    const region = nearestNestedFunction(call, owner);
    return region && region !== owner ? [region] : [];
  });
}

function orderedCandidateRegions(
  scan: OwnerScan,
  candidates: ReadonlySet<StateCandidate>,
): readonly (readonly [RuntimeFunctionLike, ReadonlySet<StateCandidate>])[] {
  const regions = new Map<RuntimeFunctionLike, Set<StateCandidate>>();
  for (const state of candidates) {
    const usage = scan.usageByState.get(state);
    if (!usage) {
      continue;
    }
    for (const region of setterRegions(usage, scan.owner)) {
      const members = regions.get(region) ?? new Set<StateCandidate>();
      members.add(state);
      regions.set(region, members);
    }
  }
  return [...regions].toSorted(([left], [right]) => left.getStart() - right.getStart());
}

function groupByOwner(
  states: readonly StateCandidate[],
): ReadonlyMap<RuntimeFunctionLike, readonly StateCandidate[]> {
  const groups = new Map<RuntimeFunctionLike, StateCandidate[]>();
  for (const state of states) {
    const group = groups.get(state.owner) ?? [];
    group.push(state);
    groups.set(state.owner, group);
  }
  return groups;
}

function regionWritesOnlyMembers(
  region: RuntimeFunctionLike,
  members: ReadonlySet<StateCandidate>,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): boolean {
  const memberSetters = new Set(
    [...members].flatMap((state) => (state.setterName ? [state.setterName] : [])),
  );
  let safe = true;
  if (!region.body) {
    return false;
  }
  visitSkippingNestedFunctions(region.body, region, (node) => {
    if (!safe || !ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
      return;
    }
    const state = stateBySetter.get(node.expression.text);
    if (state && !members.has(state)) {
      safe = false;
    }
  });
  return safe && mutationRegionOnlyCallsStateSetters(region, memberSetters);
}
