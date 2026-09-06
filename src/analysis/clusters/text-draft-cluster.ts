import type { SetterMutation, StateCandidate } from "../model.js";
import { callSetsLiteral, mutationsMayCoexecute, mutationsWriteTogether } from "../mutations.js";
import { findAncestorUntil, visit } from "../../core/ast.js";
import {
  isControlledInteractionProp,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { ClusterMemberContext } from "./observable-clusters.js";
import type { ClusterPairUsage } from "./cluster-pairs.js";
import { MIN_REPEATED_SETTER_CALLS } from "../constants.js";
import type { StateFlowIndex } from "../../project/state-flow/state-flow.js";
import { callbackIsEventRooted } from "../../rules/state-proofs/event-roots.js";
import { distinctClusterPair } from "./cluster-pairs.js";
import { hasStateInitializer } from "../../rules/deferred-reveal/deferred-reveal.js";
import { jsxOpeningForAttribute } from "../callbacks/local-callbacks.js";
import { stateMayHoldCallable } from "../../rules/state-proofs/state-proofs.js";
import ts from "typescript";

function textDraftUsageIsIsolated(
  cursor: StateCandidate,
  draft: StateCandidate,
  { firstUsage: cursorUsage, secondUsage: draftUsage }: ClusterPairUsage,
): boolean {
  if (!cursorUsage || !draftUsage) {
    return false;
  }
  return (
    ![cursorUsage, draftUsage].some(
      (usage) =>
        usage.shadowed ||
        usage.escaped ||
        usage.effectReads > 0 ||
        usage.effectWrites > 0 ||
        usage.setterUsesPreviousValue,
    ) &&
    !stateMayHoldCallable(cursor) &&
    !stateMayHoldCallable(draft) &&
    cursorUsage.localRenderReads + cursorUsage.transportedOccurrences > 0 &&
    draftUsage.localRenderReads + draftUsage.transportedOccurrences > 0 &&
    cursorUsage.setterReferences === cursorUsage.setterCalls &&
    setterReferencesAreCallsOrControlledValueWrites(draft)
  );
}

export function normalizeObservableTextDraftClusterMembers(
  members: readonly StateCandidate[],
  { mutations, stateFlow, usageByState }: ClusterMemberContext,
): readonly StateCandidate[] | null {
  const pair = distinctClusterPair(
    members,
    (state) => hasStateInitializer(state, ts.SyntaxKind.NullKeyword),
    (state) => hasEmptyStringStateInitializer(state),
  );
  if (!pair) {
    return null;
  }
  const { first: cursor, second: draft } = pair;
  if (
    !textDraftUsageIsIsolated(cursor, draft, {
      firstUsage: usageByState.get(cursor),
      secondUsage: usageByState.get(draft),
    })
  ) {
    return null;
  }
  const cursorMutations = mutations.filter((mutation) => mutation.state === cursor);
  const draftMutations = mutations.filter((mutation) => mutation.state === draft);
  return textDraftMutationsPairCursorWithDraft(cursorMutations, draftMutations, {
    cursor,
    draft,
    stateFlow,
  })
    ? [cursor, draft]
    : null;
}

interface TextDraftPairScope {
  readonly cursor: StateCandidate;
  readonly draft: StateCandidate;
  readonly stateFlow: StateFlowIndex;
}

function textDraftMutationsPairCursorWithDraft(
  cursorMutations: readonly SetterMutation[],
  draftMutations: readonly SetterMutation[],
  { cursor, draft, stateFlow }: TextDraftPairScope,
): boolean {
  const cursorClears = cursorMutations.filter((mutation) =>
    callSetsLiteral(mutation, ts.SyntaxKind.NullKeyword),
  );
  const cursorOpens = cursorMutations.filter(
    (mutation) => !callSetsLiteral(mutation, ts.SyntaxKind.NullKeyword),
  );
  if (
    cursorMutations.length < MIN_REPEATED_SETTER_CALLS ||
    draftMutations.length === 0 ||
    cursorClears.length === 0 ||
    cursorOpens.length === 0
  ) {
    return false;
  }
  const coexecutes = (left: SetterMutation, right: SetterMutation): boolean =>
    mutationsWriteTogether(left, right, stateFlow);
  if (
    cursorOpens.some(
      (cursorMutation) =>
        !draftMutations.some((draftMutation) => coexecutes(cursorMutation, draftMutation)),
    ) ||
    cursorClears.some((mutation) => !mutationIsEventRooted(mutation, cursor)) ||
    cursorMutations.some((cursorMutation) =>
      draftMutations.some(
        (draftMutation) =>
          cursorMutation.region === draftMutation.region &&
          mutationsMayCoexecute(cursorMutation.call, draftMutation.call, {
            region: cursorMutation.region,
            stateFlow,
          }) &&
          !coexecutes(cursorMutation, draftMutation),
      ),
    )
  ) {
    return false;
  }
  return draftMutations.every(
    (draftMutation) =>
      cursorMutations.some((cursorMutation) => coexecutes(draftMutation, cursorMutation)) ||
      controlledValueSetterCall(draftMutation.call, draft) ||
      mutationIsEventRooted(draftMutation, draft),
  );
}

function hasEmptyStringStateInitializer(state: StateCandidate): boolean {
  const [initializer] = state.call.arguments;
  if (!initializer) {
    return false;
  }
  const value = unwrapTransparentExpression(initializer);
  return ts.isStringLiteral(value) && value.text === "";
}

function setterReferencesAreCallsOrControlledValueWrites(state: StateCandidate): boolean {
  if (!state.setterName) {
    return false;
  }
  let controlledWrites = 0;
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.setterName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const classification = classifyControlledSetterReference(node, state);
    if (classification === "unsafe") {
      safe = false;
      return;
    }
    if (classification === "controlled-write") {
      controlledWrites += 1;
    }
  });
  return safe && controlledWrites > 0;
}

