import { AnalysisProject, isSupportedAnalysisFile } from "../analysis-project.js";
import type {
  CrossModuleBindings,
  IndexedImportBinding,
  IndexedReexportBinding,
  ModuleRecord,
  ResolvedSymbol,
  SourceIndexState,
  StarExporter,
} from "./model.js";
import {
  availableSymbolKinds,
  exportedSymbol,
  initialSymbolTrace,
  resolvedFor,
} from "./symbol-resolution.js";
import { cachedModuleResolutionHost, normalizeFile, resolveModule } from "./module-resolution.js";
import { contextProviderSitesFor, contextReaderHooksFor } from "./context-readers.js";
import type { AnalysisFile } from "../analysis-project.js";
import { isFrameworkEventModuleSpecifier } from "./framework-event-components.js";
import { moduleRecord } from "./module-record.js";
import { observableArrayPathsFor } from "./observable-array-paths.js";
import { observablePathsFor } from "./observable-containers.js";
import type ts from "typescript";

export interface SourceIndex {
  componentDeclarationFor: (file: string, name: string) => ResolvedSymbol | null;
  componentsFor: (file: string) => ReadonlySet<string>;
  contextProviderSitesFor: (file: string, contextName: string) => number;
  contextReaderHooksFor: (
    file: string,
    contextName: string,
  ) => ReadonlyMap<string, ReadonlySet<string>>;
  deferredCallbackRegistrationsFor: (
    file: string,
  ) => ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>;
  deferredCallbackHooksFor: (file: string) => ReadonlyMap<string, ReadonlySet<number>>;
  frameworkEventComponentFor: (file: string, name: string) => boolean;
  hookDeclarationFor: (file: string, name: string) => ResolvedSymbol | null;
  legendValueBridgesFor: (file: string) => ReadonlyMap<string, ReadonlySet<string>>;
  observableArrayPathsFor: (file: string) => ReadonlySet<string>;
  observableFactoriesFor: (file: string) => ReadonlySet<string>;
  observableKeysFor: (file: string) => ReadonlyMap<string, ReadonlySet<string>>;
  observablePathsFor: (file: string) => ReadonlySet<string>;
  observablesFor: (file: string) => ReadonlySet<string>;
  pureProjectionsFor: (file: string) => ReadonlySet<string>;
}

export function buildSourceIndex(root: string, sources: ReadonlyMap<string, string>): SourceIndex {
  const supported = new Map([...sources].filter(([fileName]) => isSupportedAnalysisFile(fileName)));
  return buildSourceIndexFromFiles(root, new AnalysisProject(supported).files);
}

export function buildSourceIndexFromFiles(
  root: string,
  files: readonly AnalysisFile[],
): SourceIndex {
  const state = createSourceIndexState(root, files);
  return {
    componentDeclarationFor: (file, name) => componentDeclarationFor(state, file, name),
    componentsFor: (file) => new Set(resolvedFor(state, file, "component").keys()),
    contextProviderSitesFor: (file, contextName) =>
      contextProviderSitesFor(state, file, contextName),
    contextReaderHooksFor: (file, contextName) => contextReaderHooksFor(state, file, contextName),
    deferredCallbackHooksFor: (file) => deferredCallbackHooksFor(state, file),
    deferredCallbackRegistrationsFor: (file) => deferredCallbackRegistrationsFor(state, file),
    frameworkEventComponentFor: (file, name) => frameworkEventComponentFor(state, file, name),
    hookDeclarationFor: (file, name) => hookDeclarationFor(state, file, name),
    legendValueBridgesFor: (file) => legendValueBridgesFor(state, file),
    observableArrayPathsFor: (file) => observableArrayPathsFor(state, file),
    observableFactoriesFor: (file) =>
      new Set(resolvedFor(state, file, "observable-factory").keys()),
    observableKeysFor: (file) => observableKeysFor(state, file),
    observablePathsFor: (file) => observablePathsFor(state, file),
    observablesFor: (file) => new Set(resolvedFor(state, file, "observable").keys()),
    pureProjectionsFor: (file) => new Set(resolvedFor(state, file, "pure-projection").keys()),
  };
}

function createSourceIndexState(root: string, files: readonly AnalysisFile[]): SourceIndexState {
  const records = new Map<string, ModuleRecord>();
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const file of files) {
    const normalized = normalizeFile(file.identityPath);
    records.set(normalized, moduleRecord(file.sourceFile));
    sourceFiles.set(normalized, file.sourceFile);
  }
  return {
    ...crossModuleBindings(records),
    availableSymbolKinds: availableSymbolKinds(records),
    aliasesBySymbol: new Map(),
    compilerContexts: new Map(),
    compilerContextsByImporter: new Map(),
    configFilesByDirectory: new Map(),
    contextReaders: new Map(),
    contextReadersBySymbol: new Map(),
    moduleResolutionHost: cachedModuleResolutionHost(new Set(records.keys())),
    records,
    resolvedByKind: new Map(),
    resolvedHooks: new Map(),
    resolvedModules: new Map(),
    root,
    sourceFiles,
    stableObservableContainers: new Map(),
  };
}

function crossModuleBindings(records: ReadonlyMap<string, ModuleRecord>): CrossModuleBindings {
  const importsByName = new Map<string, IndexedImportBinding[]>();
  const reexportsByName = new Map<string, IndexedReexportBinding[]>();
  const starExporters: StarExporter[] = [];
  for (const [file, record] of records) {
    indexModuleImports(importsByName, file, record);
    indexModuleReexports(reexportsByName, file, record);
    for (const moduleSpecifier of record.starExports) {
      starExporters.push({ file, moduleSpecifier });
    }
  }
  return { importsByName, reexportsByName, starExporters };
}

