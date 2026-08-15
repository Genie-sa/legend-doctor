import ts from "typescript";

import { isRuntimeFunctionLike, type RuntimeFunctionLike, visit } from "./ast.js";

export function bindingDeclarationCount(owner: RuntimeFunctionLike, name: string): number {
  let count = 0;
  for (const parameter of owner.parameters) {
    if (bindingNameContains(parameter.name, name)) count += 1;
  }
  if (!owner.body) return count;
  visit(owner.body, node => {
    if (ts.isVariableDeclaration(node) && bindingNameContains(node.name, name)) count += 1;
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)) &&
      node.name?.text === name
    ) {
      count += 1;
    }
    if (isRuntimeFunctionLike(node) && node !== owner) {
      for (const parameter of node.parameters) {
        if (bindingNameContains(parameter.name, name)) count += 1;
      }
    }
  });
  return count;
}

export function callRootIdentifier(expression: ts.LeftHandSideExpression): string | null {
  let current: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

export function collectBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) collectBindingNames(element.name, names);
  }
}

export function containsCallExpression(node: ts.Node): boolean {
  let found = false;
  visit(node, child => {
    if (ts.isCallExpression(child)) found = true;
  });
  return found;
}

export function containsElementAccess(node: ts.Node): boolean {
  let found = false;
  visit(node, current => {
    if (ts.isElementAccessExpression(current)) found = true;
  });
  return found;
}

export function hookCallName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;
}

export function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

export function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionExpression(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node)
  );
}

export function isDirectJsxAttributeExpression(
  attribute: ts.JsxAttribute,
  node: ts.Identifier
): boolean {
  const initializer = attribute.initializer;
  return initializer !== undefined &&
    ts.isJsxExpression(initializer) &&
    initializer.expression !== undefined &&
    unwrapTransparentExpression(initializer.expression) === node;
}

export function isEvaluationInert(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  if (
    ts.isIdentifier(value) ||
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    ts.isStringLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(value)) {
    const numericLiteral = ts.isNumericLiteral(value.operand);
    const bigintLiteral = ts.isBigIntLiteral(value.operand);
    return (
      (numericLiteral && value.operator === ts.SyntaxKind.PlusToken) ||
      ((numericLiteral || bigintLiteral) &&
        (value.operator === ts.SyntaxKind.MinusToken || value.operator === ts.SyntaxKind.TildeToken)) ||
      (value.operator === ts.SyntaxKind.ExclamationToken && isEvaluationInert(value.operand))
    );
  }
  if (ts.isTypeOfExpression(value)) return isEvaluationInert(value.expression);
  if (ts.isConditionalExpression(value)) {
    return isEvaluationInert(value.condition) &&
      isEvaluationInert(value.whenTrue) &&
      isEvaluationInert(value.whenFalse);
  }
  if (ts.isBinaryExpression(value)) {
    const operator = value.operatorToken.kind;
    if (
      operator !== ts.SyntaxKind.AmpersandAmpersandToken &&
      operator !== ts.SyntaxKind.BarBarToken &&
      operator !== ts.SyntaxKind.QuestionQuestionToken &&
      operator !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      return false;
    }
    return isEvaluationInert(value.left) && isEvaluationInert(value.right);
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.every(element =>
      !ts.isSpreadElement(element) && isEvaluationInert(element)
    );
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.every(property => {
      if (ts.isShorthandPropertyAssignment(property)) return true;
      return ts.isPropertyAssignment(property) &&
        !ts.isComputedPropertyName(property.name) &&
        isEvaluationInert(property.initializer);
    });
  }
  return false;
}

export function isInsideJsxAttribute(node: ts.Node, attribute: ts.JsxAttribute): boolean {
  return attribute.getStart() <= node.getStart() && node.end <= attribute.end;
}

export function isControlledInteractionProp(name: string): boolean {
  return /^(?:onChange|onChangeText|onCheckedChange|onSelect|onToggle|onValueChange)$/.test(name);
}

export function isValueTransitionProp(name: string): boolean {
  return isControlledInteractionProp(name) ||
    /^on(?:Change|Select|Toggle|Update)[A-Z][A-Za-z0-9]*$/.test(name) ||
    /^on[A-Z][A-Za-z0-9]*(?:Change|Select|Toggle|Update)$/.test(name);
}

export function isNonValueIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isJsxAttribute(parent) && parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node && !ts.isComputedPropertyName(parent.name)) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.propertyName === node) ||
    (ts.isExportSpecifier(parent) && parent.propertyName === node)
  );
}

export function isPureExpression(node: ts.Node): boolean {
  let pure = true;
  visit(node, current => {
    if (
      ts.isAwaitExpression(current) ||
      ts.isYieldExpression(current) ||
      ts.isNewExpression(current) ||
      ts.isCallExpression(current) ||
      (ts.isPropertyAccessExpression(current) && current.name.text === "current") ||
      ts.isDeleteExpression(current) ||
      ts.isPostfixUnaryExpression(current) ||
      (ts.isPrefixUnaryExpression(current) &&
        (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isBinaryExpression(current) && isAssignmentOperator(current.operatorToken.kind))
    ) {
      pure = false;
    }
  });
  return pure;
}

export function localBindingNames(
  owner: RuntimeFunctionLike,
  excluded: ts.Node | null
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const parameter of owner.parameters) collectBindingNames(parameter.name, names);
  function walk(node: ts.Node): void {
    if (node === excluded) return;
    if (ts.isVariableDeclaration(node)) collectBindingNames(node.name, names);
    if (ts.isFunctionDeclaration(node) && node.name) names.add(node.name.text);
    node.forEachChild(walk);
  }
  if (owner.body) walk(owner.body);
  return names;
}

export function rootIdentifier(expression: ts.Expression): ts.Identifier | null {
  let current = unwrapTransparentExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapTransparentExpression(current.expression);
  }
  return ts.isIdentifier(current) ? current : null;
}

export function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function bindingNameContains(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(element =>
    !ts.isOmittedExpression(element) && bindingNameContains(element.name, name)
  );
}
