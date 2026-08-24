import path from "node:path";

import ts from "typescript";

import {
  bindingDeclarationCount,
  exactObjectLiteralKeys,
  isAssignmentOperator,
  isDeclarationName,
  isNonValueIdentifier,
} from "./analysis-ast.js";
import {
  AnalysisProject,
  isSupportedAnalysisFile,
  type AnalysisFile,
} from "./analysis-project.js";
import {
  findAncestor,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  nodeWithin,
  visit,
} from "./ast.js";
import { pathIdentityKey } from "./path-identity.js";
import {
  collectReactComponentWrappers,
  isReactComponentWrapper,
  type ReactComponentWrappers,
} from "./react-component-wrappers.js";

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
  componentDeclarationFor(file: string, name: string): ResolvedSymbol | null;
  componentsFor(file: string): ReadonlySet<string>;
  contextReaderHooksFor(file: string, contextName: string): ReadonlyMap<string, ReadonlySet<string>>;
  deferredCallbackRegistrationsFor(
    file: string
  ): ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>;
  deferredCallbackHooksFor(file: string): ReadonlyMap<string, ReadonlySet<number>>;
  frameworkEventComponentFor(file: string, name: string): boolean;
  hookDeclarationFor(file: string, name: string): ResolvedSymbol | null;
  legendValueBridgesFor(file: string): ReadonlyMap<string, ReadonlySet<string>>;
  observableFactoriesFor(file: string): ReadonlySet<string>;
  observableKeysFor(file: string): ReadonlyMap<string, ReadonlySet<string>>;
  observablePathsFor(file: string): ReadonlySet<string>;
  observablesFor(file: string): ReadonlySet<string>;
  pureProjectionsFor(file: string): ReadonlySet<string>;
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

export function buildSourceIndex(
  root: string,
  sources: ReadonlyMap<string, string>
): SourceIndex {
  return buildSourceIndexFromFiles(
    root,
    new AnalysisProject(
      new Map([...sources].filter(([fileName]) => isSupportedAnalysisFile(fileName)))
    ).files
  );
}

