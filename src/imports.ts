import ts from "typescript";

export interface HookImports {
  hostComponents: ReadonlySet<string>;
  reactNamespaces: ReadonlySet<string>;
  useEffect: ReadonlySet<string>;
  useObservable: ReadonlySet<string>;
  useObserveEffect: ReadonlySet<string>;
  useState: ReadonlySet<string>;
  useValue: ReadonlySet<string>;
}

const REACT_MODULE = "react";
const LEGEND_REACT_MODULE = "@legendapp/state/react";

export function collectHookImports(sourceFile: ts.SourceFile): HookImports {
  const reactNamespaces = new Set<string>();
  const hostComponents = new Set<string>();
  const useEffect = new Set<string>();
  const useObservable = new Set<string>();
  const useObserveEffect = new Set<string>();
  const useState = new Set<string>();
  const useValue = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    const moduleName = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) {
      continue;
    }

    if (moduleName === REACT_MODULE && clause.name) {
      reactNamespaces.add(clause.name.text);
    }

    const bindings = clause.namedBindings;
    if (moduleName === REACT_MODULE && bindings && ts.isNamespaceImport(bindings)) {
      reactNamespaces.add(bindings.name.text);
      continue;
    }
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }

    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      const localName = element.name.text;
      if (moduleName === "react-native") {
        hostComponents.add(localName);
      }
      if (moduleName === REACT_MODULE) {
        if (importedName === "useState") useState.add(localName);
        if (importedName === "useEffect") useEffect.add(localName);
      }
      if (moduleName === LEGEND_REACT_MODULE) {
        if (importedName === "useObservable") useObservable.add(localName);
        if (importedName === "useObserveEffect") useObserveEffect.add(localName);
        if (importedName === "useValue") useValue.add(localName);
      }
    }
  }

  return { hostComponents, reactNamespaces, useEffect, useObservable, useObserveEffect, useState, useValue };
}

export function isImportedHookCall(
  call: ts.CallExpression,
  localNames: ReadonlySet<string>,
  namespaceNames: ReadonlySet<string>,
  canonicalName: "useEffect" | "useState"
): boolean {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) {
    return localNames.has(expression.text);
  }
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    namespaceNames.has(expression.expression.text) &&
    expression.name.text === canonicalName
  );
}

export function isLocalHookCall(call: ts.CallExpression, localNames: ReadonlySet<string>): boolean {
  return ts.isIdentifier(call.expression) && localNames.has(call.expression.text);
}
