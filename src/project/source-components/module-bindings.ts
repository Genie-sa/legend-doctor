import type { ComponentFunction, ModuleRecordDraft, ModuleSignals } from "./model.js";
import type { ReactComponentWrappers } from "../../core/react-component-wrappers.js";
import { isReactComponentWrapper } from "../../core/react-component-wrappers.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "./declaration-shapes.js";

const MAX_OBJECT_ASSIGN_ALIAS_DEPTH = 4;

const OBJECT_ASSIGN_MINIMUM_ARGUMENTS = 2;

export function collectImportBindings(
  clause: ts.ImportClause | undefined,
  draft: ModuleRecordDraft,
  moduleSpecifier: string,
): void {
  if (!clause || clause.isTypeOnly) {
    return;
  }
  if (clause.name) {
    draft.imports.set(clause.name.text, { importedName: "default", moduleSpecifier });
  }
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    collectNamedImportBindings(bindings, draft, moduleSpecifier);
    return;
  }
  if (bindings && ts.isNamespaceImport(bindings)) {
    draft.imports.set(bindings.name.text, { importedName: "*", moduleSpecifier });
  }
}

function collectNamedImportBindings(
  bindings: ts.NamedImports,
  draft: ModuleRecordDraft,
  moduleSpecifier: string,
): void {
  for (const element of bindings.elements) {
    if (!element.isTypeOnly) {
      draft.imports.set(element.name.text, {
        importedName: element.propertyName?.text ?? element.name.text,
        moduleSpecifier,
      });
    }
  }
}

export function collectExportDeclaration(
  statement: ts.ExportDeclaration,
  draft: ModuleRecordDraft,
): void {
  const specifier = statement.moduleSpecifier;
  const clause = statement.exportClause;
  if (specifier && ts.isStringLiteral(specifier)) {
    collectReexports(clause, draft, specifier.text);
    return;
  }
  if (clause && ts.isNamedExports(clause)) {
    for (const element of clause.elements) {
      draft.localExports.set(element.name.text, element.propertyName?.text ?? element.name.text);
    }
  }
}

function collectReexports(
  clause: ts.NamedExportBindings | undefined,
  draft: ModuleRecordDraft,
  moduleSpecifier: string,
): void {
  if (!clause) {
    draft.starExports.push(moduleSpecifier);
    return;
  }
  if (!ts.isNamedExports(clause)) {
    return;
  }
  for (const element of clause.elements) {
    draft.reexports.set(element.name.text, {
      importedName: element.propertyName?.text ?? element.name.text,
      moduleSpecifier,
    });
  }
}

export function collectExportAssignment(
  statement: ts.ExportAssignment,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const expression = unwrapTransparentExpression(statement.expression);
  if (ts.isIdentifier(expression)) {
    const component = staticAssignedComponentName(
      signals.sourceFile,
      expression.text,
      draft.componentDeclarations,
    );
    draft.localExports.set("default", component ?? expression.text);
    return;
  }
  if (ts.isCallExpression(expression)) {
    collectWrappedDefaultExport(expression, draft, signals);
    return;
  }
  if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression)) {
    collectDefaultDeferredOwner(expression.expression.text, draft, signals);
  }
}

function collectWrappedDefaultExport(
  expression: ts.CallExpression,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const wrapped = reactWrappedComponentName(expression, signals.componentWrappers);
  const component = wrapped
    ? staticAssignedComponentName(signals.sourceFile, wrapped, draft.componentDeclarations)
    : null;
  if (component) {
    draft.localExports.set("default", component);
  }
}

function collectDefaultDeferredOwner(
  className: string,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const methods = signals.deferredMethodsByClass.get(className);
  if (methods) {
    draft.deferredCallbackOwners.set("default", methods);
    draft.localExports.set("default", "default");
  }
}

function staticAssignedComponentName(
  sourceFile: ts.SourceFile,
  exportedName: string,
  components: ReadonlyMap<string, ComponentFunction>,
): string | null {
  let current = exportedName;
  const visited = new Set<string>();
  for (let depth = 0; depth <= MAX_OBJECT_ASSIGN_ALIAS_DEPTH; depth += 1) {
    if (components.has(current)) {
      return current;
    }
    const next = nextObjectAssignAlias(sourceFile, current, visited);
    if (!next) {
      return null;
    }
    current = next;
  }
  return null;
}

function nextObjectAssignAlias(
  sourceFile: ts.SourceFile,
  current: string,
  visited: Set<string>,
): string | null {
  if (visited.has(current) || topLevelValueDeclarationCount(sourceFile, "Object") > 0) {
    return null;
  }
  visited.add(current);
  return objectAssignAliasTarget(sourceFile, current);
}

function objectAssignAliasTarget(sourceFile: ts.SourceFile, current: string): string | null {
  const declarations = variableDeclarationsNamed(sourceFile, current);
  const declaration = declarations.length === 1 ? declarations[0] : null;
  const initializer = declaration?.initializer
    ? unwrapTransparentExpression(declaration.initializer)
    : null;
  if (
    !declaration ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    !initializer ||
    !ts.isCallExpression(initializer) ||
    !isObjectAssignCallee(initializer.expression) ||
    !initializer.arguments[0] ||
    !ts.isIdentifier(initializer.arguments[0]) ||
    initializer.arguments.length < OBJECT_ASSIGN_MINIMUM_ARGUMENTS ||
    !initializer.arguments
      .slice(1)
      .every((argument) => ts.isObjectLiteralExpression(unwrapTransparentExpression(argument)))
  ) {
    return null;
  }
  return initializer.arguments[0].text;
}

function isObjectAssignCallee(callee: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object" &&
    callee.name.text === "assign"
  );
}

function variableDeclarationsNamed(
  sourceFile: ts.SourceFile,
  name: string,
): readonly ts.VariableDeclaration[] {
  return sourceFile.statements.flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.filter(
          (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
        )
      : [],
  );
}

function topLevelValueDeclarationCount(sourceFile: ts.SourceFile, name: string): number {
  let count = 0;
  for (const statement of sourceFile.statements) {
    count += statementValueDeclarationCount(statement, name);
  }
  return count;
}

function statementValueDeclarationCount(statement: ts.Statement, name: string): number {
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name?.text === name
  ) {
    return 1;
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.filter((declaration) =>
      bindingNameContains(declaration.name, name),
    ).length;
  }
  return ts.isImportDeclaration(statement) ? importedBindingCount(statement, name) : 0;
}

function importedBindingCount(statement: ts.ImportDeclaration, name: string): number {
  const clause = statement.importClause;
  const bindings = clause?.namedBindings;
  const namespace =
    bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name ? 1 : 0;
  const named =
    bindings && ts.isNamedImports(bindings)
      ? bindings.elements.filter((element) => element.name.text === name).length
      : 0;
  return (clause?.name?.text === name ? 1 : 0) + namespace + named;
}

function bindingNameContains(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) {
    return binding.text === name;
  }
  return binding.elements.some(
    (element) => ts.isBindingElement(element) && bindingNameContains(element.name, name),
  );
}

function reactWrappedComponentName(
  call: ts.CallExpression,
  wrappers: ReactComponentWrappers,
): string | null {
  const component = call.arguments[0] ? unwrapTransparentExpression(call.arguments[0]) : null;
  return isReactComponentWrapper(call.expression, wrappers) &&
    component &&
    ts.isIdentifier(component)
    ? component.text
    : null;
}
