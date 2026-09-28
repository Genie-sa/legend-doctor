import { collectBindingNames, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { hasSoleSourceBinding } from "./independent-subscription-bindings.js";
import { outermostTransparentParent } from "./observable-paths.js";
import { sourceHasRuntimeBinding } from "../state-proofs/binding-lookup.js";
import ts from "typescript";

/**
 * A hook result bound through wrappers that return it unchanged whenever it is defined: parentheses,
 * type assertions, `!`, and a trailing `?? fallback`. `||` is excluded because it replaces falsy values.
 */
export interface WrappedUseValueResult {
  readonly call: ts.CallExpression;
  readonly fallback: ts.Expression | null;
}

export function wrappedUseValueResult(initializer: ts.Expression): WrappedUseValueResult | null {
  const value = unwrapTransparentExpression(initializer);
  if (ts.isBinaryExpression(value) && isNullishCoalescing(value)) {
    const call = unwrapTransparentExpression(value.left);
    return ts.isCallExpression(call) ? { call, fallback: value.right } : null;
  }
  return ts.isCallExpression(value) ? { call: value, fallback: null } : null;
}

/** The declaration that binds `call` through the wrappers `wrappedUseValueResult` accepts. */
export function wrappedResultDeclaration(call: ts.CallExpression): ts.VariableDeclaration | null {
  let placement = outermostTransparentParent(call);
  const { parent } = placement;
  if (ts.isBinaryExpression(parent) && isNullishCoalescing(parent) && parent.left === placement) {
    placement = outermostTransparentParent(parent);
  }
  const declaration = placement.parent;
  return ts.isVariableDeclaration(declaration) && declaration.initializer === placement
    ? declaration
    : null;
}

/** Evaluating the fallback has no effect and cannot throw, so deleting the declaration drops nothing. */
export function isInertFallback(fallback: ts.Expression): boolean {
  const value = unwrapTransparentExpression(fallback);
  return isPlainLiteral(value) || (ts.isIdentifier(value) && moduleBindingKind(value) !== null);
}

/** The fallback holds one value for the module's lifetime, so a read site may evaluate it again. */
export function isInvariantFallback(fallback: ts.Expression): boolean {
  const value = unwrapTransparentExpression(fallback);
  return isPlainLiteral(value) || (ts.isIdentifier(value) && moduleBindingKind(value) === "const");
}

function isNullishCoalescing(expression: ts.BinaryExpression): boolean {
  return expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken;
}

function isPlainLiteral(value: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(value) &&
      value.text === "undefined" &&
      !sourceHasRuntimeBinding(value.getSourceFile(), "undefined")) ||
    (ts.isPrefixUnaryExpression(value) &&
      value.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(value.operand))
  );
}

/** How the file's only binding of this name is declared, when that declaration is at module scope. */
function moduleBindingKind(identifier: ts.Identifier): "const" | "other" | null {
  const sourceFile = identifier.getSourceFile();
  const { text } = identifier;
  if (!hasSoleSourceBinding(sourceFile, text)) {
    return null;
  }
  for (const statement of sourceFile.statements) {
    const kind = statementBindingKind(statement, text);
    if (kind) {
      return kind;
    }
  }
  return null;
}

function statementBindingKind(statement: ts.Statement, name: string): "const" | "other" | null {
  if (ts.isImportDeclaration(statement)) {
    return importBinds(statement.importClause, name) ? "other" : null;
  }
  if (ts.isVariableStatement(statement)) {
    const names = new Set<string>();
    for (const declaration of statement.declarationList.declarations) {
      collectBindingNames(declaration.name, names);
    }
    if (!names.has(name)) {
      return null;
    }
    return statement.declarationList.flags & ts.NodeFlags.Const ? "const" : "other";
  }
  return (ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement)) &&
    statement.name?.text === name
    ? "other"
    : null;
}

function importBinds(clause: ts.ImportClause | undefined, name: string): boolean {
  if (!clause || clause.isTypeOnly) {
    return false;
  }
  const bindings = clause.namedBindings;
  return (
    clause.name?.text === name ||
    (bindings !== undefined && ts.isNamespaceImport(bindings) && bindings.name.text === name) ||
    (bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((element) => !element.isTypeOnly && element.name.text === name))
  );
}