export function buildSourceIndexFromFiles(
  root: string,
  files: readonly AnalysisFile[]
): SourceIndex {
  const records = new Map<string, ModuleRecord>();
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const file of files) {
    const normalized = normalizeFile(file.identityPath);
    records.set(normalized, moduleRecord(file.sourceFile));
    sourceFiles.set(normalized, file.sourceFile);
  }
  const importsByName = new Map<string, IndexedImportBinding[]>();
  const reexportsByName = new Map<string, IndexedReexportBinding[]>();
  const starExporters: Array<{ file: string; moduleSpecifier: string }> = [];
  for (const [file, record] of records) {
    for (const [localName, binding] of record.imports) {
      const indexed = importsByName.get(binding.importedName) ?? [];
      indexed.push({ ...binding, file, localName });
      importsByName.set(binding.importedName, indexed);
    }
    for (const [exportName, binding] of record.reexports) {
      const indexed = reexportsByName.get(binding.importedName) ?? [];
      indexed.push({ ...binding, exportName, file });
      reexportsByName.set(binding.importedName, indexed);
    }
    for (const moduleSpecifier of record.starExports) {
      starExporters.push({ file, moduleSpecifier });
    }
  }

  const compilerContexts = new Map<string, CompilerContext>();
  const compilerContextsByImporter = new Map<string, CompilerContext>();
  const configFilesByDirectory = new Map<string, string | null>();
  const componentsByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const contextReaderHooksByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const deferredCallbackOwnersByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const deferredCallbackHooksByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const frameworkEventComponentsByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const hooksByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const legendValueHooksByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const legendValueWritersByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const observableFactoriesByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const observableContainersByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const observablesByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const pureProjectionsByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const contextReaders = new Map<string, ReadonlyMap<string, ReadonlySet<string>>>();
  const contextReadersBySymbol = new Map<string, ReadonlyMap<string, ReadonlySet<string>>>();
  const stableObservableContainers = new Map<string, boolean>();
  const resolvedModules = new Map<string, string | null>();
  const aliasesBySymbol = new Map<string, ReadonlyMap<string, ReadonlySet<string>>>();
  const moduleResolutionHost = cachedModuleResolutionHost(new Set(records.keys()));

  function resolveModule(importer: string, specifier: string): string | null {
    const key = `${importer}\0${specifier}`;
    if (resolvedModules.has(key)) return resolvedModules.get(key) ?? null;
    const { cache, options } = compilerContextFor(
      importer,
      root,
      compilerContexts,
      compilerContextsByImporter,
      configFilesByDirectory
    );
    const resolution = ts.resolveModuleName(
      specifier,
      importer,
      options,
      moduleResolutionHost,
      cache
    ).resolvedModule;
    if (!resolution || resolution.isExternalLibraryImport) {
      resolvedModules.set(key, null);
      return null;
    }
    const resolved = normalizeFile(resolution.resolvedFileName.replace(/\.d\.(?:ts|mts|cts)$/, ".ts"));
    const local = records.has(resolved) ? resolved : null;
    resolvedModules.set(key, local);
    return local;
  }

  function exportedSymbol(
    file: string,
    exportName: string,
    kind: SourceSymbolKind,
    visited: ReadonlySet<string>,
    depth: number
  ): ResolvedSymbol | null {
    if (depth > 8) return null;
    const key = `${kind}\0${file}\0${exportName}`;
    if (visited.has(key)) return null;
    const record = records.get(file);
    if (!record) return null;
    const nextVisited = new Set(visited).add(key);

    const localName = record.localExports.get(exportName);
    if (localName) {
      const declared = kind === "component"
        ? record.componentDeclarations.has(localName)
        : kind === "context-reader-hook"
          ? record.contextReaderHooks.has(localName)
          : kind === "deferred-callback-owner"
            ? record.deferredCallbackOwners.has(localName)
            : kind === "deferred-callback-hook"
              ? record.deferredCallbackHooks.has(localName)
              : kind === "framework-event-component"
                ? record.frameworkEventComponents.has(localName)
              : kind === "hook"
                ? record.hookDeclarations.has(localName)
                : kind === "legend-value-hook"
                  ? record.legendValueHooks.has(localName)
                  : kind === "legend-value-writer"
                    ? record.legendValueWriters.has(localName)
                    : kind === "observable"
                      ? record.observableDeclarations.has(localName)
                      : kind === "observable-container"
                        ? record.observableMemberDeclarations.has(localName)
                      : kind === "observable-factory"
                        ? record.observableFactoryDeclarations.has(localName)
                        : kind === "react-context"
                          ? record.reactContexts.has(localName)
                          : record.pureProjectionDeclarations.has(localName);
      if (declared) return { file, localName };

      const importedLocal = record.imports.get(localName);
      const importedTarget = importedLocal
        ? resolveModule(file, importedLocal.moduleSpecifier)
        : null;
      if (importedLocal && importedTarget) {
        const imported = exportedSymbol(
          importedTarget,
          importedLocal.importedName,
          kind,
          nextVisited,
          depth + 1
        );
        if (imported) return imported;
      }

      const factoryName = kind === "observable"
        ? record.observableFactoryCalls.get(localName)
        : undefined;
      if (factoryName) {
        if (record.observableFactoryDeclarations.has(factoryName)) return { file, localName };
        const factoryImport = record.imports.get(factoryName);
        const target = factoryImport
          ? resolveModule(file, factoryImport.moduleSpecifier)
          : null;
        if (
          factoryImport &&
          target &&
          exportedSymbol(
            target,
            factoryImport.importedName,
            "observable-factory",
            nextVisited,
            depth + 1
          )
        ) {
          return { file, localName };
        }
      }
    }

    const reexport = record.reexports.get(exportName);
    if (reexport) {
      const target = resolveModule(file, reexport.moduleSpecifier);
      return target
        ? exportedSymbol(target, reexport.importedName, kind, nextVisited, depth + 1)
        : null;
    }

    const matches = record.starExports.flatMap(specifier => {
      const target = resolveModule(file, specifier);
      const component = target
        ? exportedSymbol(target, exportName, kind, nextVisited, depth + 1)
        : null;
      return component ? [component] : [];
    });
    const unique = new Map(matches.map(match => [`${match.file}\0${match.localName}`, match]));
    return unique.size === 1 ? unique.values().next().value ?? null : null;
  }

  function aliasesForSymbol(
    symbol: ResolvedSymbol,
    kind: "context-reader-hook" | "react-context"
  ): ReadonlyMap<string, ReadonlySet<string>> {
    const symbolKey = `${kind}\0${symbol.file}\0${symbol.localName}`;
    const cached = aliasesBySymbol.get(symbolKey);
    if (cached) return cached;
    const aliases = new Map<string, Set<string>>();
    const aliasQueue: ResolvedSymbol[] = [];
    const exportQueue: Array<{ file: string; name: string }> = [];
    const seenAliases = new Set<string>();
    const seenExports = new Set<string>();
    const addExport = (file: string, name: string): void => {
      const key = `${file}\0${name}`;
      if (seenExports.has(key)) return;
      seenExports.add(key);
      exportQueue.push({ file, name });
    };
    const addAlias = (file: string, localName: string): void => {
      const key = `${file}\0${localName}`;
      if (seenAliases.has(key)) return;
      seenAliases.add(key);
      const names = aliases.get(file) ?? new Set<string>();
      names.add(localName);
      aliases.set(file, names);
      aliasQueue.push({ file, localName });
    };
    addAlias(symbol.file, symbol.localName);

    let aliasIndex = 0;
    let exportIndex = 0;
    while (aliasIndex < aliasQueue.length || exportIndex < exportQueue.length) {
      while (aliasIndex < aliasQueue.length) {
        const alias = aliasQueue[aliasIndex++]!;
        for (const [exportName, localName] of records.get(alias.file)?.localExports ?? []) {
          if (localName === alias.localName) addExport(alias.file, exportName);
        }
      }
      const exported = exportQueue[exportIndex++];
      if (!exported) continue;
      for (const binding of importsByName.get(exported.name) ?? []) {
        if (resolveModule(binding.file, binding.moduleSpecifier) === exported.file) {
          addAlias(binding.file, binding.localName);
        }
      }
      for (const binding of reexportsByName.get(exported.name) ?? []) {
        if (resolveModule(binding.file, binding.moduleSpecifier) === exported.file) {
          addExport(binding.file, binding.exportName);
        }
      }
      for (const star of starExporters) {
        const resolved = resolveModule(star.file, star.moduleSpecifier) === exported.file
          ? exportedSymbol(star.file, exported.name, kind, new Set(), 0)
          : null;
        if (sameResolvedSymbol(resolved, symbol)) {
          addExport(star.file, exported.name);
        }
      }
    }
    aliasesBySymbol.set(symbolKey, aliases);
    return aliases;
  }

  function resolvedFor(file: string, kind: SourceSymbolKind): ReadonlyMap<string, ResolvedSymbol> {
    const importer = normalizeFile(file);
    const cache = kind === "component"
      ? componentsByImporter
      : kind === "context-reader-hook"
        ? contextReaderHooksByImporter
      : kind === "deferred-callback-owner"
        ? deferredCallbackOwnersByImporter
        : kind === "deferred-callback-hook"
          ? deferredCallbackHooksByImporter
          : kind === "framework-event-component"
            ? frameworkEventComponentsByImporter
          : kind === "hook"
            ? hooksByImporter
        : kind === "legend-value-hook"
          ? legendValueHooksByImporter
          : kind === "legend-value-writer"
            ? legendValueWritersByImporter
            : kind === "observable-factory"
              ? observableFactoriesByImporter
              : kind === "observable-container"
                ? observableContainersByImporter
              : kind === "observable"
                ? observablesByImporter
                : pureProjectionsByImporter;
    const cached = cache.get(importer);
    if (cached) return cached;
    const symbols = new Map<string, ResolvedSymbol>();
    const record = records.get(importer);
    if (record) {
      for (const [localName, binding] of record.imports) {
        if (kind === "component" && !isSemanticComponentName(localName)) continue;
        const target = resolveModule(importer, binding.moduleSpecifier);
        const symbol = target
          ? exportedSymbol(target, binding.importedName, kind, new Set(), 0)
          : null;
        if (symbol) symbols.set(localName, symbol);
      }
    }
    cache.set(importer, symbols);
    return symbols;
  }

  function localSymbol(file: string, name: string, kind: SourceSymbolKind): ResolvedSymbol | null {
    const record = records.get(file);
    const local = kind === "react-context"
      ? record?.reactContexts.has(name)
      : kind === "context-reader-hook"
        ? record?.contextReaderHooks.has(name)
        : false;
    if (local) return { file, localName: name };
    const binding = record?.imports.get(name);
    const target = binding ? resolveModule(file, binding.moduleSpecifier) : null;
    return binding && target
      ? exportedSymbol(target, binding.importedName, kind, new Set(), 0)
      : null;
  }

  function contextReaderHooksFor(
    file: string,
    contextName: string
  ): ReadonlyMap<string, ReadonlySet<string>> {
    const normalized = normalizeFile(file);
    const cacheKey = `${normalized}\0${contextName}`;
    const cached = contextReaders.get(cacheKey);
    if (cached) return cached;
    const context = localSymbol(normalized, contextName, "react-context");
    if (!context) {
      const empty = new Map<string, ReadonlySet<string>>();
      contextReaders.set(cacheKey, empty);
      return empty;
    }
    const symbolKey = `${context.file}\0${context.localName}`;
    const symbolCached = contextReadersBySymbol.get(symbolKey);
    if (symbolCached) {
      contextReaders.set(cacheKey, symbolCached);
      return symbolCached;
    }
    const contextAliases = aliasesForSymbol(context, "react-context");
    for (const [candidateFile, aliases] of contextAliases) {
      const record = records.get(candidateFile);
      const sourceFile = sourceFiles.get(candidateFile);
      if (
        !record ||
        !sourceFile ||
        [...aliases].some(alias =>
          !contextReferencesAreKnown(sourceFile, record, alias)
        )
      ) {
        const empty = new Map<string, ReadonlySet<string>>();
        contextReaders.set(cacheKey, empty);
        contextReadersBySymbol.set(symbolKey, empty);
        return empty;
      }
    }
    const readerSymbols: ResolvedSymbol[] = [];
    for (const [candidateFile, aliases] of contextAliases) {
      const record = records.get(candidateFile);
      if (!record) continue;
      for (const [readerName, localContextName] of record.contextReaderHooks) {
        if (aliases.has(localContextName)) {
          readerSymbols.push({ file: candidateFile, localName: readerName });
        }
      }
    }
    const consumers = new Map<string, Set<string>>();
    for (const reader of readerSymbols) {
      const localNames = consumers.get(reader.file) ?? new Set<string>();
      localNames.add(reader.localName);
      consumers.set(reader.file, localNames);
      for (const [consumerFile, aliases] of aliasesForSymbol(reader, "context-reader-hook")) {
        const names = consumers.get(consumerFile) ?? new Set<string>();
        const record = records.get(consumerFile);
        for (const localName of aliases) {
          const importedName = record?.imports.get(localName)?.importedName;
          if (
            (consumerFile === reader.file && localName === reader.localName) ||
            /^use[A-Z0-9]/.test(localName) ||
            (importedName !== undefined && /^use[A-Z0-9]/.test(importedName))
          ) {
            names.add(localName);
          }
        }
        if (names.size > 0) consumers.set(consumerFile, names);
      }
    }
    contextReaders.set(cacheKey, consumers);
    contextReadersBySymbol.set(symbolKey, consumers);
    return consumers;
  }

  function observableContainerIsStable(symbol: ResolvedSymbol): boolean {
    const key = `${symbol.file}\0${symbol.localName}`;
    const cached = stableObservableContainers.get(key);
    if (cached !== undefined) return cached;
    const members = records.get(symbol.file)?.observableMemberDeclarations.get(symbol.localName);
    if (!members) return false;
    for (const [candidateFile, record] of records) {
      const aliases = new Set<string>();
      if (candidateFile === symbol.file) aliases.add(symbol.localName);
      for (const [localName, binding] of record.imports) {
        const target = resolveModule(candidateFile, binding.moduleSpecifier);
        const imported = target
          ? exportedSymbol(target, binding.importedName, "observable-container", new Set(), 0)
          : null;
        if (sameResolvedSymbol(imported, symbol)) aliases.add(localName);
      }
      const sourceFile = sourceFiles.get(candidateFile);
      if (
        sourceFile &&
        [...aliases].some(alias => !observableContainerReferencesAreStable(sourceFile, alias, members))
      ) {
        stableObservableContainers.set(key, false);
        return false;
      }
    }
    stableObservableContainers.set(key, true);
    return true;
  }

  function contextReferencesAreKnown(
    sourceFile: ts.SourceFile,
    record: ModuleRecord,
    contextName: string
  ): boolean {
    let safe = true;
    visit(sourceFile, node => {
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
      if (ts.isExportAssignment(node.parent) && node.parent.expression === node) return;
      const member = node.parent;
      if (
        ts.isPropertyAccessExpression(member) &&
        member.expression === node &&
        member.name.text === "Provider" &&
        jsxTagUses(member)
      ) {
        return;
      }
      const owner = findAncestor(node, isRuntimeFunctionLike);
      const ownerName = owner &&
        (ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner))
        ? owner.name?.text
        : null;
      if (ownerName && record.contextReaderHooks.get(ownerName) === contextName) return;
      safe = false;
    });
    return safe;
  }

  return {
    componentDeclarationFor: (file, name) => {
      const normalized = normalizeFile(file);
      if (records.get(normalized)?.componentDeclarations.has(name)) {
        return { file: normalized, localName: name };
      }
      return resolvedFor(normalized, "component").get(name) ?? null;
    },
    componentsFor: file => new Set(resolvedFor(file, "component").keys()),
    contextReaderHooksFor,
    deferredCallbackRegistrationsFor: file => {
      const registrations = new Map<string, ReadonlyMap<string, ReadonlySet<number>>>();
      for (const [localName, symbol] of resolvedFor(file, "deferred-callback-owner")) {
        const methods = records.get(symbol.file)?.deferredCallbackOwners.get(symbol.localName);
        if (methods) registrations.set(localName, methods);
      }
      return registrations;
    },
    deferredCallbackHooksFor: file => {
      const hooks = new Map<string, ReadonlySet<number>>();
      const normalized = normalizeFile(file);
      for (const [localName, parameters] of records.get(normalized)?.deferredCallbackHooks ?? []) {
        hooks.set(localName, parameters);
      }
      for (const [localName, symbol] of resolvedFor(file, "deferred-callback-hook")) {
        const parameters = records.get(symbol.file)?.deferredCallbackHooks.get(symbol.localName);
        if (parameters) hooks.set(localName, parameters);
      }
      return hooks;
    },
    frameworkEventComponentFor: (file, name) => {
      const rootName = name.split(".", 1)[0] ?? name;
      const record = records.get(normalizeFile(file));
      if (record?.shadowedImports.has(rootName)) return false;
      const binding = record?.imports.get(rootName);
      return binding?.moduleSpecifier === "react-native" ||
        binding?.moduleSpecifier === "react-native-web" ||
        binding?.moduleSpecifier === "@radix-ui/react-dropdown-menu" ||
        binding?.moduleSpecifier === "@base-ui/react" ||
        binding?.moduleSpecifier.startsWith("@base-ui/react/") === true ||
        resolvedFor(file, "framework-event-component").has(rootName);
    },
    hookDeclarationFor: (file, name) => {
      const normalized = normalizeFile(file);
      if (records.get(normalized)?.hookDeclarations.has(name)) {
        return { file: normalized, localName: name };
      }
      return resolvedFor(normalized, "hook").get(name) ?? null;
    },
    legendValueBridgesFor: file => {
      const bridges = new Map<string, ReadonlySet<string>>();
      const writers = resolvedFor(file, "legend-value-writer");
      for (const [hookName, hook] of resolvedFor(file, "legend-value-hook")) {
        const observable = records.get(hook.file)?.legendValueHooks.get(hook.localName);
        if (!observable) continue;
        const matches = new Set<string>();
        for (const [writerName, writer] of writers) {
          if (
            writer.file === hook.file &&
            records.get(writer.file)?.legendValueWriters.get(writer.localName) === observable
          ) {
            matches.add(writerName);
          }
        }
        if (matches.size > 0) bridges.set(hookName, matches);
      }
      return bridges;
    },
    observableFactoriesFor: file => new Set(resolvedFor(file, "observable-factory").keys()),
    observableKeysFor: file => {
      const keys = new Map<string, ReadonlySet<string>>();
      for (const [localName, symbol] of resolvedFor(file, "observable")) {
        const observableKeys = records.get(symbol.file)?.observableKeys.get(symbol.localName);
        if (observableKeys) keys.set(localName, observableKeys);
      }
      return keys;
    },
    observablePathsFor: file => {
      const paths = new Set<string>();
      const normalized = normalizeFile(file);
      for (const [localName, members] of records.get(normalized)?.observableMemberDeclarations ?? []) {
        if (!observableContainerIsStable({ file: normalized, localName })) continue;
        for (const member of members) paths.add(`${localName}.${member}`);
      }
      for (const [localName, symbol] of resolvedFor(normalized, "observable-container")) {
        if (!observableContainerIsStable(symbol)) continue;
        const members = records.get(symbol.file)?.observableMemberDeclarations.get(symbol.localName);
        if (!members) continue;
        for (const member of members) paths.add(`${localName}.${member}`);
      }
      return paths;
    },
    observablesFor: file => new Set(resolvedFor(file, "observable").keys()),
    pureProjectionsFor: file => new Set(resolvedFor(file, "pure-projection").keys()),
  };
}

