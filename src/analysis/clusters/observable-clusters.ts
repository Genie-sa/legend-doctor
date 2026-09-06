import { COMPACT_OWNER_JSX_ELEMENTS, LARGE_OWNER_LINE_SPAN } from "../constants.js";
import type { SetterMutation, StateCandidate, StateCluster, StateUsage } from "../model.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import { DisjointSet } from "./disjoint-set.js";
import type { MaterialityPolicy } from "../constants.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateFlowIndex } from "../../project/state-flow/state-flow.js";
import { collectSetterMutations } from "../companion-writes.js";
import { jsxElementCount } from "../../rules/state-proofs/jsx-subtrees.js";
import { mutationsAreProvenCoexecuting } from "../mutations.js";
import { normalizeGatedFeedbackClusterMembers } from "./gated-feedback-cluster.js";
import { normalizeObservableDialogClusterMembers } from "./dialog-cluster.js";
import { normalizeObservableSelectionClusterMembers } from "./selection-cluster.js";
import { normalizeObservableTextDraftClusterMembers } from "./text-draft-cluster.js";
import { normalizePersistentScalarDialogClusterMembers } from "./scalar-dialog-cluster.js";
import { ownerLineSpan } from "../ast-helpers.js";
import { stateHasBoundedDialogGate } from "../dialog/dialog-gates.js";
import type ts from "typescript";

type ObservableClusterKind =
  | "dialog"
  | "gated-feedback"
  | "persistent-dialog"
  | "selection"
  | "text-draft";

interface ObservableClusterMembers {
  readonly gatedFeedbackMembers: readonly StateCandidate[] | null;
  readonly hasBoundedDialogGate: boolean;
  readonly selectionMembers: readonly StateCandidate[] | null;
  readonly textDraftMembers: readonly StateCandidate[] | null;
}

function observableClusterKind(members: ObservableClusterMembers): ObservableClusterKind {
  if (members.selectionMembers) {
    return "selection";
  }
  if (members.gatedFeedbackMembers) {
    return "gated-feedback";
  }
  if (members.textDraftMembers) {
    return "text-draft";
  }
  return members.hasBoundedDialogGate ? "persistent-dialog" : "dialog";
}

function stateClusterMessage(
  kind: ObservableClusterKind,
  names: readonly string[],
  targets: ReadonlySet<string>,
): string {
  const quoted = names.map((name) => `\`${name}\``).join(", ");
  const targetList = [...targets].toSorted().join(", ");
  if (kind === "selection") {
    return `Replace the co-written selection mode (${quoted}) with one component-lifetime observable object; preserve mode-and-clear transitions with atomic \`assign\` calls, keep independent collection edits as leaf writes, snapshot command reads with \`peek\`, and subscribe with \`useValue\` only at header, control, and keyed-row leaves.`;
  }
  if (kind === "gated-feedback") {
    return `Replace the payload and timed feedback state (${quoted}) with one component-lifetime observable model; preserve the timer and command timing, batch the paired reset, read the payload command with \`peek\`, subscribe to the payload-gated content at its stable call site, and subscribe to feedback again only in its nested feedback leaf.`;
  }
  return dialogClusterMessage(kind, quoted, targetList);
}

function dialogClusterMessage(
  kind: ObservableClusterKind,
  quoted: string,
  targetList: string,
): string {
  if (kind === "text-draft") {
    return `Replace the co-written editable draft (${quoted}) with one component-lifetime observable object; preserve cursor-and-name transitions with atomic \`assign\` calls, keep controlled name edits as leaf writes, snapshot command reads with \`peek\`, and subscribe with \`useValue\` only at the rendered row or control leaves.`;
  }
  if (kind === "persistent-dialog") {
    return `Replace the persistent dialog state (${quoted}) with one component-lifetime observable model; atomically assign the payload and open flag, keep close transitions as leaf writes, and move the complete payload gate plus ${targetList} into one always-mounted stable leaf wrapper. Subscribe there with \`useValue\` so the existing payload gate and dialog mount behavior stay unchanged.`;
  }
  return `Replace the co-written React state cluster (${quoted}) with one component-lifetime observable dialog model; preserve paired payload/open transitions with atomic \`assign\` calls, keep independent close updates as leaf writes, and subscribe with \`useValue\` only inside ${targetList}.`;
}

