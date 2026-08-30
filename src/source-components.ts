import { AnalysisProject, isSupportedAnalysisFile } from "./analysis-project.js";
import {
  bindingDeclarationCount,
  exactObjectLiteralKeys,
  isAssignmentOperator,
  isDeclarationName,
  isNonValueIdentifier,
} from "./analysis-ast.js";
import {
  collectReactComponentWrappers,
  isReactComponentWrapper,
} from "./react-component-wrappers.js";
import {
  findAncestor,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  nodeWithin,
  visit,
} from "./ast.js";
import type { AnalysisFile } from "./analysis-project.js";
import type { ReactComponentWrappers } from "./react-component-wrappers.js";
import path from "node:path";
import { pathIdentityKey } from "./path-identity.js";
import ts from "typescript";

interface ImportBinding {
  importedName: string;
  moduleSpecifier: string;
}

interface ReexportBinding {
  importedName: string;
  moduleSpecifier: string;
}

interface IndexedImportBinding extends ImportBinding {
  file: string;
  localName: string;
}

interface IndexedReexportBinding extends ReexportBinding {
  exportName: string;
  file: string;
}

type ComponentFunction = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

const REACT_EFFECT_HOOKS = new Set(["useEffect", "useInsertionEffect", "useLayoutEffect"]);

const MAX_EXPORT_RESOLUTION_DEPTH = 8;
const MAX_OBJECT_ASSIGN_ALIAS_DEPTH = 4;
const OBJECT_ASSIGN_MINIMUM_ARGUMENTS = 2;
const MINIMUM_STORED_CALLBACK_REFERENCES = 2;
const MISSING_BASE_CONFIG_DIAGNOSTIC_CODE = 6053;

interface ModuleRecord {
  componentDeclarations: ReadonlyMap<string, ComponentFunction>;
  contextReaderHooks: ReadonlyMap<string, string>;
  deferredCallbackOwners: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>;
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>;
  frameworkEventComponents: ReadonlySet<string>;
  hookDeclarations: ReadonlyMap<string, ComponentFunction>;
  imports: ReadonlyMap<string, ImportBinding>;
  legendValueHooks: ReadonlyMap<string, string>;
  legendValueWriters: ReadonlyMap<string, string>;
  localExports: ReadonlyMap<string, string>;
  observableDeclarations: ReadonlySet<string>;
  observableKeys: ReadonlyMap<string, ReadonlySet<string>>;
  observableMemberDeclarations: ReadonlyMap<string, ReadonlySet<string>>;
  observableFactoryCalls: ReadonlyMap<string, string>;
  observableFactoryDeclarations: ReadonlySet<string>;
  pureProjectionDeclarations: ReadonlySet<string>;
  reactContexts: ReadonlySet<string>;
  reexports: ReadonlyMap<string, ReexportBinding>;
  shadowedImports: ReadonlySet<string>;
  starExports: readonly string[];
}

export interface SourceIndex {
  componentDeclarationFor: (file: string, name: string) => ResolvedSymbol | null;
  componentsFor: (file: string) => ReadonlySet<string>;
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
  observableFactoriesFor: (file: string) => ReadonlySet<string>;
  observableKeysFor: (file: string) => ReadonlyMap<string, ReadonlySet<string>>;
  observablePathsFor: (file: string) => ReadonlySet<string>;
  observablesFor: (file: string) => ReadonlySet<string>;
  pureProjectionsFor: (file: string) => ReadonlySet<string>;
}

export interface ResolvedSymbol {
  file: string;
  localName: string;
}

type SourceSymbolKind =
  | "component"
  | "context-reader-hook"
  | "deferred-callback-owner"
  | "deferred-callback-hook"
  | "framework-event-component"
  | "hook"
  | "legend-value-hook"
  | "legend-value-writer"
  | "observable"
  | "observable-container"
  | "observable-factory"
  | "pure-projection"
  | "react-context";

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
    contextReaderHooksFor: (file, contextName) => contextReaderHooksFor(state, file, contextName),
    deferredCallbackHooksFor: (file) => deferredCallbackHooksFor(state, file),
    deferredCallbackRegistrationsFor: (file) => deferredCallbackRegistrationsFor(state, file),
    frameworkEventComponentFor: (file, name) => frameworkEventComponentFor(state, file, name),
    hookDeclarationFor: (file, name) => hookDeclarationFor(state, file, name),
    legendValueBridgesFor: (file) => legendValueBridgesFor(state, file),
    observableFactoriesFor: (file) =>
      new Set(resolvedFor(state, file, "observable-factory").keys()),
    observableKeysFor: (file) => observableKeysFor(state, file),
    observablePathsFor: (file) => observablePathsFor(state, file),
    observablesFor: (file) => new Set(resolvedFor(state, file, "observable").keys()),
    pureProjectionsFor: (file) => new Set(resolvedFor(state, file, "pure-projection").keys()),
  };
}

interface StarExporter {
  file: string;
  moduleSpecifier: string;
}

interface CrossModuleBindings {
  importsByName: ReadonlyMap<string, readonly IndexedImportBinding[]>;
  reexportsByName: ReadonlyMap<string, readonly IndexedReexportBinding[]>;
  starExporters: readonly StarExporter[];
}

interface SourceIndexState extends CrossModuleBindings {
  aliasesBySymbol: Map<string, ReadonlyMap<string, ReadonlySet<string>>>;
  compilerContexts: Map<string, CompilerContext>;
  compilerContextsByImporter: Map<string, CompilerContext>;
  configFilesByDirectory: Map<string, string | null>;
  contextReaders: Map<string, ReadonlyMap<string, ReadonlySet<string>>>;
  contextReadersBySymbol: Map<string, ReadonlyMap<string, ReadonlySet<string>>>;
  moduleResolutionHost: ts.ModuleResolutionHost;
  records: ReadonlyMap<string, ModuleRecord>;
  resolvedByKind: Map<SourceSymbolKind, Map<string, ReadonlyMap<string, ResolvedSymbol>>>;
  resolvedModules: Map<string, string | null>;
  root: string;
  sourceFiles: ReadonlyMap<string, ts.SourceFile>;
  stableObservableContainers: Map<string, boolean>;
}

interface SymbolTrace {
  depth: number;
  visited: ReadonlySet<string>;
}

interface SymbolTarget {
  exportName: string;
  file: string;
  kind: SourceSymbolKind;
}

