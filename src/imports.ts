import ts from "typescript";

export interface HookImports {
  batch: ReadonlySet<string>;
  hostComponents: ReadonlySet<string>;
  lazy: ReadonlySet<string>;
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
  useMount: ReadonlySet<string>;
  useObservable: ReadonlySet<string>;
  useObserveEffect: ReadonlySet<string>;
  useRef: ReadonlySet<string>;
  useState: ReadonlySet<string>;
  useTransition: ReadonlySet<string>;
  useUnmount: ReadonlySet<string>;
  useValue: ReadonlySet<string>;
}

const REACT_MODULE = "react",
  LEGEND_REACT_MODULE = "@legendapp/state/react";

export function collectHookImports(sourceFile: ts.SourceFile): HookImports {
  const batch = new Set<string>(),
    reactNamespaces = new Set<string>(),
    legendNamespaces = new Set<string>(),
    legendReactNamespaces = new Set<string>(),
    legacyUseValue = new Set<string>(),
    hostComponents = new Set<string>(),
    lazy = new Set<string>(),
    observable = new Set<string>(),
    observableTypes = new Set<string>(),
    startTransition = new Set<string>(),
    useCallback = new Set<string>(),
    useEffect = new Set<string>(),
    useInsertionEffect = new Set<string>(),
    useImperativeHandle = new Set<string>(),
    useLayoutEffect = new Set<string>(),
    useMemo = new Set<string>(),
    useMount = new Set<string>(),
    useObservable = new Set<string>(),
    useObserveEffect = new Set<string>(),
    useRef = new Set<string>(),
    useState = new Set<string>(),
    useTransition = new Set<string>(),
    useUnmount = new Set<string>(),
    useValue = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    const moduleName = statement.moduleSpecifier.text,
      clause = statement.importClause;
    if (!clause) {
      continue;
    }

    if (moduleName === REACT_MODULE && clause.name) {
      reactNamespaces.add(clause.name.text);
    }

    const bindings = clause.namedBindings;
    if (moduleName === "@legendapp/state" && bindings && ts.isNamespaceImport(bindings)) {
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
      const importedName = element.propertyName?.text ?? element.name.text,
        localName = element.name.text;
      if (moduleName === "react-native") {
        hostComponents.add(localName);
      }
      if (moduleName === REACT_MODULE) {
        if (importedName === "lazy") {
          lazy.add(localName);
        }
        if (importedName === "useState") {
          useState.add(localName);
        }
        if (importedName === "useCallback") {
          useCallback.add(localName);
        }
        if (importedName === "useEffect") {
          useEffect.add(localName);
        }
        if (importedName === "useInsertionEffect") {
          useInsertionEffect.add(localName);
        }
        if (importedName === "useImperativeHandle") {
          useImperativeHandle.add(localName);
        }
        if (importedName === "useLayoutEffect") {
          useLayoutEffect.add(localName);
        }
        if (importedName === "useMemo") {
          useMemo.add(localName);
        }
        if (importedName === "useRef") {
          useRef.add(localName);
        }
        if (importedName === "useTransition") {
          useTransition.add(localName);
        }
        if (importedName === "startTransition") {
          startTransition.add(localName);
        }
      }
      if (moduleName === LEGEND_REACT_MODULE) {
        if (importedName === "useSelector" || importedName === "use$") {
          legacyUseValue.add(localName);
        }
        if (importedName === "useObservable") {
          useObservable.add(localName);
        }
        if (importedName === "useObserveEffect") {
          useObserveEffect.add(localName);
        }
        if (importedName === "useMount") {
          useMount.add(localName);
        }
        if (importedName === "useUnmount") {
          useUnmount.add(localName);
        }
        if (importedName === "useValue") {
          useValue.add(localName);
        }
      }
      if (moduleName === "@legendapp/state") {
        if (importedName === "batch") {
          batch.add(localName);
        }
        if (importedName === "observable") {
          observable.add(localName);
        }
        if (importedName === "Observable" || importedName === "ObservableParam") {
          observableTypes.add(localName);
        }
      }
    }
  }

  return {
    batch,
    hostComponents,
    lazy,
    legacyUseValue,
    legendNamespaces,
    legendReactNamespaces,
    observable,
    observableTypes,
    reactNamespaces,
    startTransition,
    useCallback,
    useEffect,
    useImperativeHandle,
    useInsertionEffect,
    useLayoutEffect,
    useMemo,
    useMount,
    useObservable,
    useObserveEffect,
    useRef,
    useState,
    useTransition,
    useUnmount,
    useValue,
  };
}

export function isImportedHookCall(
  call: ts.CallExpression,
  localNames: ReadonlySet<string>,
  namespaceNames: ReadonlySet<string>,
  canonicalName:
    | "useCallback"
    | "useEffect"
    | "useImperativeHandle"
    | "useInsertionEffect"
    | "useLayoutEffect"
    | "useMemo"
    | "useMount"
    | "useRef"
    | "useState"
    | "useUnmount"
    | "useValue",
): boolean {
  const { expression } = call;
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
