import ts from "typescript";

import { unwrapTransparentExpression } from "./analysis-ast.js";

export interface ReactComponentWrappers {
  names: ReadonlySet<string>;
  namespaces: ReadonlySet<string>;
}

export function collectReactComponentWrappers(
  sourceFile: ts.SourceFile
): ReactComponentWrappers {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "react"
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) namespaces.add(clause.name.text);
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      namespaces.add(clause.namedBindings.name.text);
    } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly) continue;
        const imported = element.propertyName?.text ?? element.name.text;
        if (imported === "memo" || imported === "forwardRef") names.add(element.name.text);
      }
    }
  }
  addConstAliases(sourceFile, names);
  return { names, namespaces };
}

export function isReactComponentWrapper(
  expression: ts.LeftHandSideExpression,
  wrappers: ReactComponentWrappers
): boolean {
  return ts.isIdentifier(expression)
    ? wrappers.names.has(expression.text)
    : ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      wrappers.namespaces.has(expression.expression.text) &&
      (expression.name.text === "memo" || expression.name.text === "forwardRef");
}

function addConstAliases(sourceFile: ts.SourceFile, wrappers: Set<string>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of sourceFile.statements) {
      if (
        !ts.isVariableStatement(statement) ||
        (statement.declarationList.flags & ts.NodeFlags.Const) === 0
      ) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const source = unwrapTransparentExpression(declaration.initializer);
        if (ts.isIdentifier(source) && wrappers.has(source.text) && !wrappers.has(declaration.name.text)) {
          wrappers.add(declaration.name.text);
          changed = true;
        }
      }
    }
  }
}
