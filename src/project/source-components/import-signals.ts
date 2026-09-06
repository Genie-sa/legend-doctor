import type { ModuleImportSignals } from "./model.js";
import ts from "typescript";

export const REACT_EFFECT_HOOKS = new Set(["useEffect", "useInsertionEffect", "useLayoutEffect"]);

const OBSERVABLE_FACTORY_EXPORTS = ["observable", "syncState"];

const OBSERVABLE_TYPE_EXPORTS = [
  "Observable",
  "ObservableAny",
  "ObservableBoolean",
  "ObservableMap",
  "ObservableObject",
  "ObservableParam",
  "ObservablePrimitive",
  "ObservableSet",
];

type ImportSignalCollector = (
  signals: ModuleImportSignals,
  statement: ts.ImportDeclaration,
) => void;

const IMPORT_SIGNAL_COLLECTORS = new Map<string, ImportSignalCollector>([
  ["@legendapp/state", collectLegendStateImports],
  ["@legendapp/state/react", collectLegendReactImports],
  ["@legendapp/state/sync", collectLegendSyncImports],
  ["react", collectReactImports],
  ["react-native", collectReactNativeImports],
  ["react-native-web", collectReactNativeImports],
  ["styled-components", collectStyledComponentsImports],
]);

export function moduleImportSignals(sourceFile: ts.SourceFile): ModuleImportSignals {
  const signals: ModuleImportSignals = {
    legendNamespaces: new Set(),
    legendSyncNamespaces: new Set(),
    nativeComponentFactories: new Set(),
    observableFactories: new Set(),
    observableTypes: new Set(),
    reactContextFactories: new Set(),
    reactContextReaders: new Set(),
    reactEffectHooks: new Set(),
    reactNamespaces: new Set(),
    styledFactories: new Set(),
    synced: new Set(),
    useValueHooks: new Set(),
  };
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      IMPORT_SIGNAL_COLLECTORS.get(statement.moduleSpecifier.text)?.(signals, statement);
    }
  }
  return signals;
}

function collectReactImports(signals: ModuleImportSignals, statement: ts.ImportDeclaration): void {
  const clause = statement.importClause;
  const bindings = clause?.namedBindings;
  if (clause?.name) {
    signals.reactNamespaces.add(clause.name.text);
  }
  if (bindings && ts.isNamespaceImport(bindings)) {
    signals.reactNamespaces.add(bindings.name.text);
    return;
  }
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      collectReactNamedImport(signals, element);
    }
  }
}

function collectReactNamedImport(signals: ModuleImportSignals, element: ts.ImportSpecifier): void {
  const importedName = element.propertyName?.text ?? element.name.text;
  if (REACT_EFFECT_HOOKS.has(importedName)) {
    signals.reactEffectHooks.add(element.name.text);
  }
  if (importedName === "createContext") {
    signals.reactContextFactories.add(element.name.text);
  }
  if (importedName === "use" || importedName === "useContext") {
    signals.reactContextReaders.add(element.name.text);
  }
}

function collectReactNativeImports(
  signals: ModuleImportSignals,
  statement: ts.ImportDeclaration,
): void {
  addNamedImportAliases(
    signals.nativeComponentFactories,
    statement.importClause?.namedBindings,
    "requireNativeComponent",
  );
}

function collectStyledComponentsImports(
  signals: ModuleImportSignals,
  statement: ts.ImportDeclaration,
): void {
  const defaultImport = statement.importClause?.name;
  if (defaultImport) {
    signals.styledFactories.add(defaultImport.text);
  }
}

function collectLegendReactImports(
  signals: ModuleImportSignals,
  statement: ts.ImportDeclaration,
): void {
  addNamedImportAliases(signals.useValueHooks, statement.importClause?.namedBindings, "useValue");
}

function collectLegendStateImports(
  signals: ModuleImportSignals,
  statement: ts.ImportDeclaration,
): void {
  const bindings = statement.importClause?.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    signals.legendNamespaces.add(bindings.name.text);
    return;
  }
  for (const factory of OBSERVABLE_FACTORY_EXPORTS) {
    addNamedImportAliases(signals.observableFactories, bindings, factory);
  }
  for (const type of OBSERVABLE_TYPE_EXPORTS) {
    addNamedImportAliases(signals.observableTypes, bindings, type);
  }
}

function collectLegendSyncImports(
  signals: ModuleImportSignals,
  statement: ts.ImportDeclaration,
): void {
  const bindings = statement.importClause?.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    signals.legendSyncNamespaces.add(bindings.name.text);
    return;
  }
  addNamedImportAliases(signals.synced, bindings, "synced");
}

function addNamedImportAliases(
  aliases: Set<string>,
  bindings: ts.NamedImportBindings | undefined,
  importedName: string,
): void {
  if (!bindings || !ts.isNamedImports(bindings)) {
    return;
  }
  for (const element of bindings.elements) {
    if ((element.propertyName?.text ?? element.name.text) === importedName) {
      aliases.add(element.name.text);
    }
  }
}
