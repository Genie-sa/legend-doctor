import { propertyNameText, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { collectHookImports } from "../../core/imports.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

/** Primitive paths from explicit local types, or literal observable seeds. No imported type guessing. */
export function primitiveDeclarationPaths(
  declaration: ts.VariableDeclaration,
  forwardedGeneric = false,
): ReadonlySet<string> {
  const paths = new Set<string>();
  const call = declaration.initializer;
  if (!call || !ts.isCallExpression(call)) {
    return paths;
  }
  const direct = directValueFactory(call);
  if (!direct && !forwardedGeneric) {
    return paths;
  }
  collectCallPaths(call, paths, direct);
  return paths;
}

function collectCallPaths(call: ts.CallExpression, paths: Set<string>, direct: boolean): void {
  const type = call.typeArguments?.[0];
  if (type) {
    collectType(type, "", { paths, seen: new Set() });
  } else if (direct && call.arguments[0]) {
    collectLiteral(unwrapTransparentExpression(call.arguments[0]), "", paths);
  }
}

function directValueFactory(call: ts.CallExpression): boolean {
  const imports = collectHookImports(call.getSourceFile());
  return (
    ts.isIdentifier(call.expression) &&
    (imports.observable.has(call.expression.text) ||
      imports.useObservable.has(call.expression.text))
  );
}

function collectLiteral(value: ts.Expression, prefix: string, paths: Set<string>): void {
  if (
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword
  ) {
    paths.add(prefix);
  } else if (
    ts.isObjectLiteralExpression(value) &&
    value.properties.every(ts.isPropertyAssignment)
  ) {
    for (const property of value.properties) {
      const name = propertyNameText(property.name);
      if (name !== null) {
        collectLiteral(property.initializer, prefix ? `${prefix}.${name}` : name, paths);
      }
    }
  }
}

function collectType(
  type: ts.TypeNode,
  prefix: string,
  { paths, seen }: { paths: Set<string>; seen: Set<ts.Node> },
): void {
  if (seen.has(type)) {
    return;
  }
  seen.add(type);
  if (primitiveType(type)) {
    paths.add(prefix);
  } else if (ts.isTypeLiteralNode(type)) {
    collectMembers(type.members, prefix, { paths, seen });
  } else if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    collectReference(type, prefix, { paths, seen });
  }
}

function collectReference(
  type: ts.TypeReferenceNode,
  prefix: string,
  { paths, seen }: { paths: Set<string>; seen: Set<ts.Node> },
): void {
  const name = type.typeName.getText();
  const declarations = type
    .getSourceFile()
    .statements.filter(
      (statement) =>
        (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
        statement.name.text === name,
    );
  const declaration = declarations.length === 1 ? declarations[0] : null;
  if (declaration && ts.isInterfaceDeclaration(declaration) && !declaration.heritageClauses) {
    collectMembers(declaration.members, prefix, { paths, seen });
  } else if (declaration && ts.isTypeAliasDeclaration(declaration)) {
    collectType(declaration.type, prefix, { paths, seen });
  }
}

export function primitiveType(type: ts.TypeNode): boolean {
  return (
    [
      ts.SyntaxKind.StringKeyword,
      ts.SyntaxKind.NumberKeyword,
      ts.SyntaxKind.BooleanKeyword,
      ts.SyntaxKind.UndefinedKeyword,
      ts.SyntaxKind.NullKeyword,
    ].includes(type.kind) ||
    (ts.isLiteralTypeNode(type) &&
      (ts.isStringLiteralLike(type.literal) ||
        ts.isNumericLiteral(type.literal) ||
        [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
          type.literal.kind,
        ))) ||
    (ts.isUnionTypeNode(type) && type.types.every(primitiveType))
  );
}

function collectMembers(
  members: ts.NodeArray<ts.TypeElement>,
  prefix: string,
  { paths, seen }: { paths: Set<string>; seen: Set<ts.Node> },
): void {
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.type) {
      continue;
    }
    const name = propertyNameText(member.name);
    if (name !== null) {
      collectType(member.type, prefix ? `${prefix}.${name}` : name, { paths, seen });
    }
  }
}

export function localPrimitivePaths(
  sourceFile: ts.SourceFile,
  bindings: ReadonlySet<string>,
): ReadonlySet<string> {
  const paths = new Set<string>();
  const declarations: ts.VariableDeclaration[] = [];
  visit(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node)) {
      declarations.push(node);
    }
  });
  visit(sourceFile, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !bindings.has(node.name.text) ||
      declarations.filter((item) => item.name.getText() === node.name.getText()).length !== 1
    ) {
      return;
    }
    for (const suffix of primitiveDeclarationPaths(node)) {
      paths.add(suffix ? `${node.name.text}.${suffix}` : node.name.text);
    }
  });
  return paths;
}
