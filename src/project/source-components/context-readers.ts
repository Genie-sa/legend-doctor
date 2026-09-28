import type { ModuleRecord, ResolvedSymbol, SourceIndexState } from "./model.js";
import { contextProviderElements, providerValueIsMountStable } from "./context-value-stability.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import { isDeclarationName, isNonValueIdentifier } from "../../core/analysis-ast.js";
import { aliasesForSymbol } from "./alias-crawl.js";
import { collectHookImports } from "../../core/imports.js";
import { isInsideModuleDeclaration } from "./declaration-shapes.js";
import { localSymbol } from "./symbol-resolution.js";
import { normalizeFile } from "./module-resolution.js";
import ts from "typescript";

export function contextReaderHooksFor(
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

/** How many JSX `<Context.Provider>` tags the indexed sources render for this context. */
export function contextProviderSitesFor(
  state: SourceIndexState,
  file: string,
  contextName: string,
): number {
  const context = localSymbol(state, {
    file: normalizeFile(file),
    kind: "react-context",
    name: contextName,
  });
  if (!context) {
    return 0;
  }
  let sites = 0;
  for (const [candidateFile, aliases] of aliasesForSymbol(state, context, "react-context")) {
    const sourceFile = state.sourceFiles.get(candidateFile);
    if (sourceFile) {
      sites += contextProviderElements(sourceFile, aliases).length;
    }
  }
  return sites;
}

/**
 * Whether reading this local name, a context or a hook that returns one, can never render its
 * caller: the context is only provided, and read through reader hooks, where the index sees it,
 * and every provider passes a value that keeps its identity after mount.
 */
export function contextReadIsStableFor(
  state: SourceIndexState,
  file: string,
  localName: string,
): boolean {
  const normalized = normalizeFile(file);
  const reader = localSymbol(state, {
    file: normalized,
    kind: "context-reader-hook",
    name: localName,
  });
  const contextName = reader
    ? state.records.get(reader.file)?.contextReaderHooks.get(reader.localName)
    : localName;
  const context =
    contextName === undefined
      ? null
      : localSymbol(state, {
          file: reader?.file ?? normalized,
          kind: "react-context",
          name: contextName,
        });
  return context !== null && contextValueIsStable(state, context);
}

function contextValueIsStable(state: SourceIndexState, context: ResolvedSymbol): boolean {
  const symbolKey = `${context.file}\0${context.localName}`;
  const cached = state.stableContextValues.get(symbolKey);
  if (cached !== undefined) {
    return cached;
  }
  const contextAliases = aliasesForSymbol(state, context, "react-context");
  const stable =
    contextAliasesAreKnown(state, contextAliases) && providersAreMountStable(state, contextAliases);
  state.stableContextValues.set(symbolKey, stable);
  return stable;
}

function providersAreMountStable(
  state: SourceIndexState,
  contextAliases: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  let sites = 0;
  for (const [candidateFile, aliases] of contextAliases) {
    const sourceFile = state.sourceFiles.get(candidateFile);
    const moduleSites = sourceFile ? mountStableProviderCount(sourceFile, aliases) : null;
    if (moduleSites === null) {
      return false;
    }
    sites += moduleSites;
  }
  return sites > 0;
}

/** How many providers the module renders for these aliases, or null when one passes a changing value. */
function mountStableProviderCount(
  sourceFile: ts.SourceFile,
  aliases: ReadonlySet<string>,
): number | null {
  const providers = contextProviderElements(sourceFile, aliases);
  if (providers.length === 0) {
    return 0;
  }
  const imports = collectHookImports(sourceFile);
  return providers.every((element) => providerValueIsMountStable(element, imports))
    ? providers.length
    : null;
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
  const ownerName = owner ? readerHookName(owner) : null;
  return ownerName !== null && record.contextReaderHooks.get(ownerName) === node.text;
}

/** The name a reader hook is declared under, whether a function declaration or a hook constant. */
function readerHookName(owner: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner)) && owner.name) {
    return owner.name.text;
  }
  const { parent } = owner;
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : null;
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