type ControlledSetterReference = "controlled-write" | "ignored" | "unsafe";

function classifyControlledSetterReference(
  node: ts.Identifier,
  state: StateCandidate,
): ControlledSetterReference {
  const attribute = controlledValueWriteAttribute(node, state);
  if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
    return attribute ? "controlled-write" : "ignored";
  }
  if (!attribute || !isDirectJsxAttributeExpression(attribute, node)) {
    return "unsafe";
  }
  return "controlled-write";
}

function controlledValueWriteAttribute(
  node: ts.Identifier,
  state: StateCandidate,
): ts.JsxAttribute | null {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
  if (!attribute || !isControlledInteractionProp(attribute.name.getText())) {
    return null;
  }
  const opening = jsxOpeningForAttribute(attribute);
  const hasValue = opening?.attributes.properties.some((property) => {
    if (
      !ts.isJsxAttribute(property) ||
      property.name.getText() !== "value" ||
      !property.initializer ||
      !ts.isJsxExpression(property.initializer) ||
      !property.initializer.expression
    ) {
      return false;
    }
    const value = unwrapTransparentExpression(property.initializer.expression);
    return ts.isIdentifier(value) && value.text === state.valueName;
  });
  return hasValue ? attribute : null;
}

function controlledValueSetterCall(call: ts.CallExpression, state: StateCandidate): boolean {
  return (
    ts.isIdentifier(call.expression) &&
    controlledValueWriteAttribute(call.expression, state) !== null
  );
}

export function mutationIsEventRooted(mutation: SetterMutation, state: StateCandidate): boolean {
  const { region } = mutation;
  return (
    region !== state.owner &&
    (ts.isArrowFunction(region) ||
      ts.isFunctionDeclaration(region) ||
      ts.isFunctionExpression(region)) &&
    callbackIsEventRooted({
      callback: region,
      owner: state.owner,
      dependencyName: "",
      seen: new Set(),
    })
  );
}
