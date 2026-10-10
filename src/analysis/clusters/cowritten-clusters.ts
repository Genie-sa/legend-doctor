import { COMPACT_OWNER_JSX_ELEMENTS, PAIRED_CLUSTER_SIZE } from "../constants.js";
import type { ClassifiedState, SetterMutation, StateCandidate, StateCluster } from "../model.js";
import { collectSetterMutations, groupSettableStatesByOwner } from "../companion-writes.js";
import { DisjointSet } from "./disjoint-set.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateFlowIndex } from "../../project/state-flow/state-flow.js";
import { cowrittenEdit } from "./cowritten-edit.js";
import { isCustomHookOwner } from "../ast-helpers.js";
import { jsxElementCount } from "../../rules/state-proofs/jsx-subtrees.js";
import { stateTypeIsPrimitive } from "../../rules/state-proofs/state-proofs.js";
import type ts from "typescript";

export interface CowrittenClusterScope {
  /** Classifies one state as if no other React state were written alongside it. */
  readonly classifyAlone: (state: StateCandidate) => ClassifiedState;
  readonly hasCustomHookPresentationConsumer: (state: StateCandidate) => boolean;
  readonly sourceFile: ts.SourceFile;
  readonly stateFlow: StateFlowIndex;
  readonly subscriptionHook: string;
}

type CoexecutionPair = readonly [SetterMutation, SetterMutation];

interface OwnerCoexecution {
  readonly possible: readonly CoexecutionPair[];
  readonly proven: readonly CoexecutionPair[];
}

interface ClosedClusterQuery {
  readonly hookOwned: boolean;
  readonly members: readonly StateCandidate[];
  readonly mutations: readonly SetterMutation[];
  readonly proven: readonly CoexecutionPair[];
  readonly scope: CowrittenClusterScope;
}

interface CowrittenClusterQuery {
  readonly hookOwned: boolean;
  readonly memberMessages: ReadonlyMap<StateCandidate, string>;
  readonly members: readonly StateCandidate[];
  readonly mutations: readonly SetterMutation[];
  readonly scope: CowrittenClusterScope;
}

/**
 * States that a handler writes together block each other's single-state proofs: migrating one while
 * a companion stays in React leaves the owner render in place. When every state that can possibly be
 * written alongside a member is itself a member, and each member alone would earn an observable
 * verdict, the whole closed group migrates as one observable object and the owner render goes away.
 */
export function findCowrittenStateClusters(
  states: readonly StateCandidate[],
  scope: CowrittenClusterScope,
): ReadonlyMap<StateCandidate, StateCluster> {
  const result = new Map<StateCandidate, StateCluster>();
  for (const [owner, ownerStates] of groupSettableStatesByOwner(states)) {
    for (const cluster of ownerClusters(owner, ownerStates, scope)) {
      for (const member of cluster.members) {
        result.set(member, cluster);
      }
    }
  }
  return result;
}

function ownerClusters(
  owner: RuntimeFunctionLike,
  ownerStates: readonly StateCandidate[],
  scope: CowrittenClusterScope,
): readonly StateCluster[] {
  const hookOwned = isCustomHookOwner(owner);
  if (jsxElementCount(owner) < COMPACT_OWNER_JSX_ELEMENTS && !hookOwned) {
    return [];
  }
  const mutations = collectSetterMutations(owner, ownerStates);
  const coexecution = ownerCoexecution(mutations, scope.stateFlow);
  const union = new DisjointSet(ownerStates.length);
  for (const [left, right] of coexecution.possible) {
    union.join(ownerStates.indexOf(left.state), ownerStates.indexOf(right.state));
  }
  return union
    .groups(ownerStates)
    .filter((members) => members.length >= PAIRED_CLUSTER_SIZE)
    .flatMap(
      (members) =>
        closedClusterFor({
          hookOwned,
          members,
          mutations: mutations.filter((mutation) => members.includes(mutation.state)),
          proven: coexecution.proven,
          scope,
        }) ?? [],
    );
}

