import { isRuntimeFunctionLike, visitSkippingNestedRuntimeFunctions } from "./ast.js";
import type { RuntimeFunctionLike } from "./ast.js";
import { collectBindingNames } from "./analysis-ast.js";
import ts from "typescript";

export type LegendReactComponent = "Computed" | "For" | "Memo" | "Show" | "Switch";

export type LegendReaction =
  | "observe"
  | "useObserve"
  | "useObserveEffect"
  | "useWhen"
  | "useWhenReady"
  | "when"
  | "whenReady";

export interface HookImports {
  batch: ReadonlySet<string>;
  /** Local names whose JSX tags render host surfaces, including Legend's reactive host wrappers. */
  hostComponents: ReadonlySet<string>;
  /** Local names whose members render host surfaces, such as `$React` or a `react-native` namespace. */
  hostNamespaces: ReadonlySet<string>;
  lazy: ReadonlySet<string>;
  legendNamespaces: ReadonlySet<string>;
  /** Local names of Legend's reactive control-flow components, keyed to their canonical export. */
  legendReactComponents: ReadonlyMap<string, LegendReactComponent>;
  legendReactNamespaces: ReadonlySet<string>;
  /** Local names of `observe`, `when`, and their hook forms, keyed to their canonical export. */
  legendReactions: ReadonlyMap<string, LegendReaction>;
  /** Local names of `observer` and `reactiveObserver`, which track `get()` calls in a render body. */
  legendObservers: ReadonlySet<string>;
  legendSyncNamespaces: ReadonlySet<string>;
  legacyUseValue: ReadonlySet<string>;
  linked: ReadonlySet<string>;
  observable: ReadonlySet<string>;
  observableTypes: ReadonlySet<string>;
  /** Local names of the `reactive` factory that adds `$`-prefixed selector props to a component. */
  reactiveFactories: ReadonlySet<string>;
  /** Local names of reactive host components: `$React` from react-web and `$View`-style native imports. */
  reactiveHosts: ReadonlySet<string>;
  reactNamespaces: ReadonlySet<string>;
  startTransition: ReadonlySet<string>;
  syncState: ReadonlySet<string>;
  synced: ReadonlySet<string>;
  useCallback: ReadonlySet<string>;
  useComputed: ReadonlySet<string>;
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

export type HostTagImports = Pick<HookImports, "hostComponents" | "hostNamespaces">;

const LEGEND_MODULE = "@legendapp/state";
const LEGEND_REACT_MODULE = "@legendapp/state/react";
const LEGEND_REACT_NATIVE_MODULE = "@legendapp/state/react-native";
const LEGEND_REACT_WEB_MODULE = "@legendapp/state/react-web";
const LEGEND_SYNC_MODULE = "@legendapp/state/sync";
const REACT_MODULE = "react";
const HOST_COMPONENT_MODULE = "react-native";

type SetImportKey = Exclude<keyof HookImports, "legendReactComponents" | "legendReactions">;

type HookImportSets = Readonly<Record<SetImportKey, Set<string>>> & {
  readonly legendReactComponents: Map<string, LegendReactComponent>;
  readonly legendReactions: Map<string, LegendReaction>;
};

const NAMESPACE_IMPORT_TARGETS = new Map<string, SetImportKey>([
  [HOST_COMPONENT_MODULE, "hostNamespaces"],
  [LEGEND_MODULE, "legendNamespaces"],
  [LEGEND_REACT_MODULE, "legendReactNamespaces"],
  [LEGEND_REACT_NATIVE_MODULE, "hostNamespaces"],
  [LEGEND_REACT_WEB_MODULE, "hostNamespaces"],
  [LEGEND_SYNC_MODULE, "legendSyncNamespaces"],
  [REACT_MODULE, "reactNamespaces"],
]);

/** Modules whose every named export renders a host surface. */
const HOST_COMPONENT_MODULES = new Set([HOST_COMPONENT_MODULE, LEGEND_REACT_NATIVE_MODULE]);

const REACT_NAMED_IMPORT_TARGETS = new Map<string, SetImportKey>([
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

const LEGEND_REACT_NAMED_IMPORT_TARGETS = new Map<string, SetImportKey>([
  ["observer", "legendObservers"],
  ["reactive", "reactiveFactories"],
  ["reactiveObserver", "legendObservers"],
  ["use$", "legacyUseValue"],
  ["useComputed", "useComputed"],
  ["useLocalObservable", "useObservable"],
  ["useMount", "useMount"],
  ["useObservable", "useObservable"],
  ["useObserveEffect", "useObserveEffect"],
  ["useSelector", "legacyUseValue"],
  ["useUnmount", "useUnmount"],
  ["useValue", "useValue"],
]);

const LEGEND_NAMED_IMPORT_TARGETS = new Map<string, SetImportKey>([
  ["Observable", "observableTypes"],
  ["ObservableAny", "observableTypes"],
  ["ObservableBoolean", "observableTypes"],
  ["ObservableMap", "observableTypes"],
  ["ObservableObject", "observableTypes"],
  ["ObservableParam", "observableTypes"],
  ["ObservablePrimitive", "observableTypes"],
  ["ObservableSet", "observableTypes"],
  ["batch", "batch"],
  ["linked", "linked"],
  ["observable", "observable"],
  ["syncState", "syncState"],
]);

const LEGEND_REACT_COMPONENTS: ReadonlySet<string> = new Set([
  "Computed",
  "For",
  "Memo",
  "Show",
  "Switch",
]);

const LEGEND_REACTIONS_BY_MODULE = new Map<string, ReadonlySet<string>>([
  [LEGEND_MODULE, new Set(["observe", "when", "whenReady"])],
  [LEGEND_REACT_MODULE, new Set(["useObserve", "useObserveEffect", "useWhen", "useWhenReady"])],
]);

const LEGEND_SYNC_NAMED_IMPORT_TARGETS = new Map<string, SetImportKey>([["synced", "synced"]]);

const NAMED_IMPORT_TARGETS = new Map<string, ReadonlyMap<string, SetImportKey>>([
  [LEGEND_MODULE, LEGEND_NAMED_IMPORT_TARGETS],
  [LEGEND_REACT_MODULE, LEGEND_REACT_NAMED_IMPORT_TARGETS],
  [LEGEND_SYNC_MODULE, LEGEND_SYNC_NAMED_IMPORT_TARGETS],
  [REACT_MODULE, REACT_NAMED_IMPORT_TARGETS],
]);

function createHookImportSets(): HookImportSets {
  return {
    batch: new Set(),
    hostComponents: new Set(),
    hostNamespaces: new Set(),
    lazy: new Set(),
    legacyUseValue: new Set(),
    legendNamespaces: new Set(),
    legendObservers: new Set(),
    legendReactComponents: new Map(),
    legendReactNamespaces: new Set(),
    legendReactions: new Map(),
    legendSyncNamespaces: new Set(),
    linked: new Set(),
    observable: new Set(),
    observableTypes: new Set(),
    reactiveFactories: new Set(),
    reactiveHosts: new Set(),
    reactNamespaces: new Set(),
    startTransition: new Set(),
    syncState: new Set(),
    synced: new Set(),
    useCallback: new Set(),
    useComputed: new Set(),
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
    if (HOST_COMPONENT_MODULES.has(moduleName)) {
      sets.hostComponents.add(localName);
    }
    const exportedName = element.propertyName?.text ?? localName;
    collectLegendSurfaceImport(sets, { exportedName, localName, moduleName });
    const target = targets?.get(exportedName);
    if (target) {
      sets[target].add(localName);
    }
  }
}

function isLegendReactComponent(name: string): name is LegendReactComponent {
  return LEGEND_REACT_COMPONENTS.has(name);
}

function isLegendReaction(name: string, reactions: ReadonlySet<string>): name is LegendReaction {
  return reactions.has(name);
}

interface ImportedName {
  readonly exportedName: string;
  readonly localName: string;
  readonly moduleName: string;
}

function collectLegendSurfaceImport(
  sets: HookImportSets,
  { exportedName, localName, moduleName }: ImportedName,
): void {
  if (moduleName === LEGEND_REACT_MODULE && isLegendReactComponent(exportedName)) {
    sets.legendReactComponents.set(localName, exportedName);
  }
  const reactions = LEGEND_REACTIONS_BY_MODULE.get(moduleName);
  if (reactions && isLegendReaction(exportedName, reactions)) {
    sets.legendReactions.set(localName, exportedName);
  }
  if (moduleName === LEGEND_REACT_NATIVE_MODULE && exportedName.startsWith("$")) {
    sets.reactiveHosts.add(localName);
  }
  if (moduleName === LEGEND_REACT_WEB_MODULE && exportedName === "$React") {
    sets.reactiveHosts.add(localName);
    sets.hostNamespaces.add(localName);
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

/**
 * Whether a JSX tag renders a host surface: an intrinsic element, an imported host component, or a
 * member of a host namespace such as `$React.input` or `RN.View`.
 */
export function isHostTag(tag: string, imports: HostTagImports): boolean {
  const [root, ...members] = tag.split(".");
  if (root === undefined || members.length === 0) {
    return /^[a-z]/u.test(tag) || imports.hostComponents.has(tag);
  }
  return imports.hostNamespaces.has(root);
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

/**
 * A call reaches the import only when no closer scope rebinds the name. Without this an injected or
 * destructured `useState` reads as React's, and deleting its call would delete unrelated behaviour.
 */
function isReboundBeforeModuleScope(call: ts.CallExpression, name: string): boolean {
  for (let current: ts.Node = call; current.parent; current = current.parent) {
    if (isRuntimeFunctionLike(current) && declaresNameInOwnScope(current, name)) {
      return true;
    }
  }
  return false;
}

function declaresNameInOwnScope(owner: RuntimeFunctionLike, name: string): boolean {
  const names = new Set<string>();
  for (const parameter of owner.parameters) {
    collectBindingNames(parameter.name, names);
  }
  if (owner.body) {
    visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
      if (ts.isVariableDeclaration(node)) {
        collectBindingNames(node.name, names);
      }
    });
  }
  return names.has(name);
}

export function isImportedHookCall({
  call,
  canonicalName,
  localNames,
  namespaceNames,
}: HookCallQuery): boolean {
  const { expression } = call;
  if (ts.isIdentifier(expression)) {
    return localNames.has(expression.text) && !isReboundBeforeModuleScope(call, expression.text);
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