function cachedModuleResolutionHost(
  sourceFiles: ReadonlySet<string>
): ts.ModuleResolutionHost {
  const directories = new Map<string, boolean>();
  const files = new Map<string, boolean>();
  const reads = new Map<string, string | undefined>();
  const realPaths = new Map<string, string>();
  return {
    directoryExists: directory => {
      const key = normalizeFile(directory);
      const cached = directories.get(key);
      if (cached !== undefined) return cached;
      const exists = ts.sys.directoryExists?.(directory) ?? false;
      directories.set(key, exists);
      return exists;
    },
    fileExists: file => {
      const key = normalizeFile(file);
      if (sourceFiles.has(key)) return true;
      const cached = files.get(key);
      if (cached !== undefined) return cached;
      const exists = ts.sys.fileExists(file);
      files.set(key, exists);
      return exists;
    },
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getDirectories: ts.sys.getDirectories,
    readFile: file => {
      const key = normalizeFile(file);
      if (reads.has(key)) return reads.get(key);
      const value = ts.sys.readFile(file);
      reads.set(key, value);
      return value;
    },
    realpath: file => {
      const key = normalizeFile(file);
      const cached = realPaths.get(key);
      if (cached) return cached;
      const resolved = ts.sys.realpath?.(file) ?? file;
      realPaths.set(key, resolved);
      return resolved;
    },
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
}

interface CompilerContext {
  cache: ts.ModuleResolutionCache;
  options: ts.CompilerOptions;
}

function sameResolvedSymbol(
  left: ResolvedSymbol | null,
  right: ResolvedSymbol | null
): boolean {
  return left !== null && right !== null &&
    left.file === right.file && left.localName === right.localName;
}

function isInsideModuleDeclaration(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return true;
    if (ts.isSourceFile(current) || isRuntimeFunctionLike(current)) return false;
  }
  return false;
}

