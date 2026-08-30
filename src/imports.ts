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

const LEGEND_MODULE = "@legendapp/state";
const LEGEND_REACT_MODULE = "@legendapp/state/react";
const REACT_MODULE = "react";
const HOST_COMPONENT_MODULE = "react-native";

type HookImportSets = { readonly [Key in keyof HookImports]: Set<string> };

const NAMESPACE_IMPORT_TARGETS = new Map<string, keyof HookImports>([
  [LEGEND_MODULE, "legendNamespaces"],
  [LEGEND_REACT_MODULE, "legendReactNamespaces"],
  [REACT_MODULE, "reactNamespaces"],
]);

const REACT_NAMED_IMPORT_TARGETS = new Map<string, keyof HookImports>([
  ["lazy", "lazy"],
  ["startTransition", "startTransition"],
  ["useCallback", "useCallback"],
  ["useEffect", "useEffect"],
  ["useImperativeHandle", "useImperativeHandle"],
  ["useInsertionEffect", "useInsertionEffect"],
  ["useLayoutEffect", "useLayoutEffect"],
  ["useMemo", "useMemo"],
  ["useRef", "useRef"],
  ["useState", "useState"],
  ["useTransition", "useTransition"],
]);

const LEGEND_REACT_NAMED_IMPORT_TARGETS = new Map<string, keyof HookImports>([
  ["use$", "legacyUseValue"],
  ["useMount", "useMount"],
  ["useObservable", "useObservable"],
  ["useObserveEffect", "useObserveEffect"],
  ["useSelector", "legacyUseValue"],
  ["useUnmount", "useUnmount"],
  ["useValue", "useValue"],
]);

const LEGEND_NAMED_IMPORT_TARGETS = new Map<string, keyof HookImports>([
  ["Observable", "observableTypes"],
  ["ObservableParam", "observableTypes"],
  ["batch", "batch"],
  ["observable", "observable"],
]);

const NAMED_IMPORT_TARGETS = new Map<string, ReadonlyMap<string, keyof HookImports>>([
  [LEGEND_MODULE, LEGEND_NAMED_IMPORT_TARGETS],
  [LEGEND_REACT_MODULE, LEGEND_REACT_NAMED_IMPORT_TARGETS],
  [REACT_MODULE, REACT_NAMED_IMPORT_TARGETS],
]);

function createHookImportSets(): HookImportSets {
  return {
    batch: new Set(),
    hostComponents: new Set(),
    lazy: new Set(),
    legacyUseValue: new Set(),
    legendNamespaces: new Set(),
    legendReactNamespaces: new Set(),
    observable: new Set(),
    observableTypes: new Set(),
    reactNamespaces: new Set(),
    startTransition: new Set(),
    useCallback: new Set(),
    useEffect: new Set(),
    useImperativeHandle: new Set(),
    useInsertionEffect: new Set(),
    useLayoutEffect: new Set(),
    useMemo: new Set(),
    useMount: new Set(),
    useObservable: new Set(),
    useObserveEffect: new Set(),
    useRef: new Set(),
    useState: new Set(),
    useTransition: new Set(),
    useUnmount: new Set(),
    useValue: new Set(),
  };
}

function collectNamespaceName(sets: HookImportSets, moduleName: string, localName: string): void {
  const target = NAMESPACE_IMPORT_TARGETS.get(moduleName);
  if (target) {
    sets[target].add(localName);
  }
}

function collectNamedImportNames(
  sets: HookImportSets,
  moduleName: string,
  elements: readonly ts.ImportSpecifier[],
): void {
  const targets = NAMED_IMPORT_TARGETS.get(moduleName);
  for (const element of elements) {
    const localName = element.name.text;
    if (moduleName === HOST_COMPONENT_MODULE) {
      sets.hostComponents.add(localName);
    }
    const target = targets?.get(element.propertyName?.text ?? localName);
    if (target) {
      sets[target].add(localName);
    }
  }
}

function collectClauseNames(
  sets: HookImportSets,
  moduleName: string,
  clause: ts.ImportClause,
): void {
  if (moduleName === REACT_MODULE && clause.name) {
    sets.reactNamespaces.add(clause.name.text);
  }
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    collectNamespaceName(sets, moduleName, bindings.name.text);
    return;
  }
  if (bindings && ts.isNamedImports(bindings)) {
    collectNamedImportNames(sets, moduleName, bindings.elements);
  }
}

function collectStatementImports(sets: HookImportSets, statement: ts.Statement): void {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
    return;
  }
  const clause = statement.importClause;
  if (!clause) {
    return;
  }
  collectClauseNames(sets, statement.moduleSpecifier.text, clause);
}

export function collectHookImports(sourceFile: ts.SourceFile): HookImports {
  const sets = createHookImportSets();
  for (const statement of sourceFile.statements) {
    collectStatementImports(sets, statement);
  }
  return sets;
}

export interface HookCallQuery {
  readonly call: ts.CallExpression;
  readonly canonicalName:
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
    | "useValue";
  readonly localNames: ReadonlySet<string>;
  readonly namespaceNames: ReadonlySet<string>;
}

export function isImportedHookCall({
  call,
  canonicalName,
  localNames,
  namespaceNames,
}: HookCallQuery): boolean {
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
