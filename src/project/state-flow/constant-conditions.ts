import type { RightExecution } from "./model.js";
import ts from "typescript";

export function isShortCircuitBinary(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  );
}

export function constantBoolean(expression: ts.Expression): boolean | null {
  if (ts.isParenthesizedExpression(expression)) {
    return constantBoolean(expression.expression);
  }
  if (isNegation(expression)) {
    const value = constantBoolean(expression.operand);
    return value === null ? null : !value;
  }
  return constantValueBoolean(expression);
}

function isNegation(expression: ts.Expression): expression is ts.PrefixUnaryExpression {
  return (
    ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken
  );
}

function constantValueBoolean(expression: ts.Expression): boolean | null {
  if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(expression)
  ) {
    return false;
  }
  if (isTruthyLiteralExpression(expression)) {
    return true;
  }
  return constantLiteralTextBoolean(expression);
}

function isTruthyLiteralExpression(expression: ts.Expression): boolean {
  return (
    ts.isObjectLiteralExpression(expression) ||
    ts.isArrayLiteralExpression(expression) ||
    ts.isFunctionExpression(expression) ||
    ts.isArrowFunction(expression) ||
    ts.isClassExpression(expression)
  );
}

function constantLiteralTextBoolean(expression: ts.Expression): boolean | null {
  if (ts.isStringLiteralLike(expression)) {
    return expression.text.length > 0;
  }
  if (ts.isNumericLiteral(expression)) {
    return Number(expression.text) !== 0;
  }
  if (ts.isBigIntLiteral(expression)) {
    return expression.text !== "0n";
  }
  return null;
}

export function shortCircuitRightExecution(expression: ts.BinaryExpression): RightExecution {
  if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return rightExecutionWhen(constantBoolean(expression.left), true);
  }
  if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return rightExecutionWhen(constantBoolean(expression.left), false);
  }
  return rightExecutionWhen(constantNullish(expression.left), true);
}

function rightExecutionWhen(value: boolean | null, executesWhen: boolean): RightExecution {
  if (value === null) {
    return "maybe";
  }
  return value === executesWhen ? "always" : "never";
}

function constantNullish(expression: ts.Expression): boolean | null {
  if (expression.kind === ts.SyntaxKind.NullKeyword) {
    return true;
  }
  if (
    ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isObjectLiteralExpression(expression) ||
    ts.isArrayLiteralExpression(expression) ||
    ts.isFunctionExpression(expression) ||
    ts.isArrowFunction(expression) ||
    ts.isClassExpression(expression)
  ) {
    return false;
  }
  return ts.isParenthesizedExpression(expression) ? constantNullish(expression.expression) : null;
}

export function isInertCaseExpression(expression: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword ||
    ts.isIdentifier(expression) ||
    ts.isPropertyAccessExpression(expression)
  );
}