function jsxTagUses(expression: ts.PropertyAccessExpression): boolean {
  const parent = expression.parent;
  return (ts.isJsxOpeningElement(parent) ||
      ts.isJsxSelfClosingElement(parent) ||
      ts.isJsxClosingElement(parent)) &&
    parent.tagName === expression;
}

function observableContainerReferencesAreStable(
  sourceFile: ts.SourceFile,
  containerName: string,
  observableMembers: ReadonlySet<string>
): boolean {
  let stable = true;
  visit(sourceFile, node => {
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
  const parent = access.parent;
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

function compilerContextFor(
  importer: string,
  fallbackRoot: string,
  contexts: Map<string, CompilerContext>,
  contextsByImporter: Map<string, CompilerContext>,
  configFilesByDirectory: Map<string, string | null>
): CompilerContext {
  const importerKey = normalizeFile(importer);
  const importerContext = contextsByImporter.get(importerKey);
  if (importerContext) return importerContext;
  const configFile = nearestConfigFile(path.dirname(importer), configFilesByDirectory);
  const key = configFile ? normalizeFile(configFile) : normalizeFile(fallbackRoot);
  const cached = contexts.get(key);
  if (cached) {
    contextsByImporter.set(importerKey, cached);
    return cached;
  }
  const base = configFile ? path.dirname(configFile) : fallbackRoot;
  const options = compilerOptionsFor(base);
  const context = {
    cache: ts.createModuleResolutionCache(
      base,
      file => (ts.sys.useCaseSensitiveFileNames ? file : file.toLowerCase()),
      options
    ),
    options,
  };
  contexts.set(key, context);
  contextsByImporter.set(importerKey, context);
  return context;
}

function nearestConfigFile(
  startDirectory: string,
  cache: Map<string, string | null>
): string | null {
  const directory = normalizeFile(startDirectory);
  if (cache.has(directory)) return cache.get(directory) ?? null;
  const candidate = path.join(directory, "tsconfig.json");
  const parent = path.dirname(directory);
  const configFile = ts.sys.fileExists(candidate)
    ? candidate
    : parent === directory
      ? null
      : nearestConfigFile(parent, cache);
  cache.set(directory, configFile);
  return configFile;
}

function moduleRecord(sourceFile: ts.SourceFile): ModuleRecord {
  const componentDeclarations = new Map<string, ComponentFunction>();
  const contextReaderHooks = new Map<string, string>();
  const deferredCallbackOwners = new Map<string, ReadonlyMap<string, ReadonlySet<number>>>();
  const deferredCallbackHooks = new Map<string, ReadonlySet<number>>();
  const frameworkEventComponents = new Set<string>();
  const hookDeclarations = new Map<string, ComponentFunction>();
  const imports = new Map<string, ImportBinding>();
  const legendValueHooks = new Map<string, string>();
  const legendValueWriters = new Map<string, string>();
  const localExports = new Map<string, string>();
  const observableDeclarations = new Set<string>();
  const observableKeys = new Map<string, ReadonlySet<string>>();
  const observableMemberDeclarations = new Map<string, ReadonlySet<string>>();
  const observableFactoryCalls = new Map<string, string>();
  const observableFactoryDeclarations = new Set<string>();
  const pureProjectionDeclarations = new Set<string>();
  const reexports = new Map<string, ReexportBinding>();
  const starExports: string[] = [];
  const observableFactories = new Set<string>();
  const observableTypes = new Set<string>();
  const legendNamespaces = new Set<string>();
  const reactEffectHooks = new Set<string>();
  const reactContextFactories = new Set<string>();
  const reactContextReaders = new Set<string>();
  const reactContexts = new Set<string>();
  const reactNamespaces = new Set<string>();
  const nativeComponentFactories = new Set<string>();
  const useValueHooks = new Set<string>();
  const deferredMethodsByClass = new Map<string, ReadonlyMap<string, ReadonlySet<number>>>();

  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    const methods = deferredRegistrationMethods(statement);
    if (methods.size > 0) deferredMethodsByClass.set(statement.name.text, methods);
  }

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (statement.moduleSpecifier.text === "react") {
      if (statement.importClause?.name) reactNamespaces.add(statement.importClause.name.text);
      if (bindings && ts.isNamespaceImport(bindings)) {
        reactNamespaces.add(bindings.name.text);
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (REACT_EFFECT_HOOKS.has(importedName)) {
            reactEffectHooks.add(element.name.text);
          }
          if (importedName === "createContext") reactContextFactories.add(element.name.text);
          if (importedName === "use" || importedName === "useContext") {
            reactContextReaders.add(element.name.text);
          }
        }
      }
      continue;
    }
    if (
      (statement.moduleSpecifier.text === "react-native" ||
        statement.moduleSpecifier.text === "react-native-web") &&
      bindings &&
      ts.isNamedImports(bindings)
    ) {
      for (const element of bindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === "requireNativeComponent") {
          nativeComponentFactories.add(element.name.text);
        }
      }
    }
    if (statement.moduleSpecifier.text === "@legendapp/state/react") {
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) === "useValue") {
            useValueHooks.add(element.name.text);
          }
        }
      }
      continue;
    }
    if (statement.moduleSpecifier.text !== "@legendapp/state") continue;
    if (bindings && ts.isNamespaceImport(bindings)) {
      legendNamespaces.add(bindings.name.text);
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (importedName === "observable") {
          observableFactories.add(element.name.text);
        }
        if (importedName === "Observable") {
          observableTypes.add(element.name.text);
        }
      }
    }
  }

  const componentWrappers = collectReactComponentWrappers(sourceFile);

  const observableMemberFactories = localObservableMemberFactories(
    sourceFile,
    observableFactories,
    legendNamespaces
  );

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name) {
        if (/^use[A-Z0-9]/.test(statement.name.text)) {
          hookDeclarations.set(statement.name.text, statement);
          if (hasExport(statement)) localExports.set(statement.name.text, statement.name.text);
          if (hasDefault(statement)) localExports.set("default", statement.name.text);
        }
        const deferredParameters = deferredCallbackParameterIndices(
          statement,
          reactEffectHooks,
          reactNamespaces
        );
        const hookObservable = directLegendValueHookObservable(statement, useValueHooks);
        const writerObservable = directLegendValueWriterObservable(statement);
        const readContext = directReactContextReader(
          statement,
          reactContextReaders,
          reactNamespaces
        );
        if (readContext) contextReaderHooks.set(statement.name.text, readContext);
        if (deferredParameters.size > 0) {
          deferredCallbackHooks.set(statement.name.text, deferredParameters);
        }
        if (hookObservable) legendValueHooks.set(statement.name.text, hookObservable);
        if (writerObservable) legendValueWriters.set(statement.name.text, writerObservable);
        if (isPureProjectionDeclaration(statement, imports)) {
          pureProjectionDeclarations.add(statement.name.text);
        }
        if (
          (deferredParameters.size > 0 || hookObservable || writerObservable || pureProjectionDeclarations.has(statement.name.text)) &&
          hasExport(statement)
        ) {
          localExports.set(statement.name.text, statement.name.text);
        }
        if (readContext && hasExport(statement)) {
          localExports.set(statement.name.text, statement.name.text);
        }
        if (deferredParameters.size > 0 && hasDefault(statement)) {
          localExports.set("default", statement.name.text);
        }
      }
      if (
        statement.name &&
        statement.type &&
        isObservableTypeReference(statement.type, observableTypes)
      ) {
        observableFactoryDeclarations.add(statement.name.text);
        if (hasExport(statement)) localExports.set(statement.name.text, statement.name.text);
      }
      if (statement.name && isSemanticComponentName(statement.name.text)) {
        componentDeclarations.set(statement.name.text, statement);
        if (hasExport(statement)) localExports.set(statement.name.text, statement.name.text);
        if (hasDefault(statement)) localExports.set("default", statement.name.text);
      } else if (!statement.name && hasExport(statement) && hasDefault(statement)) {
        componentDeclarations.set("default", statement);
        localExports.set("default", "default");
      }
      continue;
    }
    if (ts.isClassDeclaration(statement)) {
      if (statement.name && isSemanticComponentName(statement.name.text)) {
        if (hasExport(statement)) localExports.set(statement.name.text, statement.name.text);
        if (hasDefault(statement)) localExports.set("default", statement.name.text);
      } else if (!statement.name && hasExport(statement) && hasDefault(statement)) {
        localExports.set("default", "default");
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer
          ? unwrapTransparentExpression(declaration.initializer)
          : null;
        if (
          ts.isIdentifier(declaration.name) &&
          initializer &&
          isReactContextInitializer(initializer, reactContextFactories, reactNamespaces)
        ) {
          reactContexts.add(declaration.name.text);
          if (hasExport(statement)) localExports.set(declaration.name.text, declaration.name.text);
        }
        if (
          ts.isIdentifier(declaration.name) &&
          /^use[A-Z0-9]/.test(declaration.name.text) &&
          initializer &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ) {
          hookDeclarations.set(declaration.name.text, initializer);
          if (hasExport(statement)) localExports.set(declaration.name.text, declaration.name.text);
        }
        if (
          ts.isIdentifier(declaration.name) &&
          initializer &&
          ts.isNewExpression(initializer) &&
          ts.isIdentifier(initializer.expression)
        ) {
          const methods = deferredMethodsByClass.get(initializer.expression.text);
          if (methods) {
            deferredCallbackOwners.set(declaration.name.text, methods);
            if (hasExport(statement)) localExports.set(declaration.name.text, declaration.name.text);
          }
        }
        if (
          ts.isIdentifier(declaration.name) &&
          initializer &&
          ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression)
        ) {
          if (
            nativeComponentFactories.has(initializer.expression.text) &&
            ts.isVariableDeclarationList(declaration.parent) &&
            (declaration.parent.flags & ts.NodeFlags.Const) !== 0
          ) {
            frameworkEventComponents.add(declaration.name.text);
            if (hasExport(statement)) localExports.set(declaration.name.text, declaration.name.text);
          }
          observableFactoryCalls.set(declaration.name.text, initializer.expression.text);
          const members = observableMemberFactories.get(initializer.expression.text);
          if (
            members &&
            ts.isVariableDeclarationList(declaration.parent) &&
            (declaration.parent.flags & ts.NodeFlags.Const) !== 0
          ) {
            observableMemberDeclarations.set(declaration.name.text, members);
          }
          if (hasExport(statement)) localExports.set(declaration.name.text, declaration.name.text);
        }
        if (
          ts.isIdentifier(declaration.name) &&
          initializer &&
          ts.isObjectLiteralExpression(initializer) &&
          ts.isVariableDeclarationList(declaration.parent) &&
          (declaration.parent.flags & ts.NodeFlags.Const) !== 0
        ) {
          const members = directObservableMembers(
            initializer,
            observableFactories,
            legendNamespaces
          );
          if (members.size > 0) {
            observableMemberDeclarations.set(declaration.name.text, members);
            if (hasExport(statement)) localExports.set(declaration.name.text, declaration.name.text);
          }
        }
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          isObservableInitializer(declaration.initializer, observableFactories, legendNamespaces)
        ) {
          observableDeclarations.add(declaration.name.text);
          const initializer = unwrapTransparentExpression(declaration.initializer);
          const keys = ts.isCallExpression(initializer) && initializer.arguments[0]
            ? exactObjectLiteralKeys(initializer.arguments[0])
            : null;
          if (keys) observableKeys.set(declaration.name.text, keys);
          if (hasExport(statement)) localExports.set(declaration.name.text, declaration.name.text);
        }
        if (
          ts.isIdentifier(declaration.name) &&
          isSemanticComponentName(declaration.name.text) &&
          declaration.initializer &&
          isComponentInitializer(
            declaration.initializer,
            componentWrappers
          )
        ) {
          const component = componentFunction(
            declaration.initializer,
            componentWrappers
          );
          if (!component) continue;
          componentDeclarations.set(declaration.name.text, component);
          if (hasExport(statement)) localExports.set(declaration.name.text, declaration.name.text);
        }
      }
      continue;
    }
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      if (clause.name) {
        imports.set(clause.name.text, {
          importedName: "default",
          moduleSpecifier: statement.moduleSpecifier.text,
        });
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) continue;
          imports.set(element.name.text, {
            importedName: element.propertyName?.text ?? element.name.text,
            moduleSpecifier: statement.moduleSpecifier.text,
          });
        }
      } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        imports.set(clause.namedBindings.name.text, {
          importedName: "*",
          moduleSpecifier: statement.moduleSpecifier.text,
        });
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier)) {
        if (!statement.exportClause) {
          starExports.push(specifier.text);
        } else if (ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            reexports.set(element.name.text, {
              importedName: element.propertyName?.text ?? element.name.text,
              moduleSpecifier: specifier.text,
            });
          }
        }
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          localExports.set(element.name.text, element.propertyName?.text ?? element.name.text);
        }
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      const expression = unwrapTransparentExpression(statement.expression);
      if (ts.isIdentifier(expression)) {
        localExports.set(
          "default",
          staticAssignedComponentName(sourceFile, expression.text, componentDeclarations) ?? expression.text
        );
      } else if (ts.isCallExpression(expression)) {
        const wrapped = reactWrappedComponentName(
          expression,
          componentWrappers
        );
        const component = wrapped
          ? staticAssignedComponentName(sourceFile, wrapped, componentDeclarations)
          : null;
        if (component) {
          localExports.set("default", component);
        }
      } else if (
        ts.isNewExpression(expression) &&
        ts.isIdentifier(expression.expression)
      ) {
        const methods = deferredMethodsByClass.get(expression.expression.text);
        if (methods) {
          deferredCallbackOwners.set("default", methods);
          localExports.set("default", "default");
        }
      }
    }
  }

  for (const [name, observable] of legendValueHooks) {
    if (!observableDeclarations.has(observable)) legendValueHooks.delete(name);
  }
  for (const [name, observable] of legendValueWriters) {
    if (!observableDeclarations.has(observable)) legendValueWriters.delete(name);
  }

  const shadowedImports = new Set<string>();
  visit(sourceFile, node => {
    if (ts.isIdentifier(node) && imports.has(node.text) && isDeclarationName(node)) {
      shadowedImports.add(node.text);
    }
  });

  return {
    componentDeclarations,
    contextReaderHooks,
    deferredCallbackOwners,
    deferredCallbackHooks,
    frameworkEventComponents,
    hookDeclarations,
    imports,
    legendValueHooks,
    legendValueWriters,
    localExports,
    observableDeclarations,
    observableKeys,
    observableMemberDeclarations,
    observableFactoryCalls,
    observableFactoryDeclarations,
    pureProjectionDeclarations,
    reactContexts,
    reexports,
    shadowedImports,
    starExports,
  };
}