interface LocalSymbolLookup {
  localName: string;
  trace: SymbolTrace;
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
    aliasesBySymbol: new Map(),
    compilerContexts: new Map(),
    compilerContextsByImporter: new Map(),
    configFilesByDirectory: new Map(),
    contextReaders: new Map(),
    contextReadersBySymbol: new Map(),
    moduleResolutionHost: cachedModuleResolutionHost(new Set(records.keys())),
    records,
    resolvedByKind: new Map(),
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

function initialSymbolTrace(): SymbolTrace {
  return { depth: 0, visited: new Set() };
}

function resolveModule(
  state: SourceIndexState,
  importer: string,
  specifier: string,
): string | null {
  const key = `${importer}\0${specifier}`;
  if (state.resolvedModules.has(key)) {
    return state.resolvedModules.get(key) ?? null;
  }
  const local = resolveLocalModule(state, importer, specifier);
  state.resolvedModules.set(key, local);
  return local;
}

function resolveLocalModule(
  state: SourceIndexState,
  importer: string,
  specifier: string,
): string | null {
  const { cache, options } = compilerContextFor(importer, state.root, state);
  const resolution = ts.resolveModuleName(
    specifier,
    importer,
    options,
    state.moduleResolutionHost,
    cache,
  ).resolvedModule;
  if (!resolution || resolution.isExternalLibraryImport) {
    return null;
  }
  const resolved = normalizeFile(
    resolution.resolvedFileName.replace(/\.d\.(?:ts|mts|cts)$/u, ".ts"),
  );
  return state.records.has(resolved) ? resolved : null;
}

interface NameLookup {
  has: (name: string) => boolean;
}

const DECLARED_SYMBOL_LOOKUPS = {
  component: (record: ModuleRecord): NameLookup => record.componentDeclarations,
  "context-reader-hook": (record: ModuleRecord): NameLookup => record.contextReaderHooks,
  "deferred-callback-hook": (record: ModuleRecord): NameLookup => record.deferredCallbackHooks,
  "deferred-callback-owner": (record: ModuleRecord): NameLookup => record.deferredCallbackOwners,
  "framework-event-component": (record: ModuleRecord): NameLookup =>
    record.frameworkEventComponents,
  hook: (record: ModuleRecord): NameLookup => record.hookDeclarations,
  "legend-value-hook": (record: ModuleRecord): NameLookup => record.legendValueHooks,
  "legend-value-writer": (record: ModuleRecord): NameLookup => record.legendValueWriters,
  observable: (record: ModuleRecord): NameLookup => record.observableDeclarations,
  "observable-container": (record: ModuleRecord): NameLookup => record.observableMemberDeclarations,
  "observable-factory": (record: ModuleRecord): NameLookup => record.observableFactoryDeclarations,
  "pure-projection": (record: ModuleRecord): NameLookup => record.pureProjectionDeclarations,
  "react-context": (record: ModuleRecord): NameLookup => record.reactContexts,
} satisfies Record<SourceSymbolKind, (record: ModuleRecord) => NameLookup>;

function recordDeclaresSymbol(
  record: ModuleRecord,
  kind: SourceSymbolKind,
  localName: string,
): boolean {
  return DECLARED_SYMBOL_LOOKUPS[kind](record).has(localName);
}

function exportedSymbol(
  state: SourceIndexState,
  target: SymbolTarget,
  trace: SymbolTrace,
): ResolvedSymbol | null {
  const key = `${target.kind}\0${target.file}\0${target.exportName}`;
  const record = state.records.get(target.file);
  if (trace.depth > MAX_EXPORT_RESOLUTION_DEPTH || trace.visited.has(key) || !record) {
    return null;
  }
  const next: SymbolTrace = { depth: trace.depth + 1, visited: new Set(trace.visited).add(key) };
  const localName = record.localExports.get(target.exportName);
  const direct = localName ? localExportedSymbol(state, target, { localName, trace: next }) : null;
  return direct ?? reexportedSymbol(state, target, next);
}

function reexportedSymbol(
  state: SourceIndexState,
  target: SymbolTarget,
  trace: SymbolTrace,
): ResolvedSymbol | null {
  const reexport = state.records.get(target.file)?.reexports.get(target.exportName);
  if (!reexport) {
    return starExportedSymbol(state, target, trace);
  }
  const resolved = resolveModule(state, target.file, reexport.moduleSpecifier);
  return resolved
    ? exportedSymbol(state, { ...target, exportName: reexport.importedName, file: resolved }, trace)
    : null;
}

function localExportedSymbol(
  state: SourceIndexState,
  target: SymbolTarget,
  local: LocalSymbolLookup,
): ResolvedSymbol | null {
  const record = state.records.get(target.file);
  if (!record) {
    return null;
  }
  if (recordDeclaresSymbol(record, target.kind, local.localName)) {
    return { file: target.file, localName: local.localName };
  }
  const binding = record.imports.get(local.localName);
  const importedTarget = binding
    ? resolveModule(state, target.file, binding.moduleSpecifier)
    : null;
  const imported =
    binding && importedTarget
      ? exportedSymbol(
          state,
          { ...target, exportName: binding.importedName, file: importedTarget },
          local.trace,
        )
      : null;
  return imported ?? observableFactoryAlias(state, target, local);
}

function observableFactoryAlias(
  state: SourceIndexState,
  target: SymbolTarget,
  local: LocalSymbolLookup,
): ResolvedSymbol | null {
  const record = state.records.get(target.file);
  const factoryName =
    target.kind === "observable" ? record?.observableFactoryCalls.get(local.localName) : undefined;
  if (!record || factoryName === undefined) {
    return null;
  }
  const proven =
    record.observableFactoryDeclarations.has(factoryName) ||
    importedFactoryIsDeclared(state, target.file, { factoryName, trace: local.trace });
  return proven ? { file: target.file, localName: local.localName } : null;
}

function importedFactoryIsDeclared(
  state: SourceIndexState,
  file: string,
  factory: { factoryName: string; trace: SymbolTrace },
): boolean {
  const binding = state.records.get(file)?.imports.get(factory.factoryName);
  const target = binding ? resolveModule(state, file, binding.moduleSpecifier) : null;
  return (
    binding !== undefined &&
    target !== null &&
    exportedSymbol(
      state,
      { exportName: binding.importedName, file: target, kind: "observable-factory" },
      factory.trace,
    ) !== null
  );
}

function starExportedSymbol(
  state: SourceIndexState,
  target: SymbolTarget,
  trace: SymbolTrace,
): ResolvedSymbol | null {
  const starExports = state.records.get(target.file)?.starExports ?? [];
  const matches = starExports.flatMap((specifier) => {
    const resolved = resolveModule(state, target.file, specifier);
    const symbol = resolved ? exportedSymbol(state, { ...target, file: resolved }, trace) : null;
    return symbol ? [symbol] : [];
  });
  const unique = new Map(matches.map((match) => [`${match.file}\0${match.localName}`, match]));
  return unique.size === 1 ? (unique.values().next().value ?? null) : null;
}

interface AliasCrawl {
  aliasQueue: ResolvedSymbol[];
  aliases: Map<string, Set<string>>;
  exportQueue: { file: string; name: string }[];
  seenAliases: Set<string>;
  seenExports: Set<string>;
}

type AliasKind = "context-reader-hook" | "react-context";

interface AliasOrigin {
  kind: AliasKind;
  symbol: ResolvedSymbol;
}

function addAliasToCrawl(crawl: AliasCrawl, file: string, localName: string): void {
  const key = `${file}\0${localName}`;
  if (crawl.seenAliases.has(key)) {
    return;
  }
  crawl.seenAliases.add(key);
  const names = crawl.aliases.get(file) ?? new Set<string>();
  names.add(localName);
  crawl.aliases.set(file, names);
  crawl.aliasQueue.push({ file, localName });
}

function addExportToCrawl(crawl: AliasCrawl, file: string, name: string): void {
  const key = `${file}\0${name}`;
  if (crawl.seenExports.has(key)) {
    return;
  }
  crawl.seenExports.add(key);
  crawl.exportQueue.push({ file, name });
}

function aliasesForSymbol(
  state: SourceIndexState,
  symbol: ResolvedSymbol,
  kind: AliasKind,
): ReadonlyMap<string, ReadonlySet<string>> {
  const symbolKey = `${kind}\0${symbol.file}\0${symbol.localName}`;
  const cached = state.aliasesBySymbol.get(symbolKey);
  if (cached) {
    return cached;
  }
  const crawl: AliasCrawl = {
    aliasQueue: [],
    aliases: new Map(),
    exportQueue: [],
    seenAliases: new Set(),
    seenExports: new Set(),
  };
  addAliasToCrawl(crawl, symbol.file, symbol.localName);
  drainAliasCrawl(state, crawl, { kind, symbol });
  state.aliasesBySymbol.set(symbolKey, crawl.aliases);
  return crawl.aliases;
}

function drainAliasCrawl(state: SourceIndexState, crawl: AliasCrawl, origin: AliasOrigin): void {
  let aliasIndex = 0;
  let exportIndex = 0;
  while (aliasIndex < crawl.aliasQueue.length || exportIndex < crawl.exportQueue.length) {
    aliasIndex = drainAliasQueue(state, crawl, aliasIndex);
    const exported = crawl.exportQueue[exportIndex];
    exportIndex += 1;
    if (exported) {
      expandExportedName(state, crawl, { exported, origin });
    }
  }
}

function drainAliasQueue(state: SourceIndexState, crawl: AliasCrawl, startIndex: number): number {
  let index = startIndex;
  while (index < crawl.aliasQueue.length) {
    const alias = crawl.aliasQueue[index]!;
    index += 1;
    collectAliasExports(state, crawl, alias);
  }
  return index;
}

function collectAliasExports(
  state: SourceIndexState,
  crawl: AliasCrawl,
  alias: ResolvedSymbol,
): void {
  for (const [exportName, localName] of state.records.get(alias.file)?.localExports ?? []) {
    if (localName === alias.localName) {
      addExportToCrawl(crawl, alias.file, exportName);
    }
  }
}

interface ExportedName {
  file: string;
  name: string;
}

function expandExportedName(
  state: SourceIndexState,
  crawl: AliasCrawl,
  context: { exported: ExportedName; origin: AliasOrigin },
): void {
  addImportAliases(state, crawl, context.exported);
  addReexportNames(state, crawl, context.exported);
  addStarReexportNames(state, crawl, context);
}

function addImportAliases(
  state: SourceIndexState,
  crawl: AliasCrawl,
  exported: ExportedName,
): void {
  for (const binding of state.importsByName.get(exported.name) ?? []) {
    if (resolveModule(state, binding.file, binding.moduleSpecifier) === exported.file) {
      addAliasToCrawl(crawl, binding.file, binding.localName);
    }
  }
}

function addReexportNames(
  state: SourceIndexState,
  crawl: AliasCrawl,
  exported: ExportedName,
): void {
  for (const binding of state.reexportsByName.get(exported.name) ?? []) {
    if (resolveModule(state, binding.file, binding.moduleSpecifier) === exported.file) {
      addExportToCrawl(crawl, binding.file, binding.exportName);
    }
  }
}

function addStarReexportNames(
  state: SourceIndexState,
  crawl: AliasCrawl,
  context: { exported: ExportedName; origin: AliasOrigin },
): void {
  const { exported, origin } = context;
  for (const star of state.starExporters) {
    const resolved =
      resolveModule(state, star.file, star.moduleSpecifier) === exported.file
        ? exportedSymbol(
            state,
            { exportName: exported.name, file: star.file, kind: origin.kind },
            initialSymbolTrace(),
          )
        : null;
    if (sameResolvedSymbol(resolved, origin.symbol)) {
      addExportToCrawl(crawl, star.file, exported.name);
    }
  }
}

function resolvedFor(
  state: SourceIndexState,
  file: string,
  kind: SourceSymbolKind,
): ReadonlyMap<string, ResolvedSymbol> {
  const importer = normalizeFile(file);
  const cache =
    state.resolvedByKind.get(kind) ?? new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  state.resolvedByKind.set(kind, cache);
  const cached = cache.get(importer);
  if (cached) {
    return cached;
  }
  const symbols = importedSymbols(state, importer, kind);
  cache.set(importer, symbols);
  return symbols;
}

function importedSymbols(
  state: SourceIndexState,
  importer: string,
  kind: SourceSymbolKind,
): ReadonlyMap<string, ResolvedSymbol> {
  const symbols = new Map<string, ResolvedSymbol>();
  for (const [localName, binding] of state.records.get(importer)?.imports ?? []) {
    if (kind === "component" && !isSemanticComponentName(localName)) {
      continue;
    }
    const target = resolveModule(state, importer, binding.moduleSpecifier);
    const symbol = target
      ? exportedSymbol(
          state,
          { exportName: binding.importedName, file: target, kind },
          initialSymbolTrace(),
        )
      : null;
    if (symbol) {
      symbols.set(localName, symbol);
    }
  }
  return symbols;
}

function localSymbol(
  state: SourceIndexState,
  target: { file: string; kind: SourceSymbolKind; name: string },
): ResolvedSymbol | null {
  const { file, kind, name } = target;
  const record = state.records.get(file);
  const local =
    kind === "react-context"
      ? (record?.reactContexts.has(name) ?? false)
      : kind === "context-reader-hook" && (record?.contextReaderHooks.has(name) ?? false);
  if (local) {
    return { file, localName: name };
  }
  const binding = record?.imports.get(name);
  const resolved = binding ? resolveModule(state, file, binding.moduleSpecifier) : null;
  return binding && resolved
    ? exportedSymbol(
        state,
        { exportName: binding.importedName, file: resolved, kind },
        initialSymbolTrace(),
      )
    : null;
}

function contextReaderHooksFor(
  state: SourceIndexState,
  file: string,
  contextName: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  const normalized = normalizeFile(file);
  const cacheKey = `${normalized}\0${contextName}`;
  const cached = state.contextReaders.get(cacheKey);
  if (cached) {
    return cached;
  }
  const context = localSymbol(state, {
    file: normalized,
    kind: "react-context",
    name: contextName,
  });
  const consumers = context
    ? contextReaderConsumers(state, context)
    : new Map<string, ReadonlySet<string>>();
  state.contextReaders.set(cacheKey, consumers);
  return consumers;
}

function contextReaderConsumers(
  state: SourceIndexState,
  context: ResolvedSymbol,
): ReadonlyMap<string, ReadonlySet<string>> {
  const symbolKey = `${context.file}\0${context.localName}`;
  const cached = state.contextReadersBySymbol.get(symbolKey);
  if (cached) {
    return cached;
  }
  const contextAliases = aliasesForSymbol(state, context, "react-context");
  const consumers = contextAliasesAreKnown(state, contextAliases)
    ? readerConsumers(state, readerSymbolsFor(state, contextAliases))
    : new Map<string, ReadonlySet<string>>();
  state.contextReadersBySymbol.set(symbolKey, consumers);
  return consumers;
}

function contextAliasesAreKnown(
  state: SourceIndexState,
  contextAliases: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  for (const [candidateFile, aliases] of contextAliases) {
    const record = state.records.get(candidateFile);
    const sourceFile = state.sourceFiles.get(candidateFile);
    if (
      !record ||
      !sourceFile ||
      [...aliases].some((alias) => !contextReferencesAreKnown(sourceFile, record, alias))
    ) {
      return false;
    }
  }
  return true;
}

function readerSymbolsFor(
  state: SourceIndexState,
  contextAliases: ReadonlyMap<string, ReadonlySet<string>>,
): readonly ResolvedSymbol[] {
  const readerSymbols: ResolvedSymbol[] = [];
  for (const [candidateFile, aliases] of contextAliases) {
    const readers = state.records.get(candidateFile)?.contextReaderHooks ?? [];
    for (const [readerName, localContextName] of readers) {
      if (aliases.has(localContextName)) {
        readerSymbols.push({ file: candidateFile, localName: readerName });
      }
    }
  }
  return readerSymbols;
}

function readerConsumers(
  state: SourceIndexState,
  readerSymbols: readonly ResolvedSymbol[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const consumers = new Map<string, Set<string>>();
  for (const reader of readerSymbols) {
    const localNames = consumers.get(reader.file) ?? new Set<string>();
    localNames.add(reader.localName);
    consumers.set(reader.file, localNames);
    for (const [consumerFile, aliases] of aliasesForSymbol(state, reader, "context-reader-hook")) {
      addReaderConsumerNames(state, consumers, { aliases, consumerFile, reader });
    }
  }
  return consumers;
}

function addReaderConsumerNames(
  state: SourceIndexState,
  consumers: Map<string, Set<string>>,
  context: { aliases: ReadonlySet<string>; consumerFile: string; reader: ResolvedSymbol },
): void {
  const { aliases, consumerFile, reader } = context;
  const names = consumers.get(consumerFile) ?? new Set<string>();
  const record = state.records.get(consumerFile);
  for (const localName of aliases) {
    const importedName = record?.imports.get(localName)?.importedName;
    if (
      (consumerFile === reader.file && localName === reader.localName) ||
      /^use[A-Z0-9]/u.test(localName) ||
      (importedName !== undefined && /^use[A-Z0-9]/u.test(importedName))
    ) {
      names.add(localName);
    }
  }
  if (names.size > 0) {
    consumers.set(consumerFile, names);
  }
}

function observableContainerIsStable(state: SourceIndexState, symbol: ResolvedSymbol): boolean {
  const key = `${symbol.file}\0${symbol.localName}`;
  const cached = state.stableObservableContainers.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const members = state.records
    .get(symbol.file)
    ?.observableMemberDeclarations.get(symbol.localName);
  const stable = members !== undefined && containerReferencesAreStable(state, symbol, members);
  state.stableObservableContainers.set(key, stable);
  return stable;
}

function containerReferencesAreStable(
  state: SourceIndexState,
  symbol: ResolvedSymbol,
  members: ReadonlySet<string>,
): boolean {
  for (const [candidateFile, record] of state.records) {
    const aliases = containerAliasesIn(state, symbol, { candidateFile, record });
    const sourceFile = state.sourceFiles.get(candidateFile);
    if (
      sourceFile &&
      [...aliases].some(
        (alias) => !observableContainerReferencesAreStable(sourceFile, alias, members),
      )
    ) {
      return false;
    }
  }
  return true;
}

function containerAliasesIn(
  state: SourceIndexState,
  symbol: ResolvedSymbol,
  candidate: { candidateFile: string; record: ModuleRecord },
): ReadonlySet<string> {
  const { candidateFile, record } = candidate;
  const aliases = new Set<string>();
  if (candidateFile === symbol.file) {
    aliases.add(symbol.localName);
  }
  for (const [localName, binding] of record.imports) {
    const target = resolveModule(state, candidateFile, binding.moduleSpecifier);
    const imported = target
      ? exportedSymbol(
          state,
          { exportName: binding.importedName, file: target, kind: "observable-container" },
          initialSymbolTrace(),
        )
      : null;
    if (sameResolvedSymbol(imported, symbol)) {
      aliases.add(localName);
    }
  }
  return aliases;
}

function contextReferencesAreKnown(
  sourceFile: ts.SourceFile,
  record: ModuleRecord,
  contextName: string,
): boolean {
  let safe = true;
  visit(sourceFile, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== contextName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      isInsideModuleDeclaration(node)
    ) {
      return;
    }
    if (ts.isExportAssignment(node.parent) && node.parent.expression === node) {
      return;
    }
    if (isKnownContextReference(node, record)) {
      return;
    }
    safe = false;
  });
  return safe;
}

