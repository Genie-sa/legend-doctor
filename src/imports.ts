import ts from "typescript";

export interface HookImports {
  batch: ReadonlySet<string>;
  hostComponents: ReadonlySet<string>;
  legendNamespaces: ReadonlySet<string>;
  legendReactNamespaces: ReadonlySet<string>;
  legacyUseValue: ReadonlySet<string>;
  observable: ReadonlySet<string>;
  observableTypes: ReadonlySet<string>;
  reactNamespaces: ReadonlySet<string>;
  startTransition: ReadonlySet<string>;
  useCallback: ReadonlySet<string>;
  useEffect: ReadonlySet<string>;
  useInsertionEffect: ReadonlySet<string>;
  useImperativeHandle: ReadonlySet<string>;
  useLayoutEffect: ReadonlySet<string>;
  useMemo: ReadonlySet<string>;
  useObservable: ReadonlySet<string>;
  useObserveEffect: ReadonlySet<string>;
  useRef: ReadonlySet<string>;
  useState: ReadonlySet<string>;
  useTransition: ReadonlySet<string>;
  useValue: ReadonlySet<string>;
}

const REACT_MODULE = "react";
const LEGEND_REACT_MODULE = "@legendapp/state/react";

export function collectHookImports(sourceFile: ts.SourceFile): HookImports {
  const batch = new Set<string>();
  const reactNamespaces = new Set<string>();
  const legendNamespaces = new Set<string>();
  const legendReactNamespaces = new Set<string>();
  const legacyUseValue = new Set<string>();
  const hostComponents = new Set<string>();
  const observable = new Set<string>();
  const observableTypes = new Set<string>();
  const startTransition = new Set<string>();
  const useCallback = new Set<string>();
  const useEffect = new Set<string>();
  const useInsertionEffect = new Set<string>();
  const useImperativeHandle = new Set<string>();
  const useLayoutEffect = new Set<string>();
  const useMemo = new Set<string>();
  const useObservable = new Set<string>();
  const useObserveEffect = new Set<string>();
  const useRef = new Set<string>();
  const useState = new Set<string>();
  const useTransition = new Set<string>();
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
    if (
      moduleName === "@legendapp/state" &&
      bindings &&
      ts.isNamespaceImport(bindings)
    ) {
      legendNamespaces.add(bindings.name.text);
      continue;
    }
    if (moduleName === LEGEND_REACT_MODULE && bindings && ts.isNamespaceImport(bindings)) {
      legendReactNamespaces.add(bindings.name.text);
      continue;
    }
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
        if (importedName === "useCallback") useCallback.add(localName);
        if (importedName === "useEffect") useEffect.add(localName);
        if (importedName === "useInsertionEffect") useInsertionEffect.add(localName);
        if (importedName === "useImperativeHandle") useImperativeHandle.add(localName);
        if (importedName === "useLayoutEffect") useLayoutEffect.add(localName);
        if (importedName === "useMemo") useMemo.add(localName);
        if (importedName === "useRef") useRef.add(localName);
        if (importedName === "useTransition") useTransition.add(localName);
        if (importedName === "startTransition") startTransition.add(localName);
      }
      if (moduleName === LEGEND_REACT_MODULE) {
        if (importedName === "useSelector" || importedName === "use$") {
          legacyUseValue.add(localName);
        }
        if (importedName === "useObservable") useObservable.add(localName);
        if (importedName === "useObserveEffect") useObserveEffect.add(localName);
        if (importedName === "useValue") useValue.add(localName);
      }
      if (moduleName === "@legendapp/state") {
        if (importedName === "batch") batch.add(localName);
        if (importedName === "observable") observable.add(localName);
        if (importedName === "Observable" || importedName === "ObservableParam") {
          observableTypes.add(localName);
        }
      }
    }
  }

  return {
    batch,
    hostComponents,
    legendNamespaces,
    legendReactNamespaces,
    legacyUseValue,
    observable,
    observableTypes,
    reactNamespaces,
    startTransition,
    useCallback,
    useEffect,
    useInsertionEffect,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useObservable,
    useObserveEffect,
    useRef,
    useState,
    useTransition,
    useValue,
  };
}

export function isImportedHookCall(
  call: ts.CallExpression,
  localNames: ReadonlySet<string>,
  namespaceNames: ReadonlySet<string>,
  canonicalName: "useCallback" | "useEffect" | "useImperativeHandle" | "useMemo" | "useRef" | "useState" | "useValue"
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
