import type { DerivedMemo } from "./derived-memos.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { visit } from "../../core/ast.js";

/** A closed component boundary: no commit work, child component contracts, refs, or escaped callers. */
export function hasPureRenderOwner(memo: DerivedMemo): boolean {
  const { owner } = memo;
  if (
    !ts.isFunctionDeclaration(owner) ||
    !owner.name ||
    !ts.isSourceFile(owner.parent) ||
    owner.parameters.length > 0 ||
    !owner.body ||
    owner.modifiers?.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.ExportKeyword ||
        modifier.kind === ts.SyntaxKind.DefaultKeyword,
    )
  ) {
    return false;
  }
  const allowedDeclarations = new Set<ts.Node>([
    memo.call.parent,
    ...memo.inputs.map((input) => input.declaration),
  ]);
  return (
    owner.body.statements.every((statement) =>
      pureStatement(statement, allowedDeclarations, memo.derivedName),
    ) && usesOnlyAsJsx(owner)
  );
}

function pureStatement(
  statement: ts.Statement,
  declarations: ReadonlySet<ts.Node>,
  derivedName: string,
): boolean {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.every((declaration) =>
      declarations.has(declaration),
    );
  }
  return (
    ts.isReturnStatement(statement) &&
    statement.expression !== undefined &&
    pureJsx(statement.expression, derivedName)
  );
}

function usesOnlyAsJsx(owner: ts.FunctionDeclaration): boolean {
  let safe = true;
  let used = false;
  visit(owner.getSourceFile(), (node) => {
    if (!ts.isIdentifier(node) || node === owner.name || node.text !== owner.name!.text) {
      return;
    }
    used = true;
    const { parent } = node;
    safe &&=
      (ts.isJsxOpeningElement(parent) ||
        ts.isJsxClosingElement(parent) ||
        ts.isJsxSelfClosingElement(parent)) &&
      parent.tagName === node;
  });
  return safe && used;
}

function pureJsx(expression: ts.Expression, derivedName: string): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isJsxSelfClosingElement(value)) {
    return pureOpening(value, derivedName);
  }
  if (ts.isJsxElement(value)) {
    return (
      pureOpening(value.openingElement, derivedName) &&
      value.children.every((child) => {
        if (ts.isJsxText(child)) {
          return true;
        }
        if (ts.isJsxExpression(child)) {
          return !child.expression || pureDisplay(child.expression, derivedName);
        }
        return pureJsx(child, derivedName);
      })
    );
  }
  return false;
}

function pureOpening(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  derivedName: string,
): boolean {
  return (
    ts.isIdentifier(opening.tagName) &&
    /^[a-z]+$/u.test(opening.tagName.text) &&
    opening.attributes.properties.every((attribute) => {
      if (
        !ts.isJsxAttribute(attribute) ||
        !ts.isIdentifier(attribute.name) ||
        attribute.name.text === "ref" ||
        attribute.name.text === "is"
      ) {
        return false;
      }
      const { initializer } = attribute;
      return (
        !initializer ||
        ts.isStringLiteral(initializer) ||
        (ts.isJsxExpression(initializer) &&
          initializer.expression !== undefined &&
          pureDisplay(initializer.expression, derivedName))
      );
    })
  );
}

function pureDisplay(expression: ts.Expression, derivedName: string): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isConditionalExpression(value)) {
    return (
      pureDisplay(value.condition, derivedName) &&
      pureDisplay(value.whenTrue, derivedName) &&
      pureDisplay(value.whenFalse, derivedName)
    );
  }
  return (
    (ts.isIdentifier(value) && value.text === derivedName) ||
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  );
}