function isKnownContextReference(node: ts.Identifier, record: ModuleRecord): boolean {
  const member = node.parent;
  if (
    ts.isPropertyAccessExpression(member) &&
    member.expression === node &&
    member.name.text === "Provider" &&
    jsxTagUses(member)
  ) {
    return true;
  }
  const owner = findAncestor(node, isRuntimeFunctionLike);
  const ownerName =
    owner && (ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner))
      ? owner.name?.text
      : null;
  return (
    ownerName !== null &&
    ownerName !== undefined &&
    record.contextReaderHooks.get(ownerName) === node.text
  );
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
  return resolvedFor(state, normalized, "hook").get(name) ?? null;
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

function observablePathsFor(state: SourceIndexState, file: string): ReadonlySet<string> {
  const paths = new Set<string>();
  const normalized = normalizeFile(file);
  const declared = state.records.get(normalized)?.observableMemberDeclarations ?? [];
  for (const [localName, members] of declared) {
    if (observableContainerIsStable(state, { file: normalized, localName })) {
      addMemberPaths(paths, localName, members);
    }
  }
  addImportedObservablePaths(state, paths, normalized);
  return paths;
}

function addImportedObservablePaths(
  state: SourceIndexState,
  paths: Set<string>,
  importer: string,
): void {
  for (const [localName, symbol] of resolvedFor(state, importer, "observable-container")) {
    const members = observableContainerIsStable(state, symbol)
      ? state.records.get(symbol.file)?.observableMemberDeclarations.get(symbol.localName)
      : undefined;
    if (members) {
      addMemberPaths(paths, localName, members);
    }
  }
}

function addMemberPaths(paths: Set<string>, localName: string, members: ReadonlySet<string>): void {
  for (const member of members) {
    paths.add(`${localName}.${member}`);
  }
}

function cachedModuleResolutionHost(sourceFiles: ReadonlySet<string>): ts.ModuleResolutionHost {
  const directories = new Map<string, boolean>();
  const files = new Map<string, boolean>();
  const reads = new Map<string, string | undefined>();
  const realPaths = new Map<string, string>();
  return {
    directoryExists: (directory) =>
      cachedByFileKey(directories, directory, () => ts.sys.directoryExists?.(directory) ?? false),
    fileExists: (file) =>
      sourceFiles.has(normalizeFile(file)) ||
      cachedByFileKey(files, file, () => ts.sys.fileExists(file)),
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getDirectories: ts.sys.getDirectories,
    readFile: (file) => cachedFileRead(reads, file),
    realpath: (file) => cachedByFileKey(realPaths, file, () => ts.sys.realpath?.(file) ?? file),
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
}

function cachedByFileKey<Value>(
  cache: Map<string, Value>,
  file: string,
  compute: () => Value,
): Value {
  const key = normalizeFile(file);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const value = compute();
  cache.set(key, value);
  return value;
}

function cachedFileRead(cache: Map<string, string | undefined>, file: string): string | undefined {
  const key = normalizeFile(file);
  if (cache.has(key)) {
    return cache.get(key);
  }
  const value = ts.sys.readFile(file);
  cache.set(key, value);
  return value;
}

interface CompilerContext {
  cache: ts.ModuleResolutionCache;
  options: ts.CompilerOptions;
}

function sameResolvedSymbol(left: ResolvedSymbol | null, right: ResolvedSymbol | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.file === right.file &&
    left.localName === right.localName
  );
}

