import type { EffectCandidate, StateCandidate, StateUsage } from "../../analysis/model.js";
import { visit, visitSkippingNestedFunctions } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isRenderGateReference } from "./render-gates.js";
import { localBindingNames } from "../../core/analysis-ast.js";
import ts from "typescript";

interface SchedulerDeclaration {
  handle: string;
  setter: StateCandidate;
}

export function findDeferredRevealStates(
  effects: readonly EffectCandidate[],
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
): ReadonlySet<StateCandidate> {
  const byOwner = groupStatesByOwner(states);
  const result = new Set<StateCandidate>();
  for (const effect of effects) {
    const state = effectRevealedState(effect, byOwner);
    if (state && isDeferredRevealUsage(usageByState.get(state), state)) {
      result.add(state);
    }
  }
  return result;
}

function groupStatesByOwner(
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

function effectRevealedState(
  effect: EffectCandidate,
  byOwner: ReadonlyMap<RuntimeFunctionLike, StateCandidate[]>,
): StateCandidate | null {
  if (!effect.owner) {
    return null;
  }
  const stateBySetter = new Map(
    (byOwner.get(effect.owner) ?? []).flatMap((state) =>
      state.setterName ? [[state.setterName, state] as const] : [],
    ),
  );
  const state = deferredRevealState(effect, stateBySetter);
  return state &&
    state.owner === effect.owner &&
    hasStateInitializer(state, ts.SyntaxKind.FalseKeyword)
    ? state
    : null;
}

function isDeferredRevealUsage(usage: StateUsage | undefined, state: StateCandidate): boolean {
  return (
    usage !== undefined &&
    usage.setterReferences === 1 &&
    usage.setterCalls === 1 &&
    usage.effectWrites === 1 &&
    usage.effectReads === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences === 0 &&
    usage.directRenderNodes.length === 1 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    !usage.shadowed &&
    !usage.escaped &&
    usage.directRenderNodes.every((node) => isRenderGateReference(node, state.owner))
  );
}

function deferredRevealState(
  effect: EffectCandidate,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): StateCandidate | null {
  const { callback } = effect;
  if (
    !callback ||
    !effect.dependencies ||
    effect.dependencies.elements.length > 0 ||
    !ts.isBlock(callback.body)
  ) {
    return null;
  }
  const schedulers: SchedulerDeclaration[] = [];
  let knownSetterCalls = 0;
  visit(callback.body, (node) => {
    if (isKnownSetterCall(node, stateBySetter)) {
      knownSetterCalls += 1;
    }
    const declared = schedulerDeclaration(node, stateBySetter);
    if (declared) {
      schedulers.push(declared);
    }
  });
  const [scheduler] = schedulers;
  if (
    schedulers.length !== 1 ||
    knownSetterCalls !== 1 ||
    !scheduler ||
    !callbackCancelsDeferredHandle(callback, scheduler.handle)
  ) {
    return null;
  }
  return scheduler.setter;
}

function isKnownSetterCall(
  node: ts.Node,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    stateBySetter.has(node.expression.text)
  );
}

function schedulerDeclaration(
  node: ts.Node,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): SchedulerDeclaration | null {
  if (
    !ts.isVariableDeclaration(node) ||
    !ts.isIdentifier(node.name) ||
    !node.initializer ||
    !ts.isCallExpression(node.initializer)
  ) {
    return null;
  }
  const [callback] = node.initializer.arguments;
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return null;
  }
  const setterCall = soleLiteralTrueSetterCall(callback, stateBySetter);
  const setter = setterCall ? stateBySetter.get(setterCall.expression.text) : undefined;
  return setter ? { handle: node.name.text, setter } : null;
}

function soleLiteralTrueSetterCall(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): (ts.CallExpression & { expression: ts.Identifier }) | null {
  const calls: (ts.CallExpression & { expression: ts.Identifier })[] = [];
  visitSkippingNestedFunctions(callback.body, callback, (node) => {
    if (isKnownSetterCall(node, stateBySetter)) {
      // SAFETY: isKnownSetterCall proves the node is a call whose target is an Identifier.
      calls.push(node as ts.CallExpression & { expression: ts.Identifier });
    }
  });
  const [call] = calls;
  return calls.length === 1 &&
    call?.arguments.length === 1 &&
    call.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword
    ? call
    : null;
}

function callbackCancelsDeferredHandle(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  handle: string,
): boolean {
  return (
    ts.isBlock(callback.body) &&
    callback.body.statements.some((statement) => statementCancelsHandle(statement, handle))
  );
}

function statementCancelsHandle(statement: ts.Statement, handle: string): boolean {
  if (!ts.isReturnStatement(statement) || !statement.expression) {
    return false;
  }
  const cleanup = statement.expression;
  if (!ts.isArrowFunction(cleanup) && !ts.isFunctionExpression(cleanup)) {
    return false;
  }
  if (localBindingNames(cleanup, null).has(handle)) {
    return false;
  }
  const call = cleanupCallExpression(cleanup);
  return call !== null && callCancelsHandle(call, handle);
}

function cleanupCallExpression(
  cleanup: ts.ArrowFunction | ts.FunctionExpression,
): ts.CallExpression | null {
  if (!ts.isBlock(cleanup.body)) {
    return ts.isCallExpression(cleanup.body) ? cleanup.body : null;
  }
  const [only] = cleanup.body.statements;
  if (cleanup.body.statements.length !== 1 || !only || !ts.isExpressionStatement(only)) {
    return null;
  }
  return ts.isCallExpression(only.expression) ? only.expression : null;
}

function callCancelsHandle(call: ts.CallExpression, handle: string): boolean {
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === handle &&
    /^(?:cancel|clear|remove)$/u.test(call.expression.name.text) &&
    call.arguments.length === 0
  ) {
    return true;
  }
  const [argument] = call.arguments;
  return (
    ts.isIdentifier(call.expression) &&
    /^(?:cancel|clear|remove)/u.test(call.expression.text) &&
    call.arguments.length === 1 &&
    argument !== undefined &&
    ts.isIdentifier(argument) &&
    argument.text === handle
  );
}

export function hasStateInitializer(state: StateCandidate, kind: ts.SyntaxKind): boolean {
  return state.call.arguments.length === 1 && state.call.arguments[0]?.kind === kind;
}