function staticAssignedComponentName(
  sourceFile: ts.SourceFile,
  exportedName: string,
  components: ReadonlyMap<string, ComponentFunction>
): string | null {
  let current = exportedName;
  const visited = new Set<string>();
  for (let depth = 0; depth <= 4; depth += 1) {
    if (components.has(current)) return current;
    if (visited.has(current) || topLevelValueDeclarationCount(sourceFile, "Object") > 0) {
      return null;
    }
    visited.add(current);
    const declarations = sourceFile.statements.flatMap(statement =>
      ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.filter(
            declaration => ts.isIdentifier(declaration.name) && declaration.name.text === current
          )
        : []
    );
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
      !ts.isPropertyAccessExpression(initializer.expression) ||
      !ts.isIdentifier(initializer.expression.expression) ||
      initializer.expression.expression.text !== "Object" ||
      initializer.expression.name.text !== "assign" ||
      !initializer.arguments[0] ||
      !ts.isIdentifier(initializer.arguments[0]) ||
      initializer.arguments.length < 2 ||
      !initializer.arguments.slice(1).every(argument =>
        ts.isObjectLiteralExpression(unwrapTransparentExpression(argument))
      )
    ) {
      return null;
    }
    current = initializer.arguments[0].text;
  }
  return null;
}

function topLevelValueDeclarationCount(sourceFile: ts.SourceFile, name: string): number {
  let count = 0;
  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      count += 1;
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (bindingNameContains(declaration.name, name)) count += 1;
      }
      continue;
    }
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause?.name?.text === name) count += 1;
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) count += 1;
    if (bindings && ts.isNamedImports(bindings)) {
      count += bindings.elements.filter(element => element.name.text === name).length;
    }
  }
  return count;
}