function isInsideModuleDeclaration(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) {
      return true;
    }
    if (ts.isSourceFile(current) || isRuntimeFunctionLike(current)) {
      return false;
    }
  }
  return false;
}

function jsxTagUses(expression: ts.PropertyAccessExpression): boolean {
  const { parent } = expression;
  return (
    (ts.isJsxOpeningElement(parent) ||
      ts.isJsxSelfClosingElement(parent) ||
      ts.isJsxClosingElement(parent)) &&
    parent.tagName === expression
  );
}

function observableContainerReferencesAreStable(
  sourceFile: ts.SourceFile,
  containerName: string,
  observableMembers: ReadonlySet<string>,
): boolean {
  let stable = true;
  visit(sourceFile, (node) => {
    if (
      !stable ||
      !ts.isIdentifier(node) ||
      node.text !== containerName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      isInsideModuleDeclaration(node)
    ) {
      return;
    }
    const member = node.parent;
    if (
      !ts.isPropertyAccessExpression(member) ||
      member.expression !== node ||
      member.questionDotToken
    ) {
      stable = false;
      return;
    }
    if (observableMembers.has(member.name.text) && propertyAccessIsWritten(member)) {
      stable = false;
    }
  });
  return stable;
}

function propertyAccessIsWritten(access: ts.PropertyAccessExpression): boolean {
  const { parent } = access;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === access &&
      isAssignmentOperator(parent.operatorToken.kind)) ||
    (ts.isPrefixUnaryExpression(parent) &&
      parent.operand === access &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
    (ts.isPostfixUnaryExpression(parent) && parent.operand === access) ||
    (ts.isDeleteExpression(parent) && parent.expression === access)
  );
}

interface CompilerContextCaches {
  compilerContexts: Map<string, CompilerContext>;
  compilerContextsByImporter: Map<string, CompilerContext>;
  configFilesByDirectory: Map<string, string | null>;
}

function compilerContextFor(
  importer: string,
  fallbackRoot: string,
  caches: CompilerContextCaches,
): CompilerContext {
  const importerKey = normalizeFile(importer);
  const importerContext = caches.compilerContextsByImporter.get(importerKey);
  if (importerContext) {
    return importerContext;
  }
  const configFile = nearestConfigFile(path.dirname(importer), caches.configFilesByDirectory);
  const key = configFile ? normalizeFile(configFile) : normalizeFile(fallbackRoot);
  const context =
    caches.compilerContexts.get(key) ??
    createCompilerContext(configFile ? path.dirname(configFile) : fallbackRoot);
  caches.compilerContexts.set(key, context);
  caches.compilerContextsByImporter.set(importerKey, context);
  return context;
}

function createCompilerContext(base: string): CompilerContext {
  const options = compilerOptionsFor(base);
  return {
    cache: ts.createModuleResolutionCache(
      base,
      (file) => (ts.sys.useCaseSensitiveFileNames ? file : file.toLowerCase()),
      options,
    ),
    options,
  };
}

function nearestConfigFile(
  startDirectory: string,
  cache: Map<string, string | null>,
): string | null {
  const directory = normalizeFile(startDirectory);
  if (cache.has(directory)) {
    return cache.get(directory) ?? null;
  }
  const candidate = path.join(directory, "tsconfig.json");
  const configFile = ts.sys.fileExists(candidate)
    ? candidate
    : parentDirectoryConfigFile(directory, cache);
  cache.set(directory, configFile);
  return configFile;
}

function parentDirectoryConfigFile(
  directory: string,
  cache: Map<string, string | null>,
): string | null {
  const parent = path.dirname(directory);
  return parent === directory ? null : nearestConfigFile(parent, cache);
}

function isFrameworkEventModuleSpecifier(specifier: string): boolean {
  return (
    specifier === "react-native" ||
    specifier === "react-native-web" ||
    specifier === "@radix-ui/react-dropdown-menu" ||
    specifier === "@radix-ui/react-switch" ||
    specifier === "@base-ui/react" ||
    specifier.startsWith("@base-ui/react/")
  );
}

interface StyledComponentCandidate {
  exported: boolean;
  factory: string;
  name: string;
  targetRoot: string;
}

function styledComponentTarget(
  initializer: ts.Expression,
): { factory: string; targetRoot: string } | null {
  if (!ts.isTaggedTemplateExpression(initializer)) {
    return null;
  }
  const { tag } = initializer;
  if (!ts.isCallExpression(tag) || !ts.isIdentifier(tag.expression) || tag.arguments.length !== 1) {
    return null;
  }
  const [target] = tag.arguments;
  if (!target) {
    return null;
  }
  const root = styledTargetRoot(target);
  return ts.isIdentifier(root) ? { factory: tag.expression.text, targetRoot: root.text } : null;
}

function styledTargetRoot(target: ts.Expression): ts.Expression {
  let root = target;
  while (ts.isPropertyAccessExpression(root)) {
    root = root.expression;
  }
  return root;
}

interface ModuleRecordDraft {
  componentDeclarations: Map<string, ComponentFunction>;
  contextReaderHooks: Map<string, string>;
  deferredCallbackHooks: Map<string, ReadonlySet<number>>;
  deferredCallbackOwners: Map<string, ReadonlyMap<string, ReadonlySet<number>>>;
  frameworkEventComponents: Set<string>;
  hookDeclarations: Map<string, ComponentFunction>;
  imports: Map<string, ImportBinding>;
  legendValueHooks: Map<string, string>;
  legendValueWriters: Map<string, string>;
  localExports: Map<string, string>;
  observableDeclarations: Set<string>;
  observableFactoryCalls: Map<string, string>;
  observableFactoryDeclarations: Set<string>;
  observableKeys: Map<string, ReadonlySet<string>>;
  observableMemberDeclarations: Map<string, ReadonlySet<string>>;
  pureProjectionDeclarations: Set<string>;
  reactContexts: Set<string>;
  reexports: Map<string, ReexportBinding>;
  shadowedImports: Set<string>;
  starExports: string[];
  styledComponentCandidates: StyledComponentCandidate[];
}

interface ModuleImportSignals {
  legendNamespaces: Set<string>;
  nativeComponentFactories: Set<string>;
  observableFactories: Set<string>;
  observableTypes: Set<string>;
  reactContextFactories: Set<string>;
  reactContextReaders: Set<string>;
  reactEffectHooks: Set<string>;
  reactNamespaces: Set<string>;
  styledFactories: Set<string>;
  useValueHooks: Set<string>;
}

interface ModuleSignals extends ModuleImportSignals {
  componentWrappers: ReactComponentWrappers;
  deferredMethodsByClass: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>;
  observableMemberFactories: ReadonlyMap<string, ReadonlySet<string>>;
  sourceFile: ts.SourceFile;
}

interface DeclarationContext {
  declaration: ts.VariableDeclaration;
  exported: boolean;
  initializer: ts.Expression | null;
  isConst: boolean;
  name: string | null;
}

interface FunctionTraits {
  deferredParameters: ReadonlySet<number>;
  hookObservable: string | null;
  name: string;
  pureProjection: boolean;
  readContext: string | null;
  writerObservable: string | null;
}

function moduleRecord(sourceFile: ts.SourceFile): ModuleRecord {
  const draft = emptyModuleRecordDraft();
  const signals = moduleSignals(sourceFile);
  for (const statement of sourceFile.statements) {
    collectModuleStatement(statement, draft, signals);
  }
  pruneUnboundLegendValueBridges(draft);
  collectShadowedImports(sourceFile, draft);
  applyStyledComponentCandidates(draft, signals.styledFactories);
  return finalizeModuleRecord(draft);
}

function emptyModuleRecordDraft(): ModuleRecordDraft {
  return {
    componentDeclarations: new Map(),
    contextReaderHooks: new Map(),
    deferredCallbackHooks: new Map(),
    deferredCallbackOwners: new Map(),
    frameworkEventComponents: new Set(),
    hookDeclarations: new Map(),
    imports: new Map(),
    legendValueHooks: new Map(),
    legendValueWriters: new Map(),
    localExports: new Map(),
    observableDeclarations: new Set(),
    observableFactoryCalls: new Map(),
    observableFactoryDeclarations: new Set(),
    observableKeys: new Map(),
    observableMemberDeclarations: new Map(),
    pureProjectionDeclarations: new Set(),
    reactContexts: new Set(),
    reexports: new Map(),
    shadowedImports: new Set(),
    starExports: [],
    styledComponentCandidates: [],
  };
}

