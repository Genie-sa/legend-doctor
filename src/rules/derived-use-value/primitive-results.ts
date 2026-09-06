import {
  bindingDeclarationCount,
  isAssignmentOperator,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

const PRIMITIVE_GLOBAL_VALUES: ReadonlySet<string> = new Set(["Infinity", "NaN", "undefined"]);
const PRIMITIVE_GLOBAL_CONSTRUCTORS: ReadonlySet<string> = new Set(["Boolean", "Number", "String"]);
const NUMBER_NAMESPACE = "Math";

/** Operators whose result is a primitive for every operand pair, including objects. */
const ALWAYS_PRIMITIVE_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.InstanceOfKeyword,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.SlashToken,
]);

/** Operators that return one of their operands unchanged. */
const OPERAND_SELECTING_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

const PRIMITIVE_PREFIX_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ExclamationToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.TildeToken,
]);

/** Owner scope plus the callback whose local `let` bindings may carry proven primitive values. */
export interface PrimitiveScope {
  readonly callback: ts.ArrowFunction | ts.FunctionExpression;
  readonly owner: RuntimeFunctionLike;
}

export function isProvablyPrimitive(expression: ts.Expression, scope: PrimitiveScope): boolean {
  const value = unwrapTransparentExpression(expression);
  if (isPrimitiveLiteral(value) || ts.isTypeOfExpression(value) || ts.isVoidExpression(value)) {
    return true;
  }
  if (ts.isIdentifier(value)) {
    return isPrimitiveIdentifier(value, scope);
  }
  return isPrimitiveComposite(value, scope);
}

function isPrimitiveComposite(value: ts.Expression, scope: PrimitiveScope): boolean {
  if (ts.isPrefixUnaryExpression(value)) {
    return PRIMITIVE_PREFIX_OPERATORS.has(value.operator);
  }
  if (ts.isBinaryExpression(value)) {
    return isPrimitiveBinary(value, scope);
  }
  if (ts.isConditionalExpression(value)) {
    return (
      isProvablyPrimitive(value.whenTrue, scope) && isProvablyPrimitive(value.whenFalse, scope)
    );
  }
  return ts.isCallExpression(value) && isPrimitiveGlobalCall(value, scope.owner);
}

function isPrimitiveLiteral(value: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(value) ||
    ts.isTemplateExpression(value) ||
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  );
}

function isPrimitiveBinary(value: ts.BinaryExpression, scope: PrimitiveScope): boolean {
  const operator = value.operatorToken.kind;
  if (ALWAYS_PRIMITIVE_OPERATORS.has(operator)) {
    return true;
  }
  return (
    OPERAND_SELECTING_OPERATORS.has(operator) &&
    isProvablyPrimitive(value.left, scope) &&
    isProvablyPrimitive(value.right, scope)
  );
}

function isUnshadowedGlobal(name: string, owner: RuntimeFunctionLike): boolean {
  return bindingDeclarationCount(owner, name) === 0;
}

function isPrimitiveGlobalCall(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    return PRIMITIVE_GLOBAL_CONSTRUCTORS.has(callee.text) && isUnshadowedGlobal(callee.text, owner);
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === NUMBER_NAMESPACE &&
    isUnshadowedGlobal(NUMBER_NAMESPACE, owner)
  );
}

function isPrimitiveIdentifier(identifier: ts.Identifier, scope: PrimitiveScope): boolean {
  if (PRIMITIVE_GLOBAL_VALUES.has(identifier.text)) {
    return isUnshadowedGlobal(identifier.text, scope.owner);
  }
  const declaration = callbackLocalDeclaration(identifier.text, scope);
  return (
    declaration !== null &&
    declaration.initializer !== undefined &&
    isProvablyPrimitive(declaration.initializer, scope) &&
    everyWriteIsPrimitive(identifier.text, scope)
  );
}

/** The single declaration of `name` inside the callback, or null when the name is shared or absent. */
function callbackLocalDeclaration(
  name: string,
  scope: PrimitiveScope,
): ts.VariableDeclaration | null {
  if (bindingDeclarationCount(scope.owner, name) !== 1) {
    return null;
  }
  let declaration: ts.VariableDeclaration | null = null;
  visit(scope.callback.body, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      declaration = node;
    }
  });
  return declaration;
}

function everyWriteIsPrimitive(name: string, scope: PrimitiveScope): boolean {
  let primitive = true;
  visit(scope.callback.body, (node) => {
    if (!primitive) {
      return;
    }
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      primitive = !writesName(node.left, name) || isPrimitiveAssignment(node, scope);
      return;
    }
    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      ts.isExpression(node.initializer) &&
      writesName(node.initializer, name)
    ) {
      primitive = false;
    }
  });
  return primitive;
}

function writesName(target: ts.Expression, name: string): boolean {
  const written = unwrapTransparentExpression(target);
  return ts.isIdentifier(written) && written.text === name;
}

function isPrimitiveAssignment(assignment: ts.BinaryExpression, scope: PrimitiveScope): boolean {
  const operator = assignment.operatorToken.kind;
  if (operator !== ts.SyntaxKind.EqualsToken && !isOperandSelectingAssignment(operator)) {
    return true;
  }
  return isProvablyPrimitive(assignment.right, scope);
}

function isOperandSelectingAssignment(operator: ts.SyntaxKind): boolean {
  return (
    operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    operator === ts.SyntaxKind.BarBarEqualsToken ||
    operator === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}
