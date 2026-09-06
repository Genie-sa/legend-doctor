import type { SetterMutation, StateCandidate, StateUsage } from "../model.js";
import { callSetsLiteral, mutationsWriteTogether } from "../mutations.js";
import {
  setterCallUsesPreviousValue,
  stateMayHoldCallable,
} from "../../rules/state-proofs/state-proofs.js";
import type { ClusterMemberContext } from "./observable-clusters.js";
import type { ClusterPairUsage } from "./cluster-pairs.js";
import { MIN_REPEATED_SETTER_CALLS } from "../constants.js";
import type { StateFlowIndex } from "../../project/state-flow/state-flow.js";
import { distinctClusterPair } from "./cluster-pairs.js";
import { findAncestorUntil } from "../../core/ast.js";
import { hasStateInitializer } from "../../rules/deferred-reveal/deferred-reveal.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

function selectionModeUsageIsIsolated(
  mode: StateCandidate,
  selection: StateCandidate,
  { firstUsage: modeUsage, secondUsage: selectionUsage }: ClusterPairUsage,
): boolean {
  if (!modeUsage || !selectionUsage) {
    return false;
  }
  return (
    ![modeUsage, selectionUsage].some(
      (usage) => usage.shadowed || usage.escaped || usage.effectReads > 0 || usage.effectWrites > 0,
    ) &&
    !modeUsage.setterUsesPreviousValue &&
    !stateMayHoldCallable(mode) &&
    !stateMayHoldCallable(selection) &&
    modeUsage.setterReferences === modeUsage.setterCalls &&
    selectionUsage.setterReferences === selectionUsage.setterCalls &&
    renderReadsStayInJsxAttributes(mode, modeUsage) &&
    renderReadsStayInJsxAttributes(selection, selectionUsage)
  );
}

function selectionMutationsToggleAndReset(
  modeMutations: readonly SetterMutation[],
  selectionMutations: readonly SetterMutation[],
  resets: readonly SetterMutation[],
): boolean {
  const edits = selectionMutations.filter((mutation) => !callSetsEmptyArray(mutation));
  return (
    modeMutations.length >= MIN_REPEATED_SETTER_CALLS &&
    resets.length > 0 &&
    edits.length > 0 &&
    modeMutations.some((mutation) => callSetsLiteral(mutation, ts.SyntaxKind.TrueKeyword)) &&
    modeMutations.some((mutation) => callSetsLiteral(mutation, ts.SyntaxKind.FalseKeyword)) &&
    edits.every((mutation) => setterCallUsesPreviousValue(mutation.call))
  );
}

export function normalizeObservableSelectionClusterMembers(
  members: readonly StateCandidate[],
  { mutations, stateFlow, usageByState }: ClusterMemberContext,
): readonly StateCandidate[] | null {
  const pair = distinctClusterPair(
    members,
    (state) => hasStateInitializer(state, ts.SyntaxKind.FalseKeyword),
    (state) => hasEmptyArrayStateInitializer(state),
  );
  if (!pair) {
    return null;
  }
  const { first: mode, second: selection } = pair;
  if (
    !selectionModeUsageIsIsolated(mode, selection, {
      firstUsage: usageByState.get(mode),
      secondUsage: usageByState.get(selection),
    })
  ) {
    return null;
  }
  const modeMutations = mutations.filter((mutation) => mutation.state === mode);
  const selectionMutations = mutations.filter((mutation) => mutation.state === selection);
  return selectionModeWritesPairWithResets(modeMutations, selectionMutations, stateFlow)
    ? [mode, selection]
    : null;
}

function selectionModeWritesPairWithResets(
  modeMutations: readonly SetterMutation[],
  selectionMutations: readonly SetterMutation[],
  stateFlow: StateFlowIndex,
): boolean {
  const resets = selectionMutations.filter((mutation) => callSetsEmptyArray(mutation));
  if (!selectionMutationsToggleAndReset(modeMutations, selectionMutations, resets)) {
    return false;
  }
  return modeMutations.every((modeMutation) =>
    resets.some((reset) => mutationsWriteTogether(modeMutation, reset, stateFlow)),
  );
}

function hasEmptyArrayStateInitializer(state: StateCandidate): boolean {
  const [initializer] = state.call.arguments;
  if (!initializer) {
    return false;
  }
  const value = unwrapTransparentExpression(initializer);
  return ts.isArrayLiteralExpression(value) && value.elements.length === 0;
}

function callSetsEmptyArray(mutation: SetterMutation): boolean {
  const [argument] = mutation.call.arguments;
  if (!argument) {
    return false;
  }
  const value = unwrapTransparentExpression(argument);
  return ts.isArrayLiteralExpression(value) && value.elements.length === 0;
}

function renderReadsStayInJsxAttributes(state: StateCandidate, usage: StateUsage): boolean {
  return (
    usage.localRenderReads + usage.transportedOccurrences > 0 &&
    usage.directRenderNodes.every(
      (node) => findAncestorUntil(node, ts.isJsxAttribute, state.owner) !== null,
    )
  );
}
