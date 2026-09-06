import type { ResolvedSymbol, SourceIndexState } from "./model.js";
import { exportedSymbol, initialSymbolTrace, sameResolvedSymbol } from "./symbol-resolution.js";
import { resolveModule } from "./module-resolution.js";

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

export function aliasesForSymbol(
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
