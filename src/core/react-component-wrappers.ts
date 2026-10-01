import ts from "typescript";

import { unwrapTransparentExpression } from "./analysis-ast.js";

const LEGEND_WRAPPER_EXPORTS: ReadonlySet<string> = new Set(["observer", "reactiveObserver"]);
const REACT_WRAPPER_EXPORTS: ReadonlySet<string> = new Set(["memo", "forwardRef"]);

export interface ReactComponentWrappers {
  names: ReadonlySet<string>;
  namespaces: ReadonlySet<string>;
}

export function collectReactComponentWrappers(sourceFile: ts.SourceFile): ReactComponentWrappers {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    collectImportedWrappers(statement, names, namespaces);
  }
  addConstAliases(sourceFile, names);
  return { names, namespaces };
}

export function isReactComponentWrapper(
  expression: ts.LeftHandSideExpression,
  wrappers: ReactComponentWrappers,
): boolean {
  return ts.isIdentifier(expression)
    ? wrappers.names.has(expression.text)
    : ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        wrappers.namespaces.has(expression.expression.text) &&
        (expression.name.text === "memo" || expression.name.text === "forwardRef");
}

function collectImportedWrappers(
  statement: ts.Statement,
  names: Set<string>,
  namespaces: Set<string>,
): void {
  const reactClause = moduleImportClause(statement, "react");
  if (reactClause) {
    collectWrapperBindings(reactClause, names, namespaces);
    return;
  }
  const legendBindings = moduleImportClause(statement, "@legendapp/state/react")?.namedBindings;
  if (legendBindings && ts.isNamedImports(legendBindings)) {
    collectWrapperNames(legendBindings, LEGEND_WRAPPER_EXPORTS, names);
  }
}

function moduleImportClause(statement: ts.Statement, moduleName: string): ts.ImportClause | null {
  if (
    !ts.isImportDeclaration(statement) ||
    !ts.isStringLiteral(statement.moduleSpecifier) ||
    statement.moduleSpecifier.text !== moduleName
  ) {
    return null;
  }
  const clause = statement.importClause;
  return clause && !clause.isTypeOnly ? clause : null;
}

function collectWrapperBindings(
  clause: ts.ImportClause,
  names: Set<string>,
  namespaces: Set<string>,
): void {
  if (clause.name) {
    namespaces.add(clause.name.text);
  }
  const { namedBindings } = clause;
  if (!namedBindings) {
    return;
  }
  if (ts.isNamespaceImport(namedBindings)) {
    namespaces.add(namedBindings.name.text);
    return;
  }
  collectWrapperNames(namedBindings, REACT_WRAPPER_EXPORTS, names);
}

function collectWrapperNames(
  namedImports: ts.NamedImports,
  wrapperExports: ReadonlySet<string>,
  names: Set<string>,
): void {
  for (const element of namedImports.elements) {
    if (element.isTypeOnly) {
      continue;
    }
    const imported = element.propertyName?.text ?? element.name.text;
    if (wrapperExports.has(imported)) {
      names.add(element.name.text);
    }
  }
}

function addConstAliases(sourceFile: ts.SourceFile, wrappers: Set<string>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of sourceFile.statements) {
      if (!isConstVariableStatement(statement)) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (addAliasForWrappedInitializer(declaration, wrappers)) {
          changed = true;
        }
      }
    }
  }
}

function isConstVariableStatement(statement: ts.Statement): statement is ts.VariableStatement {
  return (
    ts.isVariableStatement(statement) &&
    (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
  );
}

function addAliasForWrappedInitializer(
  declaration: ts.VariableDeclaration,
  wrappers: Set<string>,
): boolean {
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
    return false;
  }
  const source = unwrapTransparentExpression(declaration.initializer);
  if (
    !ts.isIdentifier(source) ||
    !wrappers.has(source.text) ||
    wrappers.has(declaration.name.text)
  ) {
    return false;
  }
  wrappers.add(declaration.name.text);
  return true;
}