function bindingNameContains(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(element =>
    ts.isBindingElement(element) && bindingNameContains(element.name, name)
  );
}

function reactWrappedComponentName(
  call: ts.CallExpression,
  wrappers: ReactComponentWrappers
): string | null {
  const component = call.arguments[0]
    ? unwrapTransparentExpression(call.arguments[0])
    : null;
  return isReactComponentWrapper(call.expression, wrappers) &&
    component &&
    ts.isIdentifier(component)
    ? component.text
    : null;
}

function isReactContextInitializer(
  expression: ts.Expression,
  factories: ReadonlySet<string>,
  namespaces: ReadonlySet<string>
): boolean {
  const initializer = unwrapTransparentExpression(expression);
  if (!ts.isCallExpression(initializer)) return false;
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
  namespaces: ReadonlySet<string>
): string | null {
  if (!declaration.body || declaration.body.statements.length !== 1) return null;
  const statement = declaration.body.statements[0];
  const expression = statement && ts.isReturnStatement(statement) && statement.expression
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

function deferredCallbackParameterIndices(
  declaration: ts.FunctionDeclaration,
  effectHooks: ReadonlySet<string>,
  reactNamespaces: ReadonlySet<string>
): ReadonlySet<number> {
  const deferred = new Set<number>();
  if (!declaration.body) return deferred;
  for (const hook of effectHooks) {
    if (bindingDeclarationCount(declaration, hook) > 0) return deferred;
  }
  for (const namespace of reactNamespaces) {
    if (bindingDeclarationCount(declaration, namespace) > 0) return deferred;
  }
  declaration.parameters.forEach((parameter, index) => {
    if (!ts.isIdentifier(parameter.name)) return;
    const parameterName = parameter.name.text;
    let callbackReference = false;
    let references = 0;
    let safe = true;
    visit(declaration.body!, node => {
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
      const effect = enclosingEffectCall(node, declaration, effectHooks, reactNamespaces);
      if (!effect) {
        safe = false;
        return;
      }
      if (effect.arguments[0] && nodeWithin(node, effect.arguments[0])) {
        callbackReference = true;
      }
    });
    if (safe && references > 0 && callbackReference) deferred.add(index);
  });
  return deferred;
}

function enclosingEffectCall(
  node: ts.Node,
  boundary: ts.FunctionDeclaration,
  effectHooks: ReadonlySet<string>,
  reactNamespaces: ReadonlySet<string>
): ts.CallExpression | null {
  for (let current: ts.Node | undefined = node.parent; current && current !== boundary; current = current.parent) {
    if (!ts.isCallExpression(current) || !current.arguments.some(argument => nodeWithin(node, argument))) {
      continue;
    }
    if (
      (ts.isIdentifier(current.expression) && effectHooks.has(current.expression.text)) ||
      (ts.isPropertyAccessExpression(current.expression) &&
        ts.isIdentifier(current.expression.expression) &&
        reactNamespaces.has(current.expression.expression.text) &&
        REACT_EFFECT_HOOKS.has(current.expression.name.text))
    ) {
      return current;
    }
  }
  return null;
}

function directLegendValueHookObservable(
  declaration: ts.FunctionDeclaration,
  useValueHooks: ReadonlySet<string>
): string | null {
  if (declaration.parameters.length !== 0 || !declaration.body || declaration.body.statements.length !== 1) {
    return null;
  }
  const statement = declaration.body.statements[0];
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return null;
  let expression = unwrapTransparentExpression(statement.expression);
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    expression = unwrapTransparentExpression(expression.left);
  }
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

function directLegendValueWriterObservable(
  declaration: ts.FunctionDeclaration
): string | null {
  const parameter = declaration.parameters[0];
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
  const argument = ts.isCallExpression(expression) && expression.arguments[0]
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
  imports: ReadonlyMap<string, ImportBinding>
): boolean {
  if (
    !declaration.body ||
    declaration.asteriskToken ||
    declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    declaration.body.statements.length !== 1 ||
    declaration.parameters.length === 0 ||
    declaration.parameters.some(parameter =>
      !ts.isIdentifier(parameter.name) || parameter.initializer !== undefined
    )
  ) {
    return false;
  }
  const statement = declaration.body.statements[0];
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return false;
  const parameters = new Set(declaration.parameters.map(parameter => (parameter.name as ts.Identifier).text));
  const referenced = new Set<string>();
  const pure = isPureProjectionExpression(statement.expression, parameters, imports, referenced);
  return pure && [...parameters].every(parameter => referenced.has(parameter));
}

function isPureProjectionExpression(
  expression: ts.Expression,
  parameters: ReadonlySet<string>,
  imports: ReadonlyMap<string, ImportBinding>,
  referenced: Set<string>
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    if (!parameters.has(value.text)) return false;
    referenced.add(value.text);
    return true;
  }
  if (
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.every(element =>
      !ts.isSpreadElement(element) && isPureProjectionExpression(element, parameters, imports, referenced)
    );
  }
  if (
    !ts.isCallExpression(value) ||
    !ts.isIdentifier(value.expression) ||
    parameters.has(value.expression.text)
  ) {
    return false;
  }
  const binding = imports.get(value.expression.text);
  if (!binding || !isKnownPureProjectionImport(binding)) return false;
  return value.arguments.every(argument =>
    !ts.isSpreadElement(argument) && isPureProjectionExpression(argument, parameters, imports, referenced)
  );
}