function indexModuleImports(
  importsByName: Map<string, IndexedImportBinding[]>,
  file: string,
  record: ModuleRecord,
): void {
  for (const [localName, binding] of record.imports) {
    const indexed = importsByName.get(binding.importedName) ?? [];
    indexed.push({ ...binding, file, localName });
    importsByName.set(binding.importedName, indexed);
  }
}

function indexModuleReexports(
  reexportsByName: Map<string, IndexedReexportBinding[]>,
  file: string,
  record: ModuleRecord,
): void {
  for (const [exportName, binding] of record.reexports) {
    const indexed = reexportsByName.get(binding.importedName) ?? [];
    indexed.push({ ...binding, exportName, file });
    reexportsByName.set(binding.importedName, indexed);
  }
}

function componentDeclarationFor(
  state: SourceIndexState,
  file: string,
  name: string,
): ResolvedSymbol | null {
  const normalized = normalizeFile(file);
  if (state.records.get(normalized)?.componentDeclarations.has(name)) {
    return { file: normalized, localName: name };
  }
  return resolvedFor(state, normalized, "component").get(name) ?? null;
}

function hookDeclarationFor(
  state: SourceIndexState,
  file: string,
  name: string,
): ResolvedSymbol | null {
  const normalized = normalizeFile(file);
  if (state.records.get(normalized)?.hookDeclarations.has(name)) {
    return { file: normalized, localName: name };
  }
  const key = `${normalized}\0${name}`;
  const cached = state.resolvedHooks.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = resolveHookImport(state, normalized, name);
  state.resolvedHooks.set(key, resolved);
  return resolved;
}

function resolveHookImport(
  state: SourceIndexState,
  normalized: string,
  name: string,
): ResolvedSymbol | null {
  const binding = state.records.get(normalized)?.imports.get(name);
  const target = binding ? resolveModule(state, normalized, binding.moduleSpecifier) : null;
  return binding && target
    ? exportedSymbol(
        state,
        { exportName: binding.importedName, file: target, kind: "hook" },
        initialSymbolTrace(),
      )
    : null;
}

function deferredCallbackHooksFor(
  state: SourceIndexState,
  file: string,
): ReadonlyMap<string, ReadonlySet<number>> {
  const hooks = new Map<string, ReadonlySet<number>>();
  const normalized = normalizeFile(file);
  const declared = state.records.get(normalized)?.deferredCallbackHooks ?? [];
  for (const [localName, parameters] of declared) {
    hooks.set(localName, parameters);
  }
  for (const [localName, symbol] of resolvedFor(state, file, "deferred-callback-hook")) {
    const parameters = state.records.get(symbol.file)?.deferredCallbackHooks.get(symbol.localName);
    if (parameters) {
      hooks.set(localName, parameters);
    }
  }
  return hooks;
}

function deferredCallbackRegistrationsFor(
  state: SourceIndexState,
  file: string,
): ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>> {
  const registrations = new Map<string, ReadonlyMap<string, ReadonlySet<number>>>();
  for (const [localName, symbol] of resolvedFor(state, file, "deferred-callback-owner")) {
    const methods = state.records.get(symbol.file)?.deferredCallbackOwners.get(symbol.localName);
    if (methods) {
      registrations.set(localName, methods);
    }
  }
  return registrations;
}

function frameworkEventComponentFor(state: SourceIndexState, file: string, name: string): boolean {
  const rootName = name.split(".", 1)[0] ?? name;
  const record = state.records.get(normalizeFile(file));
  if (record?.shadowedImports.has(rootName)) {
    return false;
  }
  if (record?.frameworkEventComponents.has(rootName)) {
    return true;
  }
  const binding = record?.imports.get(rootName);
  return (
    (binding !== undefined && isFrameworkEventModuleSpecifier(binding.moduleSpecifier)) ||
    resolvedFor(state, file, "framework-event-component").has(rootName)
  );
}

function legendValueBridgesFor(
  state: SourceIndexState,
  file: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  const bridges = new Map<string, ReadonlySet<string>>();
  const writers = resolvedFor(state, file, "legend-value-writer");
  for (const [hookName, hook] of resolvedFor(state, file, "legend-value-hook")) {
    const observable = state.records.get(hook.file)?.legendValueHooks.get(hook.localName);
    const matches = observable
      ? matchingValueWriters(state, writers, { file: hook.file, observable })
      : new Set<string>();
    if (matches.size > 0) {
      bridges.set(hookName, matches);
    }
  }
  return bridges;
}

function matchingValueWriters(
  state: SourceIndexState,
  writers: ReadonlyMap<string, ResolvedSymbol>,
  hook: { file: string; observable: string },
): ReadonlySet<string> {
  const matches = new Set<string>();
  for (const [writerName, writer] of writers) {
    if (
      writer.file === hook.file &&
      state.records.get(writer.file)?.legendValueWriters.get(writer.localName) === hook.observable
    ) {
      matches.add(writerName);
    }
  }
  return matches;
}

function observableKeysFor(
  state: SourceIndexState,
  file: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  const keys = new Map<string, ReadonlySet<string>>();
  for (const [localName, symbol] of resolvedFor(state, file, "observable")) {
    const observableKeys = state.records.get(symbol.file)?.observableKeys.get(symbol.localName);
    if (observableKeys) {
      keys.set(localName, observableKeys);
    }
  }
  return keys;
}