function finalizeModuleRecord(draft: ModuleRecordDraft): ModuleRecord {
  return {
    componentDeclarations: draft.componentDeclarations,
    contextReaderHooks: draft.contextReaderHooks,
    deferredCallbackHooks: draft.deferredCallbackHooks,
    deferredCallbackOwners: draft.deferredCallbackOwners,
    frameworkEventComponents: draft.frameworkEventComponents,
    hookDeclarations: draft.hookDeclarations,
    imports: draft.imports,
    legendValueHooks: draft.legendValueHooks,
    legendValueWriters: draft.legendValueWriters,
    localExports: draft.localExports,
    observableDeclarations: draft.observableDeclarations,
    observableFactoryCalls: draft.observableFactoryCalls,
    observableFactoryDeclarations: draft.observableFactoryDeclarations,
    observableKeys: draft.observableKeys,
    observableMemberDeclarations: draft.observableMemberDeclarations,
    pureProjectionDeclarations: draft.pureProjectionDeclarations,
    reactContexts: draft.reactContexts,
    reexports: draft.reexports,
    shadowedImports: draft.shadowedImports,
    starExports: draft.starExports,
  };
}

function moduleSignals(sourceFile: ts.SourceFile): ModuleSignals {
  const imports = moduleImportSignals(sourceFile);
  return {
    ...imports,
    componentWrappers: collectReactComponentWrappers(sourceFile),
    deferredMethodsByClass: deferredRegistrationMethodsByClass(sourceFile),
    observableMemberFactories: localObservableMemberFactories(
      sourceFile,
      imports.observableFactories,
      imports.legendNamespaces,
    ),
    sourceFile,
  };
}

function deferredRegistrationMethodsByClass(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>> {
  const byClass = new Map<string, ReadonlyMap<string, ReadonlySet<number>>>();
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) {
      continue;
    }
    const methods = deferredRegistrationMethods(statement);
    if (methods.size > 0) {
      byClass.set(statement.name.text, methods);
    }
  }
  return byClass;
}

type ImportSignalCollector = (
  signals: ModuleImportSignals,
  statement: ts.ImportDeclaration,
) => void;

const IMPORT_SIGNAL_COLLECTORS = new Map<string, ImportSignalCollector>([
  ["@legendapp/state", collectLegendStateImports],
  ["@legendapp/state/react", collectLegendReactImports],
  ["react", collectReactImports],
  ["react-native", collectReactNativeImports],
  ["react-native-web", collectReactNativeImports],
  ["styled-components", collectStyledComponentsImports],
]);

