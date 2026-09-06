import type { ResolvedSymbol, SourceIndexState } from "./model.js";
import {
  isAssignmentOperator,
  isDeclarationName,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import { identifiersNamed } from "../../core/ast.js";
import { isInsideModuleDeclaration } from "./declaration-shapes.js";
import { normalizeFile } from "./module-resolution.js";
import { resolvedFor } from "./symbol-resolution.js";
import ts from "typescript";

type ContainerAliases = ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
const containerAliasesByIndex = new WeakMap<SourceIndexState, ContainerAliases>();

export function observableContainerIsStable(
  state: SourceIndexState,
  symbol: ResolvedSymbol,
): boolean {
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
  const byFile = containerAliases(state).get(`${symbol.file}\0${symbol.localName}`);
  for (const [candidateFile, aliases] of byFile ?? []) {
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

function containerAliases(state: SourceIndexState): ContainerAliases {
  const cached = containerAliasesByIndex.get(state);
  if (cached) {
    return cached;
  }
  const index = indexContainerAliases(state);
  containerAliasesByIndex.set(state, index);
  return index;
}

function indexContainerAliases(state: SourceIndexState): ContainerAliases {
  const index = new Map<string, Map<string, Set<string>>>();
  for (const [file, record] of state.records) {
    for (const localName of record.observableMemberDeclarations.keys()) {
      const symbol = { file, localName };
      addContainerAlias(index, symbol, symbol);
    }
    for (const [localName, symbol] of resolvedFor(state, file, "observable-container")) {
      addContainerAlias(index, symbol, { file, localName });
    }
  }
  return index;
}

function addContainerAlias(
  index: Map<string, Map<string, Set<string>>>,
  symbol: ResolvedSymbol,
  alias: ResolvedSymbol,
): void {
  const key = `${symbol.file}\0${symbol.localName}`;
  const byFile = index.get(key) ?? new Map<string, Set<string>>();
  const names = byFile.get(alias.file) ?? new Set<string>();
  names.add(alias.localName);
  byFile.set(alias.file, names);
  index.set(key, byFile);
}

export function observablePathsFor(state: SourceIndexState, file: string): ReadonlySet<string> {
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

function observableContainerReferencesAreStable(
  sourceFile: ts.SourceFile,
  containerName: string,
  observableMembers: ReadonlySet<string>,
): boolean {
  for (const node of identifiersNamed(sourceFile, containerName)) {
    if (isDeclarationName(node) || isNonValueIdentifier(node) || isInsideModuleDeclaration(node)) {
      continue;
    }
    const member = node.parent;
    if (
      !ts.isPropertyAccessExpression(member) ||
      member.expression !== node ||
      member.questionDotToken
    ) {
      return false;
    }
    if (observableMembers.has(member.name.text) && propertyAccessIsWritten(member)) {
      return false;
    }
  }
  return true;
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
