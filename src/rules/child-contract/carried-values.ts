import { bindingDeclarationCount, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import type { ChildComponentSource } from "./model.js";
import ts from "typescript";

export function constArrayBinding(
  array: ts.ArrayLiteralExpression,
  owner: ChildComponentSource["owner"],
): ts.Identifier | null {
  const carriedArray = climbTransparentExpression(array);
  const declaration = carriedArray.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== carriedArray ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, declaration.name.text) !== 1
  ) {
    return null;
  }
  return declaration.name;
}

export function staticPropertyAccessFrom(
  expression: ts.Expression,
): { expression: ts.Expression; name: string } | null {
  const { parent } = expression;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === expression) {
    return { expression: parent, name: parent.name.text };
  }
  if (
    ts.isElementAccessExpression(parent) &&
    parent.expression === expression &&
    parent.argumentExpression &&
    ts.isStringLiteralLike(parent.argumentExpression)
  ) {
    return { expression: parent, name: parent.argumentExpression.text };
  }
  return null;
}

export function expressionCarriesValue(expression: ts.Expression, value: ts.Expression): boolean {
  const unwrapped = unwrapTransparentExpression(expression);
  if (unwrapped === value) {
    return true;
  }
  if (
    !ts.isBinaryExpression(unwrapped) ||
    unwrapped.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
  ) {
    return false;
  }
  const left = unwrapTransparentExpression(unwrapped.left);
  const right = unwrapTransparentExpression(unwrapped.right);
  return (
    (left === value && isEmptyObjectLiteral(right)) ||
    (right === value && isEmptyObjectLiteral(left))
  );
}

function isEmptyObjectLiteral(expression: ts.Expression): boolean {
  return ts.isObjectLiteralExpression(expression) && expression.properties.length === 0;
}

export function directConstAlias(
  expression: ts.Expression,
  owner: ChildComponentSource["owner"],
): ts.Identifier | null {
  const declaration = expression.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== expression ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, declaration.name.text) !== 1
  ) {
    return null;
  }
  return declaration.name;
}

export function climbTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isNonNullExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
}

export function isNullishExpression(
  expression: ts.Expression,
  owner: ChildComponentSource["owner"],
): boolean {
  const value = unwrapTransparentExpression(expression);
  return (
    value.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(value) &&
      value.text === "undefined" &&
      bindingDeclarationCount(owner, "undefined") === 0)
  );
}

export function objectLiteralPropertyValue(
  member: ts.ObjectLiteralElementLike | null | undefined,
): ts.Expression | null {
  if (member && ts.isShorthandPropertyAssignment(member)) {
    return member.name;
  }
  if (member && ts.isPropertyAssignment(member)) {
    return unwrapTransparentExpression(member.initializer);
  }
  return null;
}