function isKnownPureProjectionImport(binding: ImportBinding): boolean {
  return (binding.moduleSpecifier === "clsx" && binding.importedName === "clsx") ||
    (binding.moduleSpecifier === "tailwind-merge" && binding.importedName === "twMerge");
}

function deferredRegistrationMethods(
  declaration: ts.ClassDeclaration
): ReadonlyMap<string, ReadonlySet<number>> {
  const methods = new Map<string, ReadonlySet<number>>();
  for (const member of declaration.members) {
    if (!ts.isMethodDeclaration(member) || !member.body || !ts.isIdentifier(member.name)) continue;
    const deferred = new Set<number>();
    member.parameters.forEach((parameter, index) => {
      if (
        ts.isIdentifier(parameter.name) &&
        bindingDeclarationCount(member, parameter.name.text) === 1 &&
        methodStoresCallbackUntilCleanup(declaration, member, parameter.name)
      ) {
        deferred.add(index);
      }
    });
    if (deferred.size > 0) methods.set(member.name.text, deferred);
  }
  return methods;
}

function methodStoresCallbackUntilCleanup(
  declaration: ts.ClassDeclaration,
  method: ts.MethodDeclaration,
  parameter: ts.Identifier
): boolean {
  if (!method.body) return false;
  const returns: ts.ReturnStatement[] = [];
  const references: ts.Identifier[] = [];
  visit(method.body, node => {
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
  if (returns.length !== 1 || !returns[0]!.expression || references.length < 2) return false;
  const cleanup = unwrapTransparentExpression(returns[0]!.expression!);
  if (!ts.isArrowFunction(cleanup) && !ts.isFunctionExpression(cleanup)) return false;

  const stored = references.flatMap(reference => {
    const property = storedCallbackProperty(reference, declaration);
    return property ? [{ property, reference }] : [];
  });
  if (stored.length !== 1 || stored[0]!.reference.getStart() >= returns[0]!.getStart()) return false;
  const property = stored[0]!.property;
  return references.every(reference => {
    if (reference === stored[0]!.reference) return true;
    return nodeWithin(reference, cleanup) &&
      callbackReferenceIsRemoved(reference, cleanup, property);
  });
}

function callbackReferenceIsRemoved(
  reference: ts.Identifier,
  cleanup: ts.ArrowFunction | ts.FunctionExpression,
  property: string
): boolean {
  const comparison = reference.parent;
  if (
    !ts.isBinaryExpression(comparison) ||
    (comparison.left !== reference && comparison.right !== reference) ||
    ![
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(comparison.operatorToken.kind)
  ) {
    return false;
  }
  let filter: ts.CallExpression | null = null;
  for (let current: ts.Node | undefined = comparison.parent; current && current !== cleanup; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "filter" &&
      isThisProperty(current.expression.expression, property) &&
      current.arguments.some(argument => nodeWithin(reference, argument))
    ) {
      filter = current;
      break;
    }
  }
  if (!filter) return false;
  for (let current: ts.Node | undefined = filter.parent; current && current !== cleanup; current = current.parent) {
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
  declaration: ts.ClassDeclaration
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
  const field = declaration.members.find(member =>
    ts.isPropertyDeclaration(member) &&
    ts.isIdentifier(member.name) &&
    member.name.text === property
  );
  if (!field || !ts.isPropertyDeclaration(field)) return null;
  const initializer = field.initializer && unwrapTransparentExpression(field.initializer);
  return (
    (initializer && ts.isArrayLiteralExpression(initializer)) ||
    !!field.type &&
      (ts.isArrayTypeNode(field.type) ||
        (ts.isTypeReferenceNode(field.type) &&
          ts.isIdentifier(field.type.typeName) &&
          field.type.typeName.text === "Array"))
  )
    ? property
    : null;
}

function isThisProperty(expression: ts.Expression, property: string): boolean {
  const value = unwrapTransparentExpression(expression);
  return ts.isPropertyAccessExpression(value) &&
    value.expression.kind === ts.SyntaxKind.ThisKeyword &&
    value.name.text === property;
}

function isObservableTypeReference(
  type: ts.TypeNode,
  observableTypes: ReadonlySet<string>
): boolean {
  return ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    observableTypes.has(type.typeName.text);
}

function isObservableInitializer(
  expression: ts.Expression,
  factories: ReadonlySet<string>,
  namespaces: ReadonlySet<string>
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (!ts.isCallExpression(value)) return false;
  if (ts.isIdentifier(value.expression)) return factories.has(value.expression.text);
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
  namespaces: ReadonlySet<string>
): ReadonlyMap<string, ReadonlySet<string>> {
  const declarations = new Map<string, ComponentFunction | null>();
  const record = (name: string, declaration: ComponentFunction): void => {
    declarations.set(name, declarations.has(name) ? null : declaration);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      record(statement.name.text, statement);
      continue;
    }
    if (
      !ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer
        ? unwrapTransparentExpression(declaration.initializer)
        : null;
      if (
        ts.isIdentifier(declaration.name) &&
        initializer &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
      ) {
        record(declaration.name.text, initializer);
      }
    }
  }

  const proven = new Map<string, ReadonlySet<string>>();
  for (const [name, declaration] of declarations) {
    if (!declaration || bindingIsAssigned(sourceFile, name)) continue;
    if (
      [...factories, ...namespaces].some(binding =>
        bindingDeclarationCount(declaration, binding) > 0
      )
    ) {
      continue;
    }
    const object = exactReturnedObject(declaration);
    if (!object) continue;
    const members = directObservableMembers(object, factories, namespaces);
    if (members.size > 0) proven.set(name, members);
  }
  return proven;
}

const assignedBindingsByFile = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

function bindingIsAssigned(sourceFile: ts.SourceFile, name: string): boolean {
  let assigned = assignedBindingsByFile.get(sourceFile);
  if (assigned) return assigned.has(name);

  const collected = new Set<string>();
  visit(sourceFile, node => {
    if (!ts.isIdentifier(node)) return;
    const parent = node.parent;
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
  if (ts.isArrowFunction(declaration) && !ts.isBlock(declaration.body)) {
    const body = unwrapTransparentExpression(declaration.body);
    return ts.isObjectLiteralExpression(body) ? body : null;
  }
  const body = declaration.body;
  if (!body || !ts.isBlock(body) || body.statements.length !== 1) return null;
  const statement = body.statements[0];
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return null;
  const returned = unwrapTransparentExpression(statement.expression);
  return ts.isObjectLiteralExpression(returned) ? returned : null;
}

function directObservableMembers(
  object: ts.ObjectLiteralExpression,
  factories: ReadonlySet<string>,
  namespaces: ReadonlySet<string>
): ReadonlySet<string> {
  const names = new Set<string>();
  const observableMembers = new Set<string>();
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property) || !property.name) return new Set();
    const name = staticObjectMemberName(property.name);
    if (!name || names.has(name)) return new Set();
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
  if (read.error) return { jsx: ts.JsxEmit.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configFile));
  const options = parsed.options;
  const missingBaseConfig = parsed.errors.some(diagnostic => diagnostic.code === 6053);
  return options.moduleResolution === undefined && missingBaseConfig
    ? { ...options, moduleResolution: ts.ModuleResolutionKind.Bundler }
    : options;
}

function isSemanticComponentName(name: string): boolean {
  const first = name[0];
  return first !== undefined && first === first.toUpperCase();
}

function isComponentInitializer(
  node: ts.Expression,
  wrappers: ReactComponentWrappers
): boolean {
  const initializer = unwrapTransparentExpression(node);
  if (
    ts.isArrowFunction(initializer) ||
    ts.isFunctionExpression(initializer) ||
    ts.isClassExpression(initializer)
  ) {
    return true;
  }
  return (
    ts.isCallExpression(initializer) &&
    isReactComponentWrapper(initializer.expression, wrappers) &&
    initializer.arguments.length >= 1 &&
    !!initializer.arguments[0] &&
    isComponentRenderFunction(initializer.arguments[0])
  );
}

function componentFunction(
  node: ts.Expression,
  wrappers: ReactComponentWrappers
): ts.ArrowFunction | ts.FunctionExpression | null {
  const initializer = unwrapTransparentExpression(node);
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
  if (
    ts.isCallExpression(initializer) &&
    isReactComponentWrapper(initializer.expression, wrappers) &&
    initializer.arguments.length >= 1
  ) {
    const argument = initializer.arguments[0];
    return argument ? componentRenderFunction(argument) : null;
  }
  return null;
}

function isComponentRenderFunction(node: ts.Expression): boolean {
  return componentRenderFunction(node) !== null;
}

function componentRenderFunction(
  node: ts.Expression
): ts.ArrowFunction | ts.FunctionExpression | null {
  const render = unwrapTransparentExpression(node);
  return ts.isArrowFunction(render) || ts.isFunctionExpression(render) ? render : null;
}

function hasExport(node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function hasDefault(node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

function normalizeFile(file: string): string {
  return pathIdentityKey(file);
}