export interface ClusterAnalysisContext {
  readonly childContracts: ChildContractResolver | null;
  readonly knownComponents: ReadonlySet<string>;
  readonly materiality: MaterialityPolicy;
  readonly sourceFile: ts.SourceFile;
  readonly stateFlow: StateFlowIndex;
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

export interface ClusterMemberContext extends ClusterAnalysisContext {
  readonly mutations: readonly SetterMutation[];
}

export function groupStatesByOwner(
  states: readonly StateCandidate[],
): ReadonlyMap<RuntimeFunctionLike, StateCandidate[]> {
  const byOwner = new Map<RuntimeFunctionLike, StateCandidate[]>();
  for (const state of states) {
    const ownerStates = byOwner.get(state.owner) ?? [];
    ownerStates.push(state);
    byOwner.set(state.owner, ownerStates);
  }
  return byOwner;
}

function coexecutingStateComponents(
  mutableStates: readonly StateCandidate[],
  calls: readonly SetterMutation[],
  stateFlow: StateFlowIndex,
): readonly StateCandidate[][] {
  const union = new DisjointSet(mutableStates.length);
  for (const pair of provenCoexecutingMutationPairs(calls, stateFlow)) {
    joinStateIndexes(union, mutableStates, pair);
  }
  return union.groups(mutableStates);
}

function joinStateIndexes(
  union: DisjointSet,
  mutableStates: readonly StateCandidate[],
  [left, right]: readonly [SetterMutation, SetterMutation],
): void {
  const leftIndex = mutableStates.indexOf(left.state);
  const rightIndex = mutableStates.indexOf(right.state);
  if (leftIndex !== -1 && rightIndex !== -1) {
    union.join(leftIndex, rightIndex);
  }
}

function provenCoexecutingMutationPairs(
  calls: readonly SetterMutation[],
  stateFlow: StateFlowIndex,
): readonly (readonly [SetterMutation, SetterMutation])[] {
  const pairs: (readonly [SetterMutation, SetterMutation])[] = [];
  for (const [leftIndex, left] of calls.entries()) {
    for (const right of calls.slice(leftIndex + 1)) {
      if (
        left.state !== right.state &&
        left.region === right.region &&
        mutationsAreProvenCoexecuting(left.call, right.call, { region: left.region, stateFlow })
      ) {
        pairs.push([left, right]);
      }
    }
  }
  return pairs;
}

function registerObservableCluster(
  members: readonly StateCandidate[],
  clusterContext: OwnerClusterContext,
  result: Map<StateCandidate, StateCluster>,
): void {
  const cluster = observableCluster(members, clusterContext);
  for (const member of cluster?.members ?? []) {
    if (cluster) {
      result.set(member, cluster);
    }
  }
}

export function findObservableStateClusters(
  states: readonly StateCandidate[],
  context: ClusterAnalysisContext,
): ReadonlyMap<StateCandidate, StateCluster> {
  const result = new Map<StateCandidate, StateCluster>();
  for (const ownerEntry of groupStatesByOwner(states)) {
    registerOwnerClusters(ownerEntry, context, result);
  }
  return result;
}

function registerOwnerClusters(
  [owner, ownerStates]: readonly [RuntimeFunctionLike, readonly StateCandidate[]],
  context: ClusterAnalysisContext,
  result: Map<StateCandidate, StateCluster>,
): void {
  const scale = ownerClusterScale(owner, context);
  if (!scale) {
    return;
  }
  const mutableStates = ownerStates.filter((state) => state.setterName !== null);
  const calls = collectSetterMutations(owner, mutableStates);
  const clusterContext: OwnerClusterContext = { ...context, mutations: calls, owner, scale };
  for (const members of coexecutingStateComponents(mutableStates, calls, context.stateFlow)) {
    registerObservableCluster(members, clusterContext, result);
  }
}

interface OwnerClusterScale {
  readonly broadOwner: boolean;
  readonly hasLargeSourceOwner: boolean;
}

function ownerClusterScale(
  owner: RuntimeFunctionLike,
  { materiality, sourceFile }: ClusterAnalysisContext,
): OwnerClusterScale | null {
  const ownerElements = jsxElementCount(owner);
  if (ownerElements < COMPACT_OWNER_JSX_ELEMENTS) {
    return null;
  }
  return {
    broadOwner: ownerElements >= materiality.broadOwnerJsx,
    hasLargeSourceOwner: ownerLineSpan(owner, sourceFile) >= LARGE_OWNER_LINE_SPAN,
  };
}

interface NormalizedClusterMembers extends ObservableClusterMembers {
  readonly dialogMembers: readonly StateCandidate[] | null;
}

function normalizeClusterMembers(
  members: readonly StateCandidate[],
  context: ClusterMemberContext,
  { broadOwner, hasLargeSourceOwner }: OwnerClusterScale,
): NormalizedClusterMembers {
  const dialogMembers =
    broadOwner && hasLargeSourceOwner
      ? (normalizeObservableDialogClusterMembers(members, context) ??
        normalizePersistentScalarDialogClusterMembers(members, context))
      : null;
  const gatedFeedbackMembers =
    broadOwner && !dialogMembers ? normalizeGatedFeedbackClusterMembers(members, context) : null;
  const textDraftMembers =
    broadOwner && hasLargeSourceOwner && !dialogMembers && !gatedFeedbackMembers
      ? normalizeObservableTextDraftClusterMembers(members, context)
      : null;
  const selectionMembers =
    hasLargeSourceOwner && !dialogMembers && !gatedFeedbackMembers && !textDraftMembers
      ? normalizeObservableSelectionClusterMembers(members, context)
      : null;
  return {
    dialogMembers,
    gatedFeedbackMembers,
    hasBoundedDialogGate:
      dialogMembers?.some((state) => stateHasBoundedDialogGate(state, dialogMembers, context)) ??
      false,
    selectionMembers,
    textDraftMembers,
  };
}

function ownerOnlyRenderReadRemains(
  clusterMembers: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
): boolean {
  return clusterMembers.some((member) => {
    const usage = usageByState.get(member);
    return usage !== undefined && usage.localRenderReads > 0 && usage.jsxTargets.size === 0;
  });
}

interface OwnerClusterContext extends ClusterMemberContext {
  readonly owner: RuntimeFunctionLike;
  readonly scale: OwnerClusterScale;
}

function observableCluster(
  members: readonly StateCandidate[],
  clusterContext: OwnerClusterContext,
): StateCluster | null {
  const { owner, scale, ...context } = clusterContext;
  const normalized = normalizeClusterMembers(members, context, scale);
  const clusterMembers =
    normalized.dialogMembers ??
    normalized.gatedFeedbackMembers ??
    normalized.textDraftMembers ??
    normalized.selectionMembers;
  if (
    !clusterMembers ||
    (normalized.dialogMembers &&
      !normalized.hasBoundedDialogGate &&
      ownerOnlyRenderReadRemains(clusterMembers, context.usageByState))
  ) {
    return null;
  }
  const sortedMembers = clusterMembers.toSorted(
    (left, right) => left.call.getStart() - right.call.getStart(),
  );
  const [primary] = sortedMembers;
  return primary
    ? observableClusterFor(sortedMembers, primary, { normalized, owner, ...context })
    : null;
}

interface ObservableClusterScope extends ClusterMemberContext {
  readonly normalized: NormalizedClusterMembers;
  readonly owner: RuntimeFunctionLike;
}

function observableClusterFor(
  sortedMembers: readonly StateCandidate[],
  primary: StateCandidate,
  { normalized, owner, sourceFile, usageByState }: ObservableClusterScope,
): StateCluster {
  const names = sortedMembers.map((state) => state.valueName);
  return {
    action: "use-observable",
    id: `state-cluster:${owner.getStart(sourceFile)}:${names.join(",")}`,
    members: sortedMembers,
    message: stateClusterMessage(
      observableClusterKind(normalized),
      names,
      transportTargetsOf(sortedMembers, usageByState),
    ),
    primary,
  };
}

function transportTargetsOf(
  members: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
): ReadonlySet<string> {
  return new Set(members.flatMap((state) => [...(usageByState.get(state)?.jsxTargets ?? [])]));
}
