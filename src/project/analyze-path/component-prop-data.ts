import { findAncestor, identifiersNamed, visit } from "../../core/ast.js";
import type { AnalysisContext } from "./analysis-context.js";
import type { AnalysisFile } from "../analysis-project.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { pathIdentityKey } from "../../core/path-identity.js";
import ts from "typescript";

interface Target {
  file: string;
  name: string;
  owner: ts.FunctionDeclaration;
  path: readonly string[];
}

const NESTED_PROP_PATH_LENGTH = 2;

/** Closed, source-visible JSX callers must supply a fresh data literal, never a typed getter-capable object. */
export function componentPropDataPath(
  context: AnalysisContext,
  owner: RuntimeFunctionLike,
  path: readonly string[],
): boolean {
  if (!ts.isFunctionDeclaration(owner) || !owner.name || path.length !== NESTED_PROP_PATH_LENGTH) {
    return false;
  }
  const target: Target = {
    file: pathIdentityKey(owner.getSourceFile().fileName),
    name: owner.name.text,
    owner,
    path,
  };
  return safeProjectReferences(context, target);
}

function safeProjectReferences(context: AnalysisContext, target: Target): boolean {
  let calls = 0;
  for (const file of context.project.files) {
    if (untrackedTransport(file, target, context)) {
      return false;
    }
    for (const name of componentNames(file, target, context)) {
      const count = safeReferences(file, name, target);
      if (count === null) {
        return false;
      }
      calls += count;
    }
  }
  return calls > 0;
}

function componentNames(file: AnalysisFile, target: Target, context: AnalysisContext): string[] {
  const names = new Set(context.sourceIndex.componentsFor(file.originalPath));
  if (pathIdentityKey(file.originalPath) === target.file) {
    names.add(target.name);
  }
  return [...names].filter((name) => {
    const resolved = context.sourceIndex.componentDeclarationFor(file.originalPath, name);
    return (
      resolved &&
      pathIdentityKey(resolved.file) === target.file &&
      resolved.localName === target.name
    );
  });
}

function safeReferences(file: AnalysisFile, name: string, target: Target): number | null {
  let calls = 0;
  for (const reference of identifiersNamed(file.sourceFile, name)) {
    if (
      reference === target.owner.name ||
      findAncestor(reference, ts.isImportDeclaration) ||
      findAncestor(reference, ts.isTypeNode)
    ) {
      continue;
    }
    const count = safeReference(reference, target);
    if (count === null) {
      return null;
    }
    calls += count;
  }
  return calls;
}

function safeReference(reference: ts.Identifier, target: Target): number | null {
  const { parent } = reference;
  if (ts.isJsxClosingElement(parent) && parent.tagName === reference) {
    return 0;
  }
  return (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) &&
    parent.tagName === reference &&
    literalProp(parent, target.path)
    ? 1
    : null;
}

function literalProp(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  path: readonly string[],
): boolean {
  if (opening.attributes.properties.some(ts.isJsxSpreadAttribute)) {
    return false;
  }
  const matches = opening.attributes.properties.filter(
    (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText() === path[0],
  );
  if (matches.length === 0) {
    return true;
  }
  const [attribute] = matches;
  if (matches.length !== 1 || !attribute || !ts.isJsxAttribute(attribute)) {
    return false;
  }
  const { initializer } = attribute;
  return (
    initializer !== undefined &&
    ts.isJsxExpression(initializer) &&
    initializer.expression !== undefined &&
    literalMember(initializer.expression, path[1]!)
  );
}

function literalMember(value: ts.Expression, name: string): boolean {
  if (
    !ts.isObjectLiteralExpression(value) ||
    !value.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text !== "__proto__",
    )
  ) {
    return false;
  }
  const matches = value.properties.filter(
    (property) =>
      property.name &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name,
  );
  if (matches.length === 0) {
    return true;
  }
  const [property] = matches;
  if (matches.length !== 1 || !property || !ts.isPropertyAssignment(property)) {
    return false;
  }
  const selected = property.initializer;
  return (
    ts.isStringLiteralLike(selected) ||
    ts.isNumericLiteral(selected) ||
    [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
      selected.kind,
    )
  );
}

function untrackedTransport(file: AnalysisFile, target: Target, context: AnalysisContext): boolean {
  let unknown = false;
  visit(file.sourceFile, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !(
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      )
    ) {
      return;
    }
    const [specifier] = node.arguments;
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      unknown = true;
      return;
    }
    const module = context.sourceIndex.moduleFileFor(file.originalPath, specifier.text);
    if (module && pathIdentityKey(module) === target.file) {
      unknown = true;
    }
  });
  return (
    unknown ||
    file.sourceFile.statements.some((statement) =>
      untrackedStaticTransport(statement, { file, target }, context),
    )
  );
}
function untrackedStaticTransport(
  statement: ts.Statement,
  { file, target }: { file: AnalysisFile; target: Target },
  context: AnalysisContext,
): boolean {
  if (
    (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
    !statement.moduleSpecifier ||
    !ts.isStringLiteral(statement.moduleSpecifier)
  ) {
    return false;
  }
  const module = context.sourceIndex.moduleFileFor(
    file.originalPath,
    statement.moduleSpecifier.text,
  );
  if (!module || pathIdentityKey(module) !== target.file) {
    return false;
  }
  if (ts.isExportDeclaration(statement)) {
    return !statement.isTypeOnly;
  }
  const clause = statement.importClause;
  return (
    !clause ||
    (!clause.isTypeOnly &&
      (clause.name !== undefined ||
        !clause.namedBindings ||
        ts.isNamespaceImport(clause.namedBindings)))
  );
}
