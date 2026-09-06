import type { ChildComponentSource } from "./model.js";
import ts from "typescript";

function unwrapParenthesizedType(type: ts.TypeNode): ts.TypeNode {
  let current = type;
  while (ts.isParenthesizedTypeNode(current)) {
    current = current.type;
  }
  return current;
}

function soleTypeDeclaration(
  source: ChildComponentSource,
  typeName: string,
): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null {
  const declarations = source.owner
    .getSourceFile()
    .statements.filter(
      (statement): statement is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
        (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
        statement.name.text === typeName,
    );
  const [declaration] = declarations;
  return declarations.length === 1 && declaration ? declaration : null;
}

function declaredTypeMembers(
  declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
): ts.NodeArray<ts.TypeElement> | null {
  if (ts.isInterfaceDeclaration(declaration)) {
    return declaration.heritageClauses?.length ? null : declaration.members;
  }
  const alias = unwrapParenthesizedType(declaration.type);
  return ts.isTypeLiteralNode(alias) ? alias.members : null;
}

function propsTypeMembers(
  source: ChildComponentSource,
  propsType: ts.TypeNode,
): ts.NodeArray<ts.TypeElement> | null {
  if (ts.isTypeLiteralNode(propsType)) {
    return propsType.members;
  }
  if (!ts.isTypeReferenceNode(propsType) || !ts.isIdentifier(propsType.typeName)) {
    return null;
  }
  const declaration = soleTypeDeclaration(source, propsType.typeName.text);
  return declaration === null ? null : declaredTypeMembers(declaration);
}

export function declaredPropType(
  source: ChildComponentSource,
  propName: string,
): ts.TypeNode | null {
  const [parameter] = source.owner.parameters;
  if (!parameter?.type || source.owner.parameters.length !== 1) {
    return null;
  }
  const members = propsTypeMembers(source, unwrapParenthesizedType(parameter.type));
  if (!members) {
    return null;
  }

  const properties = members.filter(
    (member): member is ts.PropertySignature =>
      ts.isPropertySignature(member) && staticPropertyName(member.name) === propName,
  );
  const [property] = properties;
  return properties.length === 1 && property ? (property.type ?? null) : null;
}

function staticPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

export function primitiveValueType(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type)) {
    return primitiveValueType(type.type);
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.length > 0 && type.types.every(primitiveValueType);
  }
  if (ts.isLiteralTypeNode(type)) {
    return (
      ts.isStringLiteral(type.literal) ||
      ts.isNumericLiteral(type.literal) ||
      type.literal.kind === ts.SyntaxKind.TrueKeyword ||
      type.literal.kind === ts.SyntaxKind.FalseKeyword ||
      type.literal.kind === ts.SyntaxKind.NullKeyword
    );
  }
  return (
    type.kind === ts.SyntaxKind.BooleanKeyword ||
    type.kind === ts.SyntaxKind.StringKeyword ||
    type.kind === ts.SyntaxKind.NumberKeyword ||
    type.kind === ts.SyntaxKind.BigIntKeyword ||
    type.kind === ts.SyntaxKind.UndefinedKeyword
  );
}
