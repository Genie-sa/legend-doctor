import type {
  BranchUnmountMove,
  DirectReturnCallSite,
  StateCandidate,
  StateUsage,
} from "./model.js";
import { findAncestorUntil, nodeWithin } from "../core/ast.js";
import { mutationsMayCoexecute, nearestMutationFunction } from "./mutations.js";
import { MIN_REPEATED_SETTER_CALLS } from "./constants.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import type { StateFlowIndex } from "../project/state-flow/state-flow.js";
import { callbackIsEventRooted } from "../rules/state-proofs/event-roots.js";
import { directBranchReturnCallSite } from "./return-call-sites.js";
import { hasStateInitializer } from "../rules/deferred-reveal/deferred-reveal.js";
import { jsxSubtreeForOpening } from "./ast-helpers.js";
import { mutationRegionOnlyCallsStateSetters } from "../rules/effect-drafts/draft-mutations.js";
import { stateHasNoEffectOrDeferredUse } from "./verdicts/transport-verdicts.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../core/analysis-ast.js";

interface BranchUnmountScanContext {
  readonly safeCommandStates: ReadonlySet<StateCandidate>;
  readonly stateFlow: StateFlowIndex;
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

export function findBranchUnmountMoves(
  states: readonly StateCandidate[],
  { safeCommandStates, stateFlow, usageByState }: BranchUnmountScanContext,
): ReadonlyMap<StateCandidate, BranchUnmountMove> {
  const result = new Map<StateCandidate, BranchUnmountMove>();
  for (const state of states) {
    const usage = usageByState.get(state);
    if (!usage || !stateIsBranchLocalFlag(state, usage, safeCommandStates)) {
      continue;
    }
    const move = branchUnmountMoveFor(state, usage, { stateFlow, states, usageByState });
    if (move) {
      result.set(state, move);
    }
  }
  return result;
}

function stateIsBranchLocalFlag(
  state: StateCandidate,
  usage: StateUsage,
  safeCommandStates: ReadonlySet<StateCandidate>,
): boolean {
  return (
    state.setterName !== null &&
    safeCommandStates.has(state) &&
    hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) &&
    usage.localRenderReads === 0 &&
    stateHasNoEffectOrDeferredUse(usage) &&
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1 &&
    !usage.repeatedTransport &&
    usage.setterReferences === usage.setterCalls &&
    usage.setterCallNodes.length >= MIN_REPEATED_SETTER_CALLS &&
    !usage.shadowed &&
    !usage.escaped
  );
}

