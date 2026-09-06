import ts from "typescript";

const EQUALITY_OPERATOR_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

function referenceIsBooleanTest(expression: ts.Expression, parent: ts.Node): boolean {
  if (
    (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
    parent.expression === expression
  ) {
    return true;
  }
  if (ts.isConditionalExpression(parent) && parent.condition === expression) {
    return true;
  }
  if (
    ts.isPrefixUnaryExpression(parent) &&
    parent.operand === expression &&
    parent.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return true;
  }
  if (ts.isTypeOfExpression(parent) && parent.expression === expression) {
    return true;
  }
  return ts.isTypeQueryNode(parent) && parent.exprName === expression;
}

export function callbackReferenceIsObservationOnly(expression: ts.Expression): boolean {
  const { parent } = expression;
  if (referenceIsBooleanTest(expression, parent)) {
    return true;
  }
  if (!ts.isBinaryExpression(parent)) {
    return false;
  }
  if (EQUALITY_OPERATOR_KINDS.has(parent.operatorToken.kind)) {
    return true;
  }
  return (
    (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
    expressionFeedsBooleanControl(parent)
  );
}

function expressionFeedsBooleanControl(expression: ts.Expression): boolean {
  let current = expression;
  while (
    ts.isBinaryExpression(current.parent) &&
    (current.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      current.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    current = current.parent;
  }
  const { parent } = current;
  return (
    ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
      parent.expression === current) ||
    (ts.isConditionalExpression(parent) && parent.condition === current) ||
    (ts.isPrefixUnaryExpression(parent) &&
      parent.operator === ts.SyntaxKind.ExclamationToken &&
      parent.operand === current)
  );
}
