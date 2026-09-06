import type { StateCandidate, StateCluster, StateSubtree } from "../model.js";
import type { JsxSubtreeNode } from "../../rules/deferred-reveal/jsx-subtrees.js";
import { PAIRED_CLUSTER_SIZE } from "../constants.js";
import type { StateCompanionWrites } from "../companion-writes.js";
import { closureConfinedReferences } from "../subtree/closure-confinement.js";
import { lowestCommonJsxSubtree } from "../../rules/state-proofs/jsx-subtrees.js";
import { stateSubtreeResult } from "../subtree/materiality.js";
import { subtreeClusterOwnership } from "../ast-helpers.js";

interface SubtreeCandidate {
  readonly state: StateCandidate;
  readonly subtree: StateSubtree;
}

/**
 * A co-written state only enters a group through a direct confinement proof, which shows the handler
 * writing both states moves with them; a gate or projection subtree proves nothing about the writes.
 */
function groupCandidatesBySubtree(
  subtreeByState: ReadonlyMap<StateCandidate, StateSubtree>,
  { all }: StateCompanionWrites,
): ReadonlyMap<JsxSubtreeNode, SubtreeCandidate[]> {
  const bySubtree = new Map<JsxSubtreeNode, SubtreeCandidate[]>();
  for (const [state, subtree] of subtreeByState) {
    if (all.has(state) && subtree.kind !== "direct") {
      continue;
    }
    const members = bySubtree.get(subtree.node) ?? [];
    members.push({ state, subtree });
    bySubtree.set(subtree.node, members);
  }
  return bySubtree;
}

/**
 * A state written alongside a group member joins the group when its own references, and the
 * declarations holding them, are confined to the same subtree node; the handler that writes both
 * then moves into the leaf with them.
 */
function confinedPartner(partner: StateCandidate, node: JsxSubtreeNode): SubtreeCandidate | null {
  const confined = closureConfinedReferences(partner);
  if (!confined || lowestCommonJsxSubtree(confined.nodes, partner.owner) !== node) {
    return null;
  }
  return {
    state: partner,
    subtree: stateSubtreeResult("direct", node, {
      movedDeclarations: confined.movedDeclarations,
      renderNodes: confined.nodes,
      state: partner,
    }),
  };
}

function withConfinedPartners(
  candidates: readonly SubtreeCandidate[],
  node: JsxSubtreeNode,
  { partners }: StateCompanionWrites,
): readonly SubtreeCandidate[] {
  const members = new Map(candidates.map((candidate) => [candidate.state, candidate]));
  const pending = candidates.flatMap((candidate) => [...(partners.get(candidate.state) ?? [])]);
  while (pending.length > 0) {
    const partner = pending.pop()!;
    const candidate = members.has(partner) ? null : confinedPartner(partner, node);
    if (candidate) {
      members.set(partner, candidate);
      pending.push(...(partners.get(partner) ?? []));
    }
  }
  return [...members.values()];
}

function companionsStayInside(
  candidates: readonly SubtreeCandidate[],
  { partners }: StateCompanionWrites,
): boolean {
  const members = new Set(candidates.map((candidate) => candidate.state));
  return candidates.every((candidate) =>
    [...(partners.get(candidate.state) ?? [])].every((partner) => members.has(partner)),
  );
}

export function findStateSubtreeClusters(
  subtreeByState: ReadonlyMap<StateCandidate, StateSubtree>,
  companionWrites: StateCompanionWrites,
): ReadonlyMap<StateCandidate, StateCluster> {
  const result = new Map<StateCandidate, StateCluster>();
  for (const [node, grouped] of groupCandidatesBySubtree(subtreeByState, companionWrites)) {
    const candidates = withConfinedPartners(grouped, node, companionWrites);
    if (
      candidates.length < PAIRED_CLUSTER_SIZE ||
      !companionsStayInside(candidates, companionWrites)
    ) {
      continue;
    }
    const cluster = subtreeCluster(candidates);
    for (const member of cluster.members) {
      result.set(member, cluster);
    }
  }
  return result;
}

function subtreeCluster(candidates: readonly SubtreeCandidate[]): StateCluster {
  const first = candidates[0]!;
  const members = candidates.map((candidate) => candidate.state);
  const names = members.map((member) => member.valueName);
  const repeated = candidates.some((candidate) => candidate.subtree.repeated);
  const needsObservable =
    repeated ||
    candidates.some(
      (candidate) => candidate.subtree.unstable || candidate.subtree.kind !== "direct",
    );
  const ownership = subtreeClusterOwnership(repeated, needsObservable);
  return {
    action: needsObservable ? "use-observable" : "move-state-down",
    id: `state-cluster:subtree:${first.state.owner.getStart()}:${first.subtree.node.getStart()}:${names.join(",")}`,
    members,
    message: `Extract the ${first.subtree.label} subtree at line ${first.subtree.line}; ${ownership} for the confined state cluster (${names.map((name) => `\`${name}\``).join(", ")}).`,
    primary: members[0]!,
  };
}
