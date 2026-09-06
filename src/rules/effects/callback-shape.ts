import type { StateCandidate } from "../../analysis/model.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

export function calleeName(callee: ts.Expression): string {
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
}

export function calleeRootIdentifier(callee: ts.Expression): ts.Identifier | null {
  if (ts.isIdentifier(callee)) {
    return callee;
  }
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
    ? callee.expression
    : null;
}

export function soleExpressionStatementBody(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | null {
  if (!ts.isBlock(callback.body)) {
    return callback.body;
  }
  const [statement] = callback.body.statements;
  return callback.body.statements.length === 1 && statement && ts.isExpressionStatement(statement)
    ? statement.expression
    : null;
}

export function soleReturnStatementBody(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | undefined {
  if (!ts.isBlock(callback.body)) {
    return callback.body;
  }
  const [statement] = callback.body.statements;
  return callback.body.statements.length === 1 && statement && ts.isReturnStatement(statement)
    ? statement.expression
    : undefined;
}

export function soleDirectSetterCall(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): (ts.CallExpression & { expression: ts.Identifier }) | null {
  const expression = soleExpressionStatementBody(callback);
  if (
    !expression ||
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    !stateBySetter.has(expression.expression.text) ||
    expression.arguments.length !== 1
  ) {
    return null;
  }
  // SAFETY: The guards prove both the CallExpression and Identifier parts of
  // They establish the intersection returned to callers.
  return expression as ts.CallExpression & { expression: ts.Identifier };
}

export function isSubscriptionCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return /^(?:subscribe|listen|observe|register)/u.test(callee.text);
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return /^(?:subscribe|listen|observe|register|addListener|on[A-Z])/u.test(callee.name.text);
  }
  return false;
}

export function callbackCallsKnownSetter(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): boolean {
  let callsSetter = false;
  visit(callback.body, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      stateBySetter.has(node.expression.text)
    ) {
      callsSetter = true;
    }
  });
  return callsSetter;
}