function moduleImportSignals(sourceFile: ts.SourceFile): ModuleImportSignals {
  const signals: ModuleImportSignals = {
    legendNamespaces: new Set(),
    nativeComponentFactories: new Set(),
    observableFactories: new Set(),
    observableTypes: new Set(),
    reactContextFactories: new Set(),
    reactContextReaders: new Set(),
    reactEffectHooks: new Set(),
    reactNamespaces: new Set(),
    styledFactories: new Set(),
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
  addNamedImportAliases(signals.observableFactories, bindings, "observable");
  addNamedImportAliases(signals.observableTypes, bindings, "Observable");
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

function collectModuleStatement(
  statement: ts.Statement,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  if (ts.isFunctionDeclaration(statement)) {
    collectFunctionDeclaration(statement, draft, signals);
  } else if (ts.isClassDeclaration(statement)) {
    collectClassDeclaration(statement, draft);
  } else if (ts.isVariableStatement(statement)) {
    collectVariableStatement(statement, draft, signals);
  } else {
    collectModuleBindingStatement(statement, draft, signals);
  }
}

function collectModuleBindingStatement(
  statement: ts.Statement,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
    collectImportBindings(statement.importClause, draft, statement.moduleSpecifier.text);
  } else if (ts.isExportDeclaration(statement)) {
    collectExportDeclaration(statement, draft);
  } else if (ts.isExportAssignment(statement)) {
    collectExportAssignment(statement, draft, signals);
  }
}

function collectFunctionDeclaration(
  statement: ts.FunctionDeclaration,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const name = statement.name?.text;
  if (name === undefined) {
    collectAnonymousDefaultFunction(statement, draft);
    return;
  }
  collectHookFunctionDeclaration(statement, draft, name);
  const traits = functionDeclarationTraits(statement, draft, signals);
  recordFunctionTraitDeclarations(draft, traits);
  applyFunctionTraitExports(statement, draft, traits);
  collectObservableFactoryFunction(statement, draft, signals);
  collectComponentFunctionDeclaration(statement, draft);
}

function collectAnonymousDefaultFunction(
  statement: ts.FunctionDeclaration,
  draft: ModuleRecordDraft,
): void {
  if (hasExport(statement) && hasDefault(statement)) {
    draft.componentDeclarations.set("default", statement);
    draft.localExports.set("default", "default");
  }
}

function collectHookFunctionDeclaration(
  statement: ts.FunctionDeclaration,
  draft: ModuleRecordDraft,
  name: string,
): void {
  if (!/^use[A-Z0-9]/u.test(name)) {
    return;
  }
  draft.hookDeclarations.set(name, statement);
  if (hasExport(statement)) {
    draft.localExports.set(name, name);
  }
  if (hasDefault(statement)) {
    draft.localExports.set("default", name);
  }
}

function functionDeclarationTraits(
  statement: ts.FunctionDeclaration,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): FunctionTraits {
  return {
    deferredParameters: deferredCallbackParameterIndices(statement, {
      effectHooks: signals.reactEffectHooks,
      reactNamespaces: signals.reactNamespaces,
    }),
    hookObservable: directLegendValueHookObservable(statement, signals.useValueHooks),
    name: statement.name?.text ?? "",
    pureProjection: isPureProjectionDeclaration(statement, draft.imports),
    readContext: directReactContextReader(
      statement,
      signals.reactContextReaders,
      signals.reactNamespaces,
    ),
    writerObservable: directLegendValueWriterObservable(statement),
  };
}

function recordFunctionTraitDeclarations(draft: ModuleRecordDraft, traits: FunctionTraits): void {
  if (traits.readContext) {
    draft.contextReaderHooks.set(traits.name, traits.readContext);
  }
  if (traits.deferredParameters.size > 0) {
    draft.deferredCallbackHooks.set(traits.name, traits.deferredParameters);
  }
  if (traits.hookObservable) {
    draft.legendValueHooks.set(traits.name, traits.hookObservable);
  }
  if (traits.writerObservable) {
    draft.legendValueWriters.set(traits.name, traits.writerObservable);
  }
  if (traits.pureProjection) {
    draft.pureProjectionDeclarations.add(traits.name);
  }
}

function applyFunctionTraitExports(
  statement: ts.FunctionDeclaration,
  draft: ModuleRecordDraft,
  traits: FunctionTraits,
): void {
  const { deferredParameters, name } = traits;
  const signalled =
    deferredParameters.size > 0 ||
    Boolean(traits.hookObservable) ||
    Boolean(traits.writerObservable) ||
    draft.pureProjectionDeclarations.has(name) ||
    Boolean(traits.readContext);
  if (signalled && hasExport(statement)) {
    draft.localExports.set(name, name);
  }
  if (deferredParameters.size > 0 && hasDefault(statement)) {
    draft.localExports.set("default", name);
  }
}

function collectObservableFactoryFunction(
  statement: ts.FunctionDeclaration,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const name = statement.name?.text;
  if (
    name === undefined ||
    !statement.type ||
    !isObservableTypeReference(statement.type, signals.observableTypes)
  ) {
    return;
  }
  draft.observableFactoryDeclarations.add(name);
  if (hasExport(statement)) {
    draft.localExports.set(name, name);
  }
}

function collectComponentFunctionDeclaration(
  statement: ts.FunctionDeclaration,
  draft: ModuleRecordDraft,
): void {
  const name = statement.name?.text;
  if (name === undefined || !isSemanticComponentName(name)) {
    return;
  }
  draft.componentDeclarations.set(name, statement);
  if (hasExport(statement)) {
    draft.localExports.set(name, name);
  }
  if (hasDefault(statement)) {
    draft.localExports.set("default", name);
  }
}

function collectClassDeclaration(statement: ts.ClassDeclaration, draft: ModuleRecordDraft): void {
  const name = statement.name?.text;
  if (name === undefined) {
    collectAnonymousDefaultClass(statement, draft);
    return;
  }
  if (!isSemanticComponentName(name)) {
    return;
  }
  if (hasExport(statement)) {
    draft.localExports.set(name, name);
  }
  if (hasDefault(statement)) {
    draft.localExports.set("default", name);
  }
}

function collectAnonymousDefaultClass(
  statement: ts.ClassDeclaration,
  draft: ModuleRecordDraft,
): void {
  if (hasExport(statement) && hasDefault(statement)) {
    draft.localExports.set("default", "default");
  }
}

function collectVariableStatement(
  statement: ts.VariableStatement,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const exported = hasExport(statement);
  for (const declaration of statement.declarationList.declarations) {
    collectVariableDeclaration(declarationContext(declaration, exported), draft, signals);
  }
}

function declarationContext(
  declaration: ts.VariableDeclaration,
  exported: boolean,
): DeclarationContext {
  return {
    declaration,
    exported,
    initializer: declaration.initializer
      ? unwrapTransparentExpression(declaration.initializer)
      : null,
    isConst:
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0,
    name: ts.isIdentifier(declaration.name) ? declaration.name.text : null,
  };
}

function collectVariableDeclaration(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  collectReactContextDeclaration(context, draft, signals);
  collectHookVariableDeclaration(context, draft);
  collectDeferredOwnerDeclaration(context, draft, signals);
  collectStyledCandidate(context, draft);
  collectCallInitializerDeclaration(context, draft, signals);
  collectObjectObservableMembers(context, draft, signals);
  collectObservableDeclaration(context, draft, signals);
  collectComponentVariableDeclaration(context, draft, signals);
}

function collectReactContextDeclaration(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const { initializer, name } = context;
  if (
    name === null ||
    !initializer ||
    !isReactContextInitializer(initializer, signals.reactContextFactories, signals.reactNamespaces)
  ) {
    return;
  }
  draft.reactContexts.add(name);
  if (context.exported) {
    draft.localExports.set(name, name);
  }
}

function collectHookVariableDeclaration(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
): void {
  const { initializer, name } = context;
  if (
    name === null ||
    !/^use[A-Z0-9]/u.test(name) ||
    !initializer ||
    !(ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
  ) {
    return;
  }
  draft.hookDeclarations.set(name, initializer);
  if (context.exported) {
    draft.localExports.set(name, name);
  }
}

function collectDeferredOwnerDeclaration(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const { initializer, name } = context;
  if (
    name === null ||
    !initializer ||
    !ts.isNewExpression(initializer) ||
    !ts.isIdentifier(initializer.expression)
  ) {
    return;
  }
  const methods = signals.deferredMethodsByClass.get(initializer.expression.text);
  if (!methods) {
    return;
  }
  draft.deferredCallbackOwners.set(name, methods);
  if (context.exported) {
    draft.localExports.set(name, name);
  }
}

function collectStyledCandidate(context: DeclarationContext, draft: ModuleRecordDraft): void {
  const { initializer, name } = context;
  const styledTarget =
    name !== null && initializer && context.isConst ? styledComponentTarget(initializer) : null;
  if (name !== null && styledTarget) {
    draft.styledComponentCandidates.push({ exported: context.exported, name, ...styledTarget });
  }
}

function collectCallInitializerDeclaration(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const { initializer, name } = context;
  if (
    name === null ||
    !initializer ||
    !ts.isCallExpression(initializer) ||
    !ts.isIdentifier(initializer.expression)
  ) {
    return;
  }
  const callee = initializer.expression.text;
  if (signals.nativeComponentFactories.has(callee) && context.isConst) {
    draft.frameworkEventComponents.add(name);
  }
  draft.observableFactoryCalls.set(name, callee);
  recordObservableMemberFactoryCall(context, draft, signals.observableMemberFactories.get(callee));
  if (context.exported) {
    draft.localExports.set(name, name);
  }
}

function recordObservableMemberFactoryCall(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
  members: ReadonlySet<string> | undefined,
): void {
  if (context.name !== null && members && context.isConst) {
    draft.observableMemberDeclarations.set(context.name, members);
  }
}

function collectObjectObservableMembers(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const { initializer, name } = context;
  if (
    name === null ||
    !initializer ||
    !ts.isObjectLiteralExpression(initializer) ||
    !context.isConst
  ) {
    return;
  }
  const members = directObservableMembers(
    initializer,
    signals.observableFactories,
    signals.legendNamespaces,
  );
  if (members.size === 0) {
    return;
  }
  draft.observableMemberDeclarations.set(name, members);
  if (context.exported) {
    draft.localExports.set(name, name);
  }
}

function collectObservableDeclaration(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const { declaration, name } = context;
  if (
    name === null ||
    !declaration.initializer ||
    !isObservableInitializer(
      declaration.initializer,
      signals.observableFactories,
      signals.legendNamespaces,
    )
  ) {
    return;
  }
  draft.observableDeclarations.add(name);
  const keys = observableInitializerKeys(declaration.initializer);
  if (keys) {
    draft.observableKeys.set(name, keys);
  }
  if (context.exported) {
    draft.localExports.set(name, name);
  }
}

function observableInitializerKeys(initializer: ts.Expression): ReadonlySet<string> | null {
  const call = unwrapTransparentExpression(initializer);
  return ts.isCallExpression(call) && call.arguments[0]
    ? exactObjectLiteralKeys(call.arguments[0])
    : null;
}

function collectComponentVariableDeclaration(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const { declaration, name } = context;
  if (
    name === null ||
    !isSemanticComponentName(name) ||
    !declaration.initializer ||
    !isComponentInitializer(declaration.initializer, signals.componentWrappers)
  ) {
    return;
  }
  const component = componentFunction(declaration.initializer, signals.componentWrappers);
  if (!component) {
    return;
  }
  draft.componentDeclarations.set(name, component);
  if (context.exported) {
    draft.localExports.set(name, name);
  }
}

function collectImportBindings(
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

function collectExportDeclaration(statement: ts.ExportDeclaration, draft: ModuleRecordDraft): void {
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

function collectExportAssignment(
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

function pruneUnboundLegendValueBridges(draft: ModuleRecordDraft): void {
  for (const [name, observable] of draft.legendValueHooks) {
    if (!draft.observableDeclarations.has(observable)) {
      draft.legendValueHooks.delete(name);
    }
  }
  for (const [name, observable] of draft.legendValueWriters) {
    if (!draft.observableDeclarations.has(observable)) {
      draft.legendValueWriters.delete(name);
    }
  }
}

function collectShadowedImports(sourceFile: ts.SourceFile, draft: ModuleRecordDraft): void {
  visit(sourceFile, (node) => {
    if (ts.isIdentifier(node) && draft.imports.has(node.text) && isDeclarationName(node)) {
      draft.shadowedImports.add(node.text);
    }
  });
}

function applyStyledComponentCandidates(
  draft: ModuleRecordDraft,
  styledFactories: ReadonlySet<string>,
): void {
  for (const candidate of draft.styledComponentCandidates) {
    applyStyledComponentCandidate(draft, styledFactories, candidate);
  }
}

function applyStyledComponentCandidate(
  draft: ModuleRecordDraft,
  styledFactories: ReadonlySet<string>,
  candidate: StyledComponentCandidate,
): void {
  if (
    !styledFactories.has(candidate.factory) ||
    draft.shadowedImports.has(candidate.factory) ||
    draft.shadowedImports.has(candidate.targetRoot)
  ) {
    return;
  }
  const binding = draft.imports.get(candidate.targetRoot);
  const provenTarget = binding
    ? isFrameworkEventModuleSpecifier(binding.moduleSpecifier)
    : draft.frameworkEventComponents.has(candidate.targetRoot);
  if (!provenTarget) {
    return;
  }
  draft.frameworkEventComponents.add(candidate.name);
  if (candidate.exported) {
    draft.localExports.set(candidate.name, candidate.name);
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

function isReactContextInitializer(
  expression: ts.Expression,
  factories: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): boolean {
  const initializer = unwrapTransparentExpression(expression);
  if (!ts.isCallExpression(initializer)) {
    return false;
  }
  const callee = initializer.expression;
  return ts.isIdentifier(callee)
    ? factories.has(callee.text)
    : ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text) &&
        callee.name.text === "createContext";
}

function directReactContextReader(
  declaration: ts.FunctionDeclaration,
  readers: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): string | null {
  if (!declaration.body || declaration.body.statements.length !== 1) {
    return null;
  }
  const [statement] = declaration.body.statements;
  const expression =
    statement && ts.isReturnStatement(statement) && statement.expression
      ? unwrapTransparentExpression(statement.expression)
      : null;
  if (!expression || !ts.isCallExpression(expression) || expression.arguments.length !== 1) {
    return null;
  }
  const callee = expression.expression;
  const knownReader = ts.isIdentifier(callee)
    ? readers.has(callee.text)
    : ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      namespaces.has(callee.expression.text) &&
      (callee.name.text === "use" || callee.name.text === "useContext");
  const context = expression.arguments[0]
    ? unwrapTransparentExpression(expression.arguments[0])
    : null;
  return knownReader && context && ts.isIdentifier(context) ? context.text : null;
}

interface ReactEffectNames {
  effectHooks: ReadonlySet<string>;
  reactNamespaces: ReadonlySet<string>;
}

function deferredCallbackParameterIndices(
  declaration: ts.FunctionDeclaration,
  react: ReactEffectNames,
): ReadonlySet<number> {
  const deferred = new Set<number>();
  if (!declaration.body || declaresReactEffectBinding(declaration, react)) {
    return deferred;
  }
  for (const [index, parameter] of declaration.parameters.entries()) {
    if (
      ts.isIdentifier(parameter.name) &&
      parameterIsEffectDeferred(declaration, parameter.name.text, react)
    ) {
      deferred.add(index);
    }
  }
  return deferred;
}

function declaresReactEffectBinding(
  declaration: ts.FunctionDeclaration,
  react: ReactEffectNames,
): boolean {
  return [...react.effectHooks, ...react.reactNamespaces].some(
    (binding) => bindingDeclarationCount(declaration, binding) > 0,
  );
}

function parameterIsEffectDeferred(
  declaration: ts.FunctionDeclaration,
  parameterName: string,
  react: ReactEffectNames,
): boolean {
  let callbackReference = false;
  let references = 0;
  let safe = true;
  visit(declaration.body!, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== parameterName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    references += 1;
    const effect = enclosingEffectCall(node, declaration, react);
    if (!effect) {
      safe = false;
      return;
    }
    if (effect.arguments[0] && nodeWithin(node, effect.arguments[0])) {
      callbackReference = true;
    }
  });
  return safe && references > 0 && callbackReference;
}

function enclosingEffectCall(
  node: ts.Node,
  boundary: ts.FunctionDeclaration,
  react: ReactEffectNames,
): ts.CallExpression | null {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (
      !ts.isCallExpression(current) ||
      !current.arguments.some((argument) => nodeWithin(node, argument))
    ) {
      continue;
    }
    if (
      (ts.isIdentifier(current.expression) && react.effectHooks.has(current.expression.text)) ||
      (ts.isPropertyAccessExpression(current.expression) &&
        ts.isIdentifier(current.expression.expression) &&
        react.reactNamespaces.has(current.expression.expression.text) &&
        REACT_EFFECT_HOOKS.has(current.expression.name.text))
    ) {
      return current;
    }
  }
  return null;
}

function directLegendValueHookObservable(
  declaration: ts.FunctionDeclaration,
  useValueHooks: ReadonlySet<string>,
): string | null {
  const returned = soleReturnedExpression(declaration);
  if (declaration.parameters.length > 0 || !returned) {
    return null;
  }
  const expression = unwrapNullishFallback(returned);
  if (
    !ts.isCallExpression(expression) ||
    expression.arguments.length !== 1 ||
    !ts.isIdentifier(expression.expression) ||
    !useValueHooks.has(expression.expression.text)
  ) {
    return null;
  }
  const observable = unwrapTransparentExpression(expression.arguments[0]!);
  return ts.isIdentifier(observable) ? observable.text : null;
}

function soleReturnedExpression(declaration: ts.FunctionDeclaration): ts.Expression | null {
  const statements = declaration.body?.statements;
  if (!statements || statements.length !== 1) {
    return null;
  }
  const [statement] = statements;
  return statement && ts.isReturnStatement(statement) && statement.expression
    ? unwrapTransparentExpression(statement.expression)
    : null;
}

function unwrapNullishFallback(expression: ts.Expression): ts.Expression {
  return ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ? unwrapTransparentExpression(expression.left)
    : expression;
}

function directLegendValueWriterObservable(declaration: ts.FunctionDeclaration): string | null {
  const [parameter] = declaration.parameters;
  const statement = declaration.body?.statements[0];
  if (
    declaration.parameters.length !== 1 ||
    !parameter ||
    !ts.isIdentifier(parameter.name) ||
    declaration.body?.statements.length !== 1 ||
    !statement ||
    !ts.isExpressionStatement(statement)
  ) {
    return null;
  }
  const expression = unwrapTransparentExpression(statement.expression);
  const argument =
    ts.isCallExpression(expression) && expression.arguments[0]
      ? unwrapTransparentExpression(expression.arguments[0])
      : null;
  if (
    !ts.isCallExpression(expression) ||
    expression.arguments.length !== 1 ||
    !argument ||
    !ts.isIdentifier(argument) ||
    argument.text !== parameter.name.text ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.name.text !== "set"
  ) {
    return null;
  }
  const observable = unwrapTransparentExpression(expression.expression.expression);
  return ts.isIdentifier(observable) ? observable.text : null;
}

function isPureProjectionDeclaration(
  declaration: ts.FunctionDeclaration,
  imports: ReadonlyMap<string, ImportBinding>,
): boolean {
  if (
    !declaration.body ||
    declaration.asteriskToken ||
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    declaration.body.statements.length !== 1 ||
    declaration.parameters.length === 0 ||
    declaration.parameters.some(
      (parameter) => !ts.isIdentifier(parameter.name) || parameter.initializer !== undefined,
    )
  ) {
    return false;
  }
  const [statement] = declaration.body.statements;
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) {
    return false;
  }
  // SAFETY: the guard above returns false unless every parameter name is an identifier.
  const parameters = new Set(
    declaration.parameters.map((parameter) => (parameter.name as ts.Identifier).text),
  );
  const referenced = new Set<string>();
  const pure = isPureProjectionExpression(
    statement.expression,
    { imports, parameters },
    referenced,
  );
  return pure && [...parameters].every((parameter) => referenced.has(parameter));
}

interface ProjectionScope {
  imports: ReadonlyMap<string, ImportBinding>;
  parameters: ReadonlySet<string>;
}

function isPureProjectionExpression(
  expression: ts.Expression,
  scope: ProjectionScope,
  referenced: Set<string>,
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return recordProjectionParameter(value, scope.parameters, referenced);
  }
  if (isPureProjectionLiteral(value)) {
    return true;
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.every(
      (element) =>
        !ts.isSpreadElement(element) && isPureProjectionExpression(element, scope, referenced),
    );
  }
  return isPureProjectionCall(value, scope, referenced);
}

function recordProjectionParameter(
  value: ts.Identifier,
  parameters: ReadonlySet<string>,
  referenced: Set<string>,
): boolean {
  if (!parameters.has(value.text)) {
    return false;
  }
  referenced.add(value.text);
  return true;
}

function isPureProjectionLiteral(value: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  );
}

function isPureProjectionCall(
  value: ts.Expression,
  scope: ProjectionScope,
  referenced: Set<string>,
): boolean {
  if (
    !ts.isCallExpression(value) ||
    !ts.isIdentifier(value.expression) ||
    scope.parameters.has(value.expression.text)
  ) {
    return false;
  }
  const binding = scope.imports.get(value.expression.text);
  if (!binding || !isKnownPureProjectionImport(binding)) {
    return false;
  }
  return value.arguments.every(
    (argument) =>
      !ts.isSpreadElement(argument) && isPureProjectionExpression(argument, scope, referenced),
  );
}

function isKnownPureProjectionImport(binding: ImportBinding): boolean {
  return (
    (binding.moduleSpecifier === "clsx" && binding.importedName === "clsx") ||
    (binding.moduleSpecifier === "tailwind-merge" && binding.importedName === "twMerge")
  );
}

function deferredRegistrationMethods(
  declaration: ts.ClassDeclaration,
): ReadonlyMap<string, ReadonlySet<number>> {
  const methods = new Map<string, ReadonlySet<number>>();
  for (const member of declaration.members) {
    if (!ts.isMethodDeclaration(member) || !member.body || !ts.isIdentifier(member.name)) {
      continue;
    }
    const deferred = deferredMethodParameterIndices(declaration, member);
    if (deferred.size > 0) {
      methods.set(member.name.text, deferred);
    }
  }
  return methods;
}

function deferredMethodParameterIndices(
  declaration: ts.ClassDeclaration,
  method: ts.MethodDeclaration,
): ReadonlySet<number> {
  const deferred = new Set<number>();
  for (const [index, parameter] of method.parameters.entries()) {
    if (
      ts.isIdentifier(parameter.name) &&
      bindingDeclarationCount(method, parameter.name.text) === 1 &&
      methodStoresCallbackUntilCleanup(declaration, method, parameter.name)
    ) {
      deferred.add(index);
    }
  }
  return deferred;
}

function methodStoresCallbackUntilCleanup(
  declaration: ts.ClassDeclaration,
  method: ts.MethodDeclaration,
  parameter: ts.Identifier,
): boolean {
  const { body } = method;
  if (!body) {
    return false;
  }
  const { references, returns } = collectCallbackUsage(body, method, parameter);
  const cleanup = soleCleanupFunction(returns, references.length);
  if (!cleanup) {
    return false;
  }
  return callbackIsStoredThenRemoved(declaration, { cleanup, references, returns });
}

interface CallbackUsage {
  references: readonly ts.Identifier[];
  returns: readonly ts.ReturnStatement[];
}

function collectCallbackUsage(
  body: ts.Block,
  method: ts.MethodDeclaration,
  parameter: ts.Identifier,
): CallbackUsage {
  const returns: ts.ReturnStatement[] = [];
  const references: ts.Identifier[] = [];
  visit(body, (node) => {
    if (ts.isReturnStatement(node) && nearestNestedFunction(node, method) === null) {
      returns.push(node);
    }
    if (
      ts.isIdentifier(node) &&
      node.text === parameter.text &&
      node !== parameter &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return { references, returns };
}

function soleCleanupFunction(
  returns: readonly ts.ReturnStatement[],
  referenceCount: number,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const returned = returns.length === 1 ? returns[0]?.expression : undefined;
  if (!returned || referenceCount < MINIMUM_STORED_CALLBACK_REFERENCES) {
    return null;
  }
  const cleanup = unwrapTransparentExpression(returned);
  return ts.isArrowFunction(cleanup) || ts.isFunctionExpression(cleanup) ? cleanup : null;
}

function callbackIsStoredThenRemoved(
  declaration: ts.ClassDeclaration,
  usage: {
    cleanup: ts.ArrowFunction | ts.FunctionExpression;
    references: readonly ts.Identifier[];
    returns: readonly ts.ReturnStatement[];
  },
): boolean {
  const { cleanup, references, returns } = usage;
  const stored = references.flatMap((reference) => {
    const property = storedCallbackProperty(reference, declaration);
    return property ? [{ property, reference }] : [];
  });
  const first = stored.length === 1 ? stored[0] : null;
  if (!first || first.reference.getStart() >= returns[0]!.getStart()) {
    return false;
  }
  return references.every(
    (reference) =>
      reference === first.reference ||
      (nodeWithin(reference, cleanup) &&
        callbackReferenceIsRemoved(reference, cleanup, first.property)),
  );
}

function callbackReferenceIsRemoved(
  reference: ts.Identifier,
  cleanup: ts.ArrowFunction | ts.FunctionExpression,
  property: string,
): boolean {
  if (!isRemovalComparison(reference)) {
    return false;
  }
  const filter = enclosingFilterCall(reference, cleanup, property);
  return filter !== null && filterResultIsAssignedBack(filter, cleanup, property);
}

function isRemovalComparison(reference: ts.Identifier): boolean {
  const comparison = reference.parent;
  return (
    ts.isBinaryExpression(comparison) &&
    (comparison.left === reference || comparison.right === reference) &&
    [ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
      comparison.operatorToken.kind,
    )
  );
}

function enclosingFilterCall(
  reference: ts.Identifier,
  cleanup: ts.ArrowFunction | ts.FunctionExpression,
  property: string,
): ts.CallExpression | null {
  for (
    let current: ts.Node | undefined = reference.parent.parent;
    current && current !== cleanup;
    current = current.parent
  ) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "filter" &&
      isThisProperty(current.expression.expression, property) &&
      current.arguments.some((argument) => nodeWithin(reference, argument))
    ) {
      return current;
    }
  }
  return null;
}

function filterResultIsAssignedBack(
  filter: ts.CallExpression,
  cleanup: ts.ArrowFunction | ts.FunctionExpression,
  property: string,
): boolean {
  for (
    let current: ts.Node | undefined = filter.parent;
    current && current !== cleanup;
    current = current.parent
  ) {
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isThisProperty(current.left, property) &&
      unwrapTransparentExpression(current.right) === filter
    ) {
      return true;
    }
  }
  return false;
}

function storedCallbackProperty(
  reference: ts.Identifier,
  declaration: ts.ClassDeclaration,
): string | null {
  const call = reference.parent;
  if (
    !ts.isCallExpression(call) ||
    !call.arguments.includes(reference) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "push" ||
    !ts.isPropertyAccessExpression(call.expression.expression) ||
    call.expression.expression.expression.kind !== ts.SyntaxKind.ThisKeyword
  ) {
    return null;
  }
  const property = call.expression.expression.name.text;
  const field = declaration.members.find(
    (member) =>
      ts.isPropertyDeclaration(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === property,
  );
  if (!field || !ts.isPropertyDeclaration(field)) {
    return null;
  }
  const initializer = field.initializer && unwrapTransparentExpression(field.initializer);
  const fieldType = field.type;
  return (initializer && ts.isArrayLiteralExpression(initializer)) ||
    (fieldType !== undefined &&
      (ts.isArrayTypeNode(fieldType) ||
        (ts.isTypeReferenceNode(fieldType) &&
          ts.isIdentifier(fieldType.typeName) &&
          fieldType.typeName.text === "Array")))
    ? property
    : null;
}

function isThisProperty(expression: ts.Expression, property: string): boolean {
  const value = unwrapTransparentExpression(expression);
  return (
    ts.isPropertyAccessExpression(value) &&
    value.expression.kind === ts.SyntaxKind.ThisKeyword &&
    value.name.text === property
  );
}

function isObservableTypeReference(
  type: ts.TypeNode,
  observableTypes: ReadonlySet<string>,
): boolean {
  return (
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    observableTypes.has(type.typeName.text)
  );
}

function isObservableInitializer(
  expression: ts.Expression,
  factories: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (!ts.isCallExpression(value)) {
    return false;
  }
  if (ts.isIdentifier(value.expression)) {
    return factories.has(value.expression.text);
  }
  return (
    ts.isPropertyAccessExpression(value.expression) &&
    ts.isIdentifier(value.expression.expression) &&
    namespaces.has(value.expression.expression.text) &&
    value.expression.name.text === "observable"
  );
}

function localObservableMemberFactories(
  sourceFile: ts.SourceFile,
  factories: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const proven = new Map<string, ReadonlySet<string>>();
  for (const [name, declaration] of topLevelFunctionDeclarations(sourceFile)) {
    const members = declaration
      ? provenObservableMembers(sourceFile, declaration, { factories, name, namespaces })
      : null;
    if (members) {
      proven.set(name, members);
    }
  }
  return proven;
}

function topLevelFunctionDeclarations(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, ComponentFunction | null> {
  const declarations = new Map<string, ComponentFunction | null>();
  for (const statement of sourceFile.statements) {
    for (const [name, declaration] of topLevelFunctionsIn(statement)) {
      declarations.set(name, declarations.has(name) ? null : declaration);
    }
  }
  return declarations;
}

function topLevelFunctionsIn(
  statement: ts.Statement,
): readonly (readonly [string, ComponentFunction])[] {
  if (ts.isFunctionDeclaration(statement) && statement.name) {
    return [[statement.name.text, statement] as const];
  }
  if (
    !ts.isVariableStatement(statement) ||
    (statement.declarationList.flags & ts.NodeFlags.Const) === 0
  ) {
    return [];
  }
  return statement.declarationList.declarations.flatMap((declaration) => {
    const initializer = declaration.initializer
      ? unwrapTransparentExpression(declaration.initializer)
      : null;
    return ts.isIdentifier(declaration.name) &&
      initializer &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
      ? [[declaration.name.text, initializer] as const]
      : [];
  });
}

function provenObservableMembers(
  sourceFile: ts.SourceFile,
  declaration: ComponentFunction,
  context: { factories: ReadonlySet<string>; name: string; namespaces: ReadonlySet<string> },
): ReadonlySet<string> | null {
  const { factories, name, namespaces } = context;
  if (
    bindingIsAssigned(sourceFile, name) ||
    [...factories, ...namespaces].some(
      (binding) => bindingDeclarationCount(declaration, binding) > 0,
    )
  ) {
    return null;
  }
  const object = exactReturnedObject(declaration);
  const members = object ? directObservableMembers(object, factories, namespaces) : null;
  return members && members.size > 0 ? members : null;
}

const assignedBindingsByFile = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

function bindingIsAssigned(sourceFile: ts.SourceFile, name: string): boolean {
  let assigned = assignedBindingsByFile.get(sourceFile);
  if (assigned) {
    return assigned.has(name);
  }

  const collected = new Set<string>();
  visit(sourceFile, (node) => {
    if (!ts.isIdentifier(node)) {
      return;
    }
    const { parent } = node;
    if (
      (ts.isBinaryExpression(parent) &&
        parent.left === node &&
        isAssignmentOperator(parent.operatorToken.kind)) ||
      (ts.isPrefixUnaryExpression(parent) &&
        parent.operand === node &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken ||
          parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isPostfixUnaryExpression(parent) && parent.operand === node)
    ) {
      collected.add(node.text);
    }
  });
  assigned = collected;
  assignedBindingsByFile.set(sourceFile, assigned);
  return assigned.has(name);
}

function exactReturnedObject(declaration: ComponentFunction): ts.ObjectLiteralExpression | null {
  const returned = soleReturnedValue(declaration);
  return returned && ts.isObjectLiteralExpression(returned) ? returned : null;
}

function soleReturnedValue(declaration: ComponentFunction): ts.Expression | null {
  if (ts.isArrowFunction(declaration) && !ts.isBlock(declaration.body)) {
    return unwrapTransparentExpression(declaration.body);
  }
  const { body } = declaration;
  if (!body || !ts.isBlock(body) || body.statements.length !== 1) {
    return null;
  }
  const [statement] = body.statements;
  return statement && ts.isReturnStatement(statement) && statement.expression
    ? unwrapTransparentExpression(statement.expression)
    : null;
}

function directObservableMembers(
  object: ts.ObjectLiteralExpression,
  factories: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): ReadonlySet<string> {
  const names = new Set<string>();
  const observableMembers = new Set<string>();
  for (const property of object.properties) {
    const name = staticPropertyName(property);
    if (!name || names.has(name)) {
      return new Set();
    }
    names.add(name);
    if (
      ts.isPropertyAssignment(property) &&
      isObservableInitializer(property.initializer, factories, namespaces)
    ) {
      observableMembers.add(name);
    }
  }
  return observableMembers;
}

function staticPropertyName(property: ts.ObjectLiteralElementLike): string | null {
  return ts.isSpreadAssignment(property) || !property.name
    ? null
    : staticObjectMemberName(property.name);
}

function staticObjectMemberName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function compilerOptionsFor(root: string): ts.CompilerOptions {
  const configFile = ts.findConfigFile(root, ts.sys.fileExists);
  if (!configFile) {
    return { jsx: ts.JsxEmit.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler };
  }
  const read = ts.readConfigFile(configFile, ts.sys.readFile);
  if (read.error) {
    return { jsx: ts.JsxEmit.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler };
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configFile));
  const { options } = parsed;
  const missingBaseConfig = parsed.errors.some(
    (diagnostic) => diagnostic.code === MISSING_BASE_CONFIG_DIAGNOSTIC_CODE,
  );
  return options.moduleResolution === undefined && missingBaseConfig
    ? { ...options, moduleResolution: ts.ModuleResolutionKind.Bundler }
    : options;
}

function isSemanticComponentName(name: string): boolean {
  const first = name.slice(0, 1);
  return first !== "" && first === first.toUpperCase();
}

function isComponentInitializer(node: ts.Expression, wrappers: ReactComponentWrappers): boolean {
  const initializer = unwrapTransparentExpression(node);
  if (
    ts.isArrowFunction(initializer) ||
    ts.isFunctionExpression(initializer) ||
    ts.isClassExpression(initializer)
  ) {
    return true;
  }
  if (
    !ts.isCallExpression(initializer) ||
    !isReactComponentWrapper(initializer.expression, wrappers)
  ) {
    return false;
  }
  const [renderFunction] = initializer.arguments;
  return renderFunction !== undefined && isComponentRenderFunction(renderFunction);
}

function componentFunction(
  node: ts.Expression,
  wrappers: ReactComponentWrappers,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const initializer = unwrapTransparentExpression(node);
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    return initializer;
  }
  if (
    ts.isCallExpression(initializer) &&
    isReactComponentWrapper(initializer.expression, wrappers) &&
    initializer.arguments.length > 0
  ) {
    const [argument] = initializer.arguments;
    return argument ? componentRenderFunction(argument) : null;
  }
  return null;
}

function isComponentRenderFunction(node: ts.Expression): boolean {
  return componentRenderFunction(node) !== null;
}

function componentRenderFunction(
  node: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const render = unwrapTransparentExpression(node);
  return ts.isArrowFunction(render) || ts.isFunctionExpression(render) ? render : null;
}

function hasExport(node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function hasDefault(node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return (
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false
  );
}

function normalizeFile(file: string): string {
  return pathIdentityKey(file);
}
