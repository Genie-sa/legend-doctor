import type {
  LocalSymbolLookup,
  ModuleRecord,
  ResolvedSymbol,
  SourceIndexState,
  SourceSymbolKind,
  SymbolTarget,
  SymbolTrace,
} from "./model.js";
import { normalizeFile, resolveModule } from "./module-resolution.js";
import { isSemanticComponentName } from "./declaration-shapes.js";

const MAX_EXPORT_RESOLUTION_DEPTH = 8;

export function initialSymbolTrace(): SymbolTrace {
  return { depth: 0, visited: new Set() };
}

interface NameLookup {
  has: (name: string) => boolean;
  readonly size: number;
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

export function availableSymbolKinds(
  records: ReadonlyMap<string, ModuleRecord>,
): ReadonlySet<SourceSymbolKind> {
  const available = new Set<SourceSymbolKind>();
  // SAFETY: these are the keys of the exhaustive, locally defined SourceSymbolKind registry.
  const kinds = Object.keys(DECLARED_SYMBOL_LOOKUPS) as SourceSymbolKind[];
  for (const record of records.values()) {
    for (const kind of kinds) {
      if (DECLARED_SYMBOL_LOOKUPS[kind](record).size > 0) {
        available.add(kind);
      }
    }
  }
  // An annotated factory can prove an observable even without any direct observable initializer.
  if (available.has("observable-factory")) {
    available.add("observable");
  }
  return available;
}

function recordDeclaresSymbol(
  record: ModuleRecord,
  kind: SourceSymbolKind,
  localName: string,
): boolean {
  return DECLARED_SYMBOL_LOOKUPS[kind](record).has(localName);
}

export function exportedSymbol(
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

export function resolvedFor(
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
  const symbols = state.availableSymbolKinds.has(kind)
    ? importedSymbols(state, importer, kind)
    : new Map<string, ResolvedSymbol>();
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

export function localSymbol(
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

export function sameResolvedSymbol(
  left: ResolvedSymbol | null,
  right: ResolvedSymbol | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.file === right.file &&
    left.localName === right.localName
  );
}
