import {
  isAssignmentOperator,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { isRuntimeFunctionLike, visit } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";

export function callbackReadsSynchronously(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  name: string,
): boolean {
  let deferredRead = false;
  let reads = false;
  let shadowed = callback.parameters.some(
    (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name,
  );
  visit(callback.body, (node) => {
    if (ts.isIdentifier(node) && isDeclarationName(node) && node.text === name) {
      shadowed = true;
      return;
    }
    if (
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    reads = true;
    if (readIsDeferred(node, callback)) {
      deferredRead = true;
    }
  });
  return reads && !deferredRead && !shadowed;
}

function readIsDeferred(
  node: ts.Node,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== callback;
    current = current.parent
  ) {
    if (
      isRuntimeFunctionLike(current) &&
      current !== callback &&
      !isSynchronousEffectCallback(current)
    ) {
      return true;
    }
  }
  return false;
}

function outermostTransparentWrapper(node: ts.Node): ts.Node {
  let expression = node;
  while (
    ts.isParenthesizedExpression(expression.parent) ||
    ts.isAsExpression(expression.parent) ||
    ts.isTypeAssertionExpression(expression.parent) ||
    ts.isSatisfiesExpression(expression.parent) ||
    ts.isNonNullExpression(expression.parent)
  ) {
    expression = expression.parent;
  }
  return expression;
}

function isSynchronousEffectCallback(callback: RuntimeFunctionLike): boolean {
  if (
    callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    callback.asteriskToken
  ) {
    return false;
  }
  const expression = outermostTransparentWrapper(callback);
  const call = expression.parent;
  if (!ts.isCallExpression(call)) {
    return false;
  }
  if (call.expression === expression) {
    return true;
  }
  // SAFETY: Every transparent wrapper admitted above is an Expression, so the
  // The callback node remains an Expression when it appears in call.arguments.
  return (
    call.arguments.includes(expression as ts.Expression) &&
    ts.isPropertyAccessExpression(call.expression) &&
    /^(?:every|filter|find|findIndex|flatMap|forEach|map|reduce|reduceRight|some)$/u.test(
      call.expression.name.text,
    ) &&
    hasSynchronousArrayReceiver(call.expression.expression)
  );
}

function soleBindingDeclaration(
  receiver: ts.Identifier,
): ts.BindingElement | ts.ParameterDeclaration | ts.VariableDeclaration | null {
  const declarations: (ts.BindingElement | ts.ParameterDeclaration | ts.VariableDeclaration)[] = [];
  visit(receiver.getSourceFile(), (node) => {
    if (
      (ts.isBindingElement(node) || ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === receiver.text
    ) {
      declarations.push(node);
    }
  });
  return declarations.length === 1 ? declarations[0]! : null;
}

function declarationHasArrayType(
  declaration: ts.BindingElement | ts.ParameterDeclaration | ts.VariableDeclaration,
): boolean {
  if (ts.isBindingElement(declaration)) {
    return bindingElementHasArrayType(declaration);
  }
  return (
    isArrayTypeNode(declaration.type) ||
    (ts.isVariableDeclaration(declaration) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
      declaration.initializer !== undefined &&
      ts.isArrayLiteralExpression(unwrapTransparentExpression(declaration.initializer)))
  );
}

function hasSynchronousArrayReceiver(expression: ts.Expression): boolean {
  const receiver = unwrapTransparentExpression(expression);
  if (ts.isArrayLiteralExpression(receiver)) {
    return true;
  }
  if (!ts.isIdentifier(receiver)) {
    return false;
  }
  const declaration = soleBindingDeclaration(receiver);
  if (!declaration || arrayBindingHasDirectOverride(receiver)) {
    return false;
  }
  return declarationHasArrayType(declaration);
}

function arrayBindingHasDirectOverride(receiver: ts.Identifier): boolean {
  let overridden = false;
  visit(receiver.getSourceFile(), (node) => {
    if (overridden) {
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      expressionTargetsBinding(node.left, receiver.text)
    ) {
      overridden = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      expressionTargetsBinding(node.operand, receiver.text)
    ) {
      overridden = true;
      return;
    }
    if (ts.isDeleteExpression(node) && expressionTargetsBinding(node.expression, receiver.text)) {
      overridden = true;
    }
  });
  return overridden;
}

function expressionTargetsBinding(expression: ts.Expression, name: string): boolean {
  let current = unwrapTransparentExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) && current.text === name;
}

function bindingElementHasArrayType(element: ts.BindingElement): boolean {
  const pattern = element.parent;
  if (!ts.isObjectBindingPattern(pattern)) {
    return false;
  }
  const declaration = pattern.parent;
  if (
    !ts.isParameter(declaration) ||
    !declaration.type ||
    !ts.isTypeLiteralNode(declaration.type)
  ) {
    return false;
  }
  const propertyName = element.propertyName?.getText() ?? element.name.getText();
  return declaration.type.members.some(
    (member) =>
      ts.isPropertySignature(member) &&
      member.name?.getText() === propertyName &&
      isArrayTypeNode(member.type),
  );
}

function isArrayTypeNode(type: ts.TypeNode | undefined): boolean {
  if (!type) {
    return false;
  }
  if (ts.isArrayTypeNode(type)) {
    return true;
  }
  if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return isArrayTypeNode(type.type);
  }
  return false;
}
