import type { StateCandidate } from "../../analysis/model.js";
import { hasDirectPrimitiveInitializer } from "../state-proofs/state-proofs.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

export function isSetOrMapState(call: ts.CallExpression): boolean {
  const type = call.typeArguments?.[0];
  if (type && /^(?:Readonly)?(?:Set|Map)</u.test(type.getText())) {
    return true;
  }
  const [initial] = call.arguments;
  if (!initial) {
    return false;
  }
  if (isSetOrMapConstruction(initial)) {
    return true;
  }
  return (
    (ts.isArrowFunction(initial) || ts.isFunctionExpression(initial)) &&
    lazyInitializerReturnsSetOrMap(initial)
  );
}

function lazyInitializerReturnsSetOrMap(
  initial: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  if (!ts.isBlock(initial.body)) {
    return isSetOrMapConstruction(initial.body);
  }
  return initial.body.statements.some(
    (statement) =>
      ts.isReturnStatement(statement) &&
      statement.expression !== undefined &&
      isSetOrMapConstruction(statement.expression),
  );
}

function isSetOrMapConstruction(node: ts.Expression): boolean {
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === "Set" || node.expression.text === "Map")
  );
}

export function isArrayState(call: ts.CallExpression): boolean {
  const type = call.typeArguments?.[0];
  if (
    type &&
    (ts.isArrayTypeNode(type) ||
      (ts.isTypeReferenceNode(type) &&
        ["Array", "ReadonlyArray"].includes(type.typeName.getText())))
  ) {
    return true;
  }
  const [initial] = call.arguments;
  return initial !== undefined && ts.isArrayLiteralExpression(unwrapTransparentExpression(initial));
}

export function isNullableSetState(call: ts.CallExpression): boolean {
  const [initial] = call.arguments;
  const type = call.typeArguments?.[0];
  if (
    !initial ||
    initial.kind !== ts.SyntaxKind.NullKeyword ||
    !type ||
    !ts.isUnionTypeNode(type)
  ) {
    return false;
  }
  const values = type.types.filter((member) => member.kind !== ts.SyntaxKind.NullKeyword);
  return (
    values.length === 1 &&
    ts.isTypeReferenceNode(values[0]!) &&
    values[0]!.typeName.getText() === "Set"
  );
}

export function hasSupportedKeyedSelectionInitializer(state: StateCandidate): boolean {
  if (hasDirectPrimitiveInitializer(state)) {
    return true;
  }
  if (state.call.arguments.length > 0) {
    return false;
  }
  const type = state.call.typeArguments?.[0];
  return type !== undefined && primitiveScalarType(type);
}

export function primitiveScalarType(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type)) {
    return primitiveScalarType(type.type);
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.every(primitiveScalarType);
  }
  if (ts.isLiteralTypeNode(type)) {
    return true;
  }
  return [
    ts.SyntaxKind.StringKeyword,
    ts.SyntaxKind.NumberKeyword,
    ts.SyntaxKind.BooleanKeyword,
    ts.SyntaxKind.BigIntKeyword,
    ts.SyntaxKind.NullKeyword,
    ts.SyntaxKind.UndefinedKeyword,
  ].includes(type.kind);
}
