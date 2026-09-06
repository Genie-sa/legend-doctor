import type { SetterMutation, StateCandidate } from "./model.js";
import { bindingDeclarationCount, unwrapTransparentExpression } from "../core/analysis-ast.js";
import { callSetsLiteral, mutationsMayCoexecute, nearestMutationFunction } from "./mutations.js";
import {
  findAncestorUntil,
  isRuntimeFunctionLike,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../core/ast.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import type { StateFlowIndex } from "../project/state-flow/state-flow.js";
import { isVisibilityTransitionAttribute } from "./membership-toggle.js";
import ts from "typescript";

export interface StateCompanionWrites {
  readonly all: ReadonlySet<StateCandidate>;
  readonly nonClosing: ReadonlySet<StateCandidate>;
  /** For each co-written state, every state that may be written alongside it. */
  readonly partners: ReadonlyMap<StateCandidate, ReadonlySet<StateCandidate>>;
}

export function groupSettableStatesByOwner(
  states: readonly StateCandidate[],
): ReadonlyMap<RuntimeFunctionLike, StateCandidate[]> {
  const byOwner = new Map<RuntimeFunctionLike, StateCandidate[]>();
  for (const state of states) {
    if (!state.setterName) {
      continue;
    }
    const ownerStates = byOwner.get(state.owner) ?? [];
    ownerStates.push(state);
    byOwner.set(state.owner, ownerStates);
  }
  return byOwner;
}

interface CompanionWriteSinks {
  readonly all: Set<StateCandidate>;
  readonly nonClosing: Set<StateCandidate>;
  readonly partners: Map<StateCandidate, Set<StateCandidate>>;
}

function recordPartner(
  partners: Map<StateCandidate, Set<StateCandidate>>,
  state: StateCandidate,
  partner: StateCandidate,
): void {
  const known = partners.get(state) ?? new Set<StateCandidate>();
  known.add(partner);
  partners.set(state, known);
}

function recordCompanionPair(
  [left, right]: readonly [SetterMutation, SetterMutation],
  { all, nonClosing, partners }: CompanionWriteSinks,
): void {
  all.add(left.state);
  all.add(right.state);
  recordPartner(partners, left.state, right.state);
  recordPartner(partners, right.state, left.state);
  if (!mutationIsProvenCloseDuringCompanion(left, right)) {
    nonClosing.add(left.state);
  }
  if (!mutationIsProvenCloseDuringCompanion(right, left)) {
    nonClosing.add(right.state);
  }
}

export function findStateCompanionWrites(
  states: readonly StateCandidate[],
  stateFlow: StateFlowIndex,
): StateCompanionWrites {
  const sinks: CompanionWriteSinks = { all: new Set(), nonClosing: new Set(), partners: new Map() };
  for (const [owner, ownerStates] of groupSettableStatesByOwner(states)) {
    const mutations = collectSetterMutations(owner, ownerStates);
    for (const pair of coexecutingMutationPairs(mutations, stateFlow)) {
      recordCompanionPair(pair, sinks);
    }
  }
  return sinks;
}

export function collectSetterMutations(
  owner: RuntimeFunctionLike,
  ownerStates: readonly StateCandidate[],
): readonly SetterMutation[] {
  const stateBySetter = new Map(
    ownerStates.flatMap((state) => (state.setterName ? [[state.setterName, state] as const] : [])),
  );
  const mutations: SetterMutation[] = [];
  visit(owner.body, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
      return;
    }
    const state = stateBySetter.get(node.expression.text);
    if (state) {
      mutations.push({ call: node, region: nearestMutationFunction(node, owner), state });
    }
  });
  return mutations;
}

function coexecutingMutationPairs(
  mutations: readonly SetterMutation[],
  stateFlow: StateFlowIndex,
): readonly (readonly [SetterMutation, SetterMutation])[] {
  const pairs: (readonly [SetterMutation, SetterMutation])[] = [];
  for (const [leftIndex, left] of mutations.entries()) {
    for (const right of mutations.slice(leftIndex + 1)) {
      if (
        left.state !== right.state &&
        left.region === right.region &&
        mutationsMayCoexecute(left.call, right.call, { region: left.region, stateFlow })
      ) {
        pairs.push([left, right]);
      }
    }
  }
  return pairs;
}

function mutationIsProvenCloseDuringCompanion(
  mutation: SetterMutation,
  companion: SetterMutation,
): boolean {
  if (callSetsLiteral(mutation, ts.SyntaxKind.FalseKeyword)) {
    return true;
  }
  const [argument] = mutation.call.arguments;
  if (
    mutation.call.arguments.length !== 1 ||
    !argument ||
    !ts.isIdentifier(argument) ||
    !isRuntimeFunctionLike(mutation.region) ||
    bindingDeclarationCount(mutation.region, argument.text) !== 1 ||
    !parameterIsBooleanVisibilityTransition(mutation.region, mutation.state, argument.text) ||
    runtimeParameterIsReassigned(mutation.region, argument.text)
  ) {
    return false;
  }
  for (
    let current: ts.Node | undefined = companion.call;
    current && current !== mutation.region;
    current = current.parent
  ) {
    if (
      ts.isIfStatement(current) &&
      nodeWithin(companion.call, current.thenStatement) &&
      isNegatedIdentifier(current.expression, argument.text)
    ) {
      return true;
    }
  }
  return false;
}

function parameterIsBooleanVisibilityTransition(
  owner: RuntimeFunctionLike,
  state: StateCandidate,
  name: string,
): boolean {
  const parameter = owner.parameters.find(
    (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
  );
  if (!parameter) {
    return false;
  }
  if (parameter.type?.kind === ts.SyntaxKind.BooleanKeyword) {
    return true;
  }
  const attribute = findAncestorUntil(owner, ts.isJsxAttribute, state.owner);
  if (
    !attribute?.initializer ||
    !ts.isJsxExpression(attribute.initializer) ||
    attribute.initializer.expression !== owner
  ) {
    return false;
  }
  const opening = attribute.parent.parent;
  return (
    (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) &&
    isVisibilityTransitionAttribute(opening, attribute.name.getText(), state.valueName)
  );
}

function runtimeParameterIsReassigned(owner: RuntimeFunctionLike, name: string): boolean {
  if (!owner.body) {
    return true;
  }
  let reassigned = false;
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (!ts.isBinaryExpression(node)) {
      return;
    }
    const left = unwrapTransparentExpression(node.left);
    if (
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(left) &&
      left.text === name
    ) {
      reassigned = true;
    }
  });
  return reassigned;
}

function isNegatedIdentifier(expression: ts.Expression, name: string): boolean {
  const value = unwrapTransparentExpression(expression);
  if (!ts.isPrefixUnaryExpression(value) || value.operator !== ts.SyntaxKind.ExclamationToken) {
    return false;
  }
  const operand = unwrapTransparentExpression(value.operand);
  return ts.isIdentifier(operand) && operand.text === name;
}