function ownerCoexecution(
  mutations: readonly SetterMutation[],
  stateFlow: StateFlowIndex,
): OwnerCoexecution {
  const possible: CoexecutionPair[] = [];
  const proven: CoexecutionPair[] = [];
  for (const [leftIndex, left] of mutations.entries()) {
    for (const right of mutations.slice(leftIndex + 1)) {
      const proof = pairProof(left, right, stateFlow);
      if (proof !== "disproven") {
        possible.push([left, right]);
      }
      if (proof === "proven") {
        proven.push([left, right]);
      }
    }
  }
  return { possible, proven };
}

function pairProof(
  left: SetterMutation,
  right: SetterMutation,
  stateFlow: StateFlowIndex,
): "disproven" | "proven" | "unknown" {
  if (left.state === right.state || left.region !== right.region) {
    return "disproven";
  }
  return stateFlow.proveSynchronousCoexecution(left.region, left.call, right.call);
}

function closedClusterFor({
  hookOwned,
  members,
  mutations,
  proven,
  scope,
}: ClosedClusterQuery): StateCluster | null {
  if (
    !keepsCommitPoints(members, proven) ||
    (hookOwned && !members.every((member) => scope.hasCustomHookPresentationConsumer(member)))
  ) {
    return null;
  }
  const memberMessages = new Map<StateCandidate, string>();
  for (const member of members) {
    const alone = scope.classifyAlone(member);
    if (alone.action !== "use-observable") {
      return null;
    }
    memberMessages.set(member, alone.message);
  }
  return cowrittenCluster({ hookOwned, memberMessages, members, mutations, scope });
}

/**
 * Once every member is observable, each synchronous stretch still publishes in one render and a
 * stretch an await splits stays split, so the group keeps React's commit points even where the
 * flow cannot resolve whether two writes coexecute. Without a proven companion for each member,
 * only primitive members qualify: Legend skips notifying an equal object replacement.
 */
function keepsCommitPoints(
  members: readonly StateCandidate[],
  proven: readonly CoexecutionPair[],
): boolean {
  return (
    members.every((member) => hasProvenCompanion(member, proven)) ||
    members.every((member) => stateTypeIsPrimitive(member))
  );
}

function hasProvenCompanion(state: StateCandidate, proven: readonly CoexecutionPair[]): boolean {
  return proven.some(([left, right]) => left.state === state || right.state === state);
}

/** The shared instruction every member of a co-written group carries. */
export function cowrittenGroupIntro(names: readonly string[], hookOwned: boolean): string {
  const quoted = names.map((name) => `\`${name}\``).join(", ");
  const lifetime = hookOwned ? "hook-lifetime" : "component-lifetime";
  return `Replace the co-written React states (${quoted}) with one ${lifetime} observable object; preserve each synchronous transition with \`batch\` around the original ordered writes, or one atomic \`assign\` for adjacent independent literal replacements. Keep single-member writes as leaf \`set\` calls. Preserve branches, throwing expressions, and every await/catch/finally boundary; never batch an async function or move writes between execution phases.`;
}

function cowrittenCluster({
  hookOwned,
  memberMessages,
  members,
  mutations,
  scope,
}: CowrittenClusterQuery): StateCluster {
  const { sourceFile, stateFlow, subscriptionHook } = scope;
  const sorted = members.toSorted((left, right) => left.call.getStart() - right.call.getStart());
  const [primary] = sorted;
  const names = sorted.map((state) => state.valueName);
  const edit = cowrittenEdit({
    members: sorted,
    mutations,
    sourceFile,
    stateFlow,
    subscriptionHook,
  });
  const intro = `${cowrittenGroupIntro(names, hookOwned)} ${edit}`;
  return {
    action: "use-observable",
    id: `state-cluster:cowritten:${primary!.owner.getStart(sourceFile)}:${names.join(",")}`,
    memberMessages: new Map(
      sorted.map((state) => [
        state,
        `${intro} For \`${state.valueName}\`: ${memberMessages.get(state) ?? ""}`,
      ]),
    ),
    members: sorted,
    message: intro,
    primary: primary!,
  };
}
