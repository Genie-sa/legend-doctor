import type { AnalysisContext } from "./analysis-context.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { componentReferences } from "./component-references.js";
import { pathIdentityKey } from "../../core/path-identity.js";
import ts from "typescript";

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
  const { complete, references } = componentReferences(context, {
    declarationName: owner.name,
    file: pathIdentityKey(owner.getSourceFile().fileName),
    name: owner.name.text,
  });
  return complete && safeCallCount(references, path) > 0;
}

function safeCallCount(references: readonly ts.Identifier[], path: readonly string[]): number {
  let calls = 0;
  for (const reference of references) {
    const count = safeReference(reference, path);
    if (count === null) {
      return 0;
    }
    calls += count;
  }
  return calls;
}

function safeReference(reference: ts.Identifier, path: readonly string[]): number | null {
  const { parent } = reference;
  if (ts.isJsxClosingElement(parent) && parent.tagName === reference) {
    return 0;
  }
  return (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) &&
    parent.tagName === reference &&
    literalProp(parent, path)
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