interface BranchUnmountMoveScope {
  readonly stateFlow: StateFlowIndex;
  readonly states: readonly StateCandidate[];
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

function branchUnmountMoveFor(
  state: StateCandidate,
  usage: StateUsage,
  { stateFlow, states, usageByState }: BranchUnmountMoveScope,
): BranchUnmountMove | null {
  const callSite = directBranchReturnCallSite(usage, state.owner);
  const [target] = [...usage.valueTargets];
  const gate = callSite
    ? exactDiscriminatedBranchGate(callSite.opening, state.owner, states)
    : null;
  const controllerUsage = gate ? usageByState.get(gate.controller) : undefined;
  if (
    !callSite ||
    !target ||
    !gate ||
    !gate.controller.setterName ||
    !controllerUsage ||
    controllerUsage.shadowed ||
    controllerUsage.escaped
  ) {
    return null;
  }
  const writesSplitAcrossBranch = branchWritesAreUnmountScoped(state, usage, {
    callSite,
    controllerUsage,
    gate,
    stateFlow,
  });
  return writesSplitAcrossBranch ? { target } : null;
}

interface BranchUnmountWriteScope {
  readonly callSite: DirectReturnCallSite;
  readonly controllerUsage: StateUsage;
  readonly gate: DiscriminatedBranchGate;
  readonly stateFlow: StateFlowIndex;
}

function branchWritesAreUnmountScoped(
  state: StateCandidate,
  usage: StateUsage,
  { callSite, controllerUsage, gate, stateFlow }: BranchUnmountWriteScope,
): boolean {
  const subtree = jsxSubtreeForOpening(callSite.opening);
  const branchCalls = usage.setterCallNodes.filter((call) => nodeWithin(call, subtree));
  const outsideCalls = usage.setterCallNodes.filter((call) => !nodeWithin(call, subtree));
  return (
    branchCalls.length > 0 &&
    outsideCalls.length > 0 &&
    branchCalls.every((call) => isDirectBranchInteractionWrite(call, callSite.opening, state)) &&
    outsideCalls.every((call) =>
      isBranchUnmountReset(call, state, { controllerUsage, gate, stateFlow }),
    )
  );
}

interface DiscriminatedBranchGate {
  controller: StateCandidate;
  property: string;
  value: string;
}

function exactDiscriminatedBranchGate(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  owner: RuntimeFunctionLike,
  states: readonly StateCandidate[],
): DiscriminatedBranchGate | null {
  const conditional = nullFallbackGateFor(opening, owner);
  const condition = conditional ? unwrapTransparentExpression(conditional.condition) : null;
  if (
    !condition ||
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return null;
  }
  const left = unwrapTransparentExpression(condition.left);
  const right = unwrapTransparentExpression(condition.right);
  if (
    !ts.isPropertyAccessExpression(left) ||
    !ts.isIdentifier(left.expression) ||
    !ts.isStringLiteral(right)
  ) {
    return null;
  }
  const controller = uniqueOwnedState(states, owner, left.expression.text);
  return controller ? { controller, property: left.name.text, value: right.text } : null;
}

function nullFallbackGateFor(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  owner: RuntimeFunctionLike,
): ts.ConditionalExpression | null {
  for (
    let current: ts.Node | undefined = opening.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (
      ts.isConditionalExpression(current) &&
      nodeWithin(opening, current.whenTrue) &&
      unwrapTransparentExpression(current.whenFalse).kind === ts.SyntaxKind.NullKeyword
    ) {
      return current;
    }
  }
  return null;
}

function uniqueOwnedState(
  states: readonly StateCandidate[],
  owner: RuntimeFunctionLike,
  valueName: string,
): StateCandidate | null {
  const matches = states.filter((state) => state.owner === owner && state.valueName === valueName);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function isDirectBranchInteractionWrite(
  call: ts.CallExpression,
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  state: StateCandidate,
): boolean {
  const attribute = findAncestorUntil(call, ts.isJsxAttribute, state.owner);
  const callback = nearestMutationFunction(call, state.owner);
  if (attribute === null || state.setterName === null) {
    return false;
  }
  return (
    /^on[A-Z]/u.test(attribute.name.getText()) &&
    attribute.parent.parent === opening &&
    callback !== state.owner &&
    mutationRegionOnlyCallsStateSetters(callback, new Set([state.setterName]))
  );
}

interface BranchUnmountResetContext {
  readonly controllerUsage: StateUsage;
  readonly gate: DiscriminatedBranchGate;
  readonly stateFlow: StateFlowIndex;
}

function isBranchUnmountReset(
  reset: ts.CallExpression,
  state: StateCandidate,
  { controllerUsage, gate, stateFlow }: BranchUnmountResetContext,
): boolean {
  if (reset.arguments.length !== 1 || reset.arguments[0]?.kind !== ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  const region = nearestMutationFunction(reset, state.owner);
  if (
    region === state.owner ||
    (!ts.isArrowFunction(region) &&
      !ts.isFunctionDeclaration(region) &&
      !ts.isFunctionExpression(region)) ||
    !callbackIsEventRooted({
      callback: region,
      owner: state.owner,
      dependencyName: "",
      seen: new Set(),
    })
  ) {
    return false;
  }
  const closeCalls = controllerUsage.setterCallNodes.filter(
    (call) =>
      callsAreAdjacentStatements(reset, call) &&
      callSetsDifferentDiscriminant(call, gate.property, gate.value),
  );
  const close = closeCalls.length === 1 ? closeCalls[0] : null;
  if (!close) {
    return false;
  }
  return !controllerUsage.setterCallNodes.some((call) => {
    if (
      call === close ||
      nearestMutationFunction(call, state.owner) !== region ||
      !mutationsMayCoexecute(close, call, { region, stateFlow })
    ) {
      return false;
    }
    const value = callDiscriminantValue(call, gate.property);
    return value === null || value === gate.value;
  });
}

function callsAreAdjacentStatements(left: ts.CallExpression, right: ts.CallExpression): boolean {
  const leftStatement = left.parent;
  const rightStatement = right.parent;
  if (
    !ts.isExpressionStatement(leftStatement) ||
    leftStatement.expression !== left ||
    !ts.isExpressionStatement(rightStatement) ||
    rightStatement.expression !== right ||
    leftStatement.parent !== rightStatement.parent ||
    !ts.isBlock(leftStatement.parent)
  ) {
    return false;
  }
  const { statements } = leftStatement.parent;
  return Math.abs(statements.indexOf(leftStatement) - statements.indexOf(rightStatement)) === 1;
}

function callSetsDifferentDiscriminant(
  call: ts.CallExpression,
  property: string,
  activeValue: string,
): boolean {
  const value = callDiscriminantValue(call, property);
  return value !== null && value !== activeValue;
}

function callDiscriminantValue(call: ts.CallExpression, property: string): string | null {
  if (call.arguments.length !== 1 || !call.arguments[0]) {
    return null;
  }
  const value = unwrapTransparentExpression(call.arguments[0]);
  if (
    !ts.isObjectLiteralExpression(value) ||
    value.properties.some(
      (candidate) =>
        (ts.isShorthandPropertyAssignment(candidate) && candidate.name.text === property) ||
        (!ts.isShorthandPropertyAssignment(candidate) &&
          (!ts.isPropertyAssignment(candidate) ||
            (!ts.isIdentifier(candidate.name) && !ts.isStringLiteral(candidate.name)))),
    )
  ) {
    return null;
  }
  const matches = value.properties.filter((candidate) => {
    if (!ts.isPropertyAssignment(candidate)) {
      return false;
    }
    const name =
      ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)
        ? candidate.name.text
        : null;
    return name === property;
  });
  const assignment =
    matches.length === 1 && ts.isPropertyAssignment(matches[0]!) ? matches[0]! : null;
  const discriminator = assignment ? unwrapTransparentExpression(assignment.initializer) : null;
  return discriminator && ts.isStringLiteral(discriminator) ? discriminator.text : null;
}
