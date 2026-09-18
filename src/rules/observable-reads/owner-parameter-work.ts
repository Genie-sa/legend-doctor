import type { RuntimeFunctionLike } from "../../core/ast.js";
import { collectBindingNames } from "../../core/analysis-ast.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

/** Relocation must not skip independent work performed before the owner body. */
export function hasPlainOwnerParameters(owner: RuntimeFunctionLike): boolean {
  if (owner.parameters.length === 0) {
    return true;
  }
  const [parameter] = owner.parameters;
  return (
    owner.parameters.length === 1 &&
    parameter !== undefined &&
    !parameter.dotDotDotToken &&
    ts.isObjectBindingPattern(parameter.name) &&
    (!parameter.initializer ||
      (ts.isObjectLiteralExpression(parameter.initializer) &&
        parameter.initializer.properties.length === 0)) &&
    parameter.name.elements.every(
      (element) =>
        ts.isIdentifier(element.name) &&
        !element.dotDotDotToken &&
        (!element.propertyName || ts.isIdentifier(element.propertyName)) &&
        (!element.initializer || plainDefault(element.initializer)),
    )
  );
}

function plainDefault(value: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
      value.kind,
    ) ||
    (ts.isIdentifier(value) &&
      value.text === "undefined" &&
      unboundUndefined(value.getSourceFile()))
  );
}

function unboundUndefined(source: ts.SourceFile): boolean {
  let shadowed = false;
  visit(source, (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
      const names = new Set<string>();
      collectBindingNames(node.name, names);
      shadowed ||= names.has("undefined");
    } else if (
      (ts.isImportSpecifier(node) ||
        ts.isNamespaceImport(node) ||
        ts.isImportClause(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name?.text === "undefined"
    ) {
      shadowed = true;
    }
  });
  return !shadowed;
}
