import {
  PAIRED_FINALIZER_STATEMENTS,
  PAIRED_SETTER_CALLS,
  SMALL_OWNER_JSX_ELEMENTS,
} from "./constants.js";
import type { StateCandidate, StateUsage } from "./model.js";
import {
  findAncestorUntil,
  nearestNestedFunction,
  visitSkippingNestedRuntimeFunctions,
} from "../core/ast.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import { callbackIsEventRooted } from "../rules/state-proofs/event-roots.js";
import { jsxElementCount } from "../rules/state-proofs/jsx-subtrees.js";
import { nearestMutationFunction } from "./mutations.js";
import { stateHasNoEffectOrDeferredUse } from "./verdicts/transport-verdicts.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../core/analysis-ast.js";

export function isCohesiveDelayedPendingState(state: StateCandidate, usage: StateUsage): boolean {
  if (!stateIsCompactRenderedPendingFlag(state, usage)) {
    return false;
  }
  const pending = usage.setterCallNodes.find(
    (call) => call.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword,
  );
  const reset = usage.setterCallNodes.find(
    (call) => call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword,
  );
  if (!pending || !reset) {
    return false;
  }
  return pendingWriteIsTimedAndCleared(pending, reset, state.owner);
}

function stateIsCompactRenderedPendingFlag(state: StateCandidate, usage: StateUsage): boolean {
  return (
    state.call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword &&
    jsxElementCount(state.owner) <= SMALL_OWNER_JSX_ELEMENTS &&
    usage.localRenderReads > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    stateHasNoEffectOrDeferredUse(usage) &&
    usage.transportedOccurrences === 0 &&
    usage.setterCallNodes.length === PAIRED_SETTER_CALLS &&
    usage.setterReferences === usage.setterCalls &&
    !usage.shadowed &&
    !usage.escaped
  );
}

function pendingWriteIsTimedAndCleared(
  pending: ts.CallExpression,
  reset: ts.CallExpression,
  owner: RuntimeFunctionLike,
): boolean {
  const timerDeclaration = scheduledPendingTimerDeclaration(pending, owner);
  const timerCall = timerDeclaration?.initializer;
  const command = timerCall ? nearestMutationFunction(timerCall, owner) : null;
  if (!timerDeclaration || !command || !isAsyncEventCommand(command, owner)) {
    return false;
  }
  const tryStatement = findAncestorUntil(reset, ts.isTryStatement, command);
  if (!tryStatement || !finallyClearsTimer(tryStatement, { reset, timerDeclaration })) {
    return false;
  }
  return blockAwaits(tryStatement.tryBlock);
}

function blockAwaits(block: ts.Block): boolean {
  let awaits = false;
  visitSkippingNestedRuntimeFunctions(block, (node) => {
    awaits ||= ts.isAwaitExpression(node);
  });
  return awaits;
}

function scheduledPendingTimerDeclaration(
  pending: ts.CallExpression,
  owner: RuntimeFunctionLike,
): ts.VariableDeclaration | null {
  const scheduled = nearestNestedFunction(pending, owner);
  if (!scheduled || !ts.isArrowFunction(scheduled) || !scheduledSetterIsExact(scheduled, pending)) {
    return null;
  }
  const timerCall = scheduled.parent;
  if (
    !ts.isCallExpression(timerCall) ||
    timerCall.arguments[0] !== scheduled ||
    !isNamedCall(timerCall, "setTimeout")
  ) {
    return null;
  }
  const timerDeclaration = timerCall.parent;
  if (
    !ts.isVariableDeclaration(timerDeclaration) ||
    timerDeclaration.initializer !== timerCall ||
    !ts.isIdentifier(timerDeclaration.name) ||
    !ts.isVariableDeclarationList(timerDeclaration.parent) ||
    (timerDeclaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  return timerDeclaration;
}

function isAsyncEventCommand(command: RuntimeFunctionLike, owner: RuntimeFunctionLike): boolean {
  return (
    command !== owner &&
    (ts.isArrowFunction(command) ||
      ts.isFunctionDeclaration(command) ||
      ts.isFunctionExpression(command)) &&
    command.body !== undefined &&
    ts.isBlock(command.body) &&
    (command.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ??
      false) &&
    callbackIsEventRooted({ callback: command, owner, dependencyName: "", seen: new Set() })
  );
}

interface PendingTimerCleanup {
  readonly reset: ts.CallExpression;
  readonly timerDeclaration: ts.VariableDeclaration;
}

function finallyClearsTimer(
  tryStatement: ts.TryStatement,
  { reset, timerDeclaration }: PendingTimerCleanup,
): boolean {
  const finalizer = tryStatement.finallyBlock;
  if (
    !finalizer ||
    finalizer.statements.length !== PAIRED_FINALIZER_STATEMENTS ||
    !ts.isExpressionStatement(finalizer.statements[0]!) ||
    !ts.isExpressionStatement(finalizer.statements[1]!) ||
    unwrapTransparentExpression(finalizer.statements[1]!.expression) !== reset
  ) {
    return false;
  }
  const clear = unwrapTransparentExpression(finalizer.statements[0]!.expression);
  return (
    ts.isCallExpression(clear) &&
    isNamedCall(clear, "clearTimeout") &&
    clear.arguments.length === 1 &&
    ts.isIdentifier(clear.arguments[0]!) &&
    clear.arguments[0]!.text === timerDeclaration.name.getText()
  );
}

function scheduledSetterIsExact(callback: ts.ArrowFunction, setter: ts.CallExpression): boolean {
  if (!ts.isBlock(callback.body)) {
    return unwrapTransparentExpression(callback.body) === setter;
  }
  const [statement] = callback.body.statements;
  return (
    callback.body.statements.length === 1 &&
    statement !== undefined &&
    ts.isExpressionStatement(statement) &&
    unwrapTransparentExpression(statement.expression) === setter
  );
}

function isNamedCall(call: ts.CallExpression, name: string): boolean {
  const callee = call.expression;
  return ts.isIdentifier(callee)
    ? callee.text === name
    : ts.isPropertyAccessExpression(callee) && callee.name.text === name;
}
