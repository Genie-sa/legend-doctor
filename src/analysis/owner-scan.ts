import { isDeclarationName, unwrapTransparentExpression } from "../core/analysis-ast.js";
import type { HookImports } from "../core/imports.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import ts from "typescript";
import { visit } from "../core/ast.js";

export function collectLocalComponents(
  sourceFile: ts.SourceFile,
  imports: HookImports,
): ReadonlySet<string> {
  const names = new Set<string>();
  visit(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && isComponentName(node.name.text)) {
      names.add(node.name.text);
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isComponentName(node.name.text) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer) ||
        isImportedReactLazyCall(node.initializer, imports))
    ) {
      names.add(node.name.text);
    }
  });
  return names;
}

function isImportedReactLazyCall(node: ts.Expression, imports: HookImports): boolean {
  const value = unwrapTransparentExpression(node);
  if (!ts.isCallExpression(value)) {
    return false;
  }
  if (ts.isIdentifier(value.expression)) {
    return imports.lazy.has(value.expression.text);
  }
  return (
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === "lazy" &&
    ts.isIdentifier(value.expression.expression) &&
    imports.reactNamespaces.has(value.expression.expression.text)
  );
}

export function collectPureProjectionImports(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    const clause = clsxImportClause(statement);
    if (clause) {
      addClsxBindingNames(clause, names);
    }
  }
  return names;
}

function clsxImportClause(statement: ts.Statement): ts.ImportClause | null {
  if (
    !ts.isImportDeclaration(statement) ||
    !ts.isStringLiteral(statement.moduleSpecifier) ||
    statement.moduleSpecifier.text !== "clsx" ||
    statement.importClause?.isTypeOnly
  ) {
    return null;
  }
  return statement.importClause ?? null;
}

function addClsxBindingNames(clause: ts.ImportClause, names: Set<string>): void {
  if (clause.name) {
    names.add(clause.name.text);
  }
  if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    return;
  }
  for (const specifier of clause.namedBindings.elements) {
    if (!specifier.isTypeOnly && (specifier.propertyName?.text ?? specifier.name.text) === "clsx") {
      names.add(specifier.name.text);
    }
  }
}

export function ownerDeclaresBinding(owner: RuntimeFunctionLike, name: string): boolean {
  let declared = false;
  visit(owner, (node) => {
    if (node !== owner && ts.isIdentifier(node) && node.text === name && isDeclarationName(node)) {
      declared = true;
    }
  });
  return declared;
}

function isComponentName(name: string): boolean {
  const [first] = name;
  return first !== undefined && first === first.toUpperCase();
}
