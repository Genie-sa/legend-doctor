import type { StateCandidate } from "../../analysis/model.js";
import { callbackHasCleanup } from "../effects/effects.js";
import ts from "typescript";

export function synchronousDraftSetters(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): readonly StateCandidate[] | null {
  if (!ts.isBlock(callback.body) || callbackHasCleanup(callback, stateBySetter)) {
    return null;
  }
  const members = new Set<StateCandidate>();
  const synchronous = callback.body.statements.every((statement) =>
    isDraftStatement(statement, stateBySetter, members),
  );
  return synchronous ? [...members] : null;
}

function isDraftStatement(
  statement: ts.Statement,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
  members: Set<StateCandidate>,
): boolean {
  if (ts.isBlock(statement)) {
    return statement.statements.every((child) => isDraftStatement(child, stateBySetter, members));
  }
  if (ts.isIfStatement(statement)) {
    return (
      isDraftStatement(statement.thenStatement, stateBySetter, members) &&
      (!statement.elseStatement ||
        isDraftStatement(statement.elseStatement, stateBySetter, members))
    );
  }
  if (ts.isReturnStatement(statement)) {
    return statement.expression === undefined;
  }
  return isDraftSetterStatement(statement, stateBySetter, members);
}

function isDraftSetterStatement(
  statement: ts.Statement,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
  members: Set<StateCandidate>,
): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
    return false;
  }
  const call = statement.expression;
  const [argument] = call.arguments;
  const state = ts.isIdentifier(call.expression)
    ? stateBySetter.get(call.expression.text)
    : undefined;
  if (
    !state ||
    call.arguments.length !== 1 ||
    !argument ||
    ts.isArrowFunction(argument) ||
    ts.isFunctionExpression(argument)
  ) {
    return false;
  }
  members.add(state);
  return true;
}
