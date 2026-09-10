import type { SourceIndexState, SourceSymbolKind } from "./model.js";
import { normalizeFile, sourceModuleResolution } from "./module-resolution.js";
import ts from "typescript";

export interface UnavailableSourceEdge {
  readonly importer: string;
  readonly specifier: string;
  readonly reason: "module-unresolved" | "declaration-only" | "source-not-indexed";
  readonly resolvedFile: string | null;
}

export interface SourceContextCoverage {
  readonly file: string;
  /** Requests made for this file, not attribution of a missed recommendation to each edge. */
  readonly requestedProofs: readonly SourceSymbolKind[];
  readonly unavailable: readonly UnavailableSourceEdge[];
}

/** Inventory independently of successful symbol proofs, including missing-only factory programs. */
export function sourceContextFor(state: SourceIndexState, file: string): SourceContextCoverage {
  const normalized = normalizeFile(file);
  return {
    file: normalized,
    requestedProofs: requestedProofsFor(state, normalized),
    unavailable: unavailableSources(state, normalized).toSorted(
      (left, right) =>
        left.importer.localeCompare(right.importer) ||
        left.specifier.localeCompare(right.specifier),
    ),
  };
}

function requestedProofsFor(state: SourceIndexState, file: string): SourceSymbolKind[] {
  const requested = new Set(
    [...state.resolvedByKind].filter(([, requests]) => requests.has(file)).map(([kind]) => kind),
  );
  if ([...state.resolvedHooks.keys()].some((key) => key.startsWith(`${file}\0`))) {
    requested.add("hook");
  }
  return [...requested].toSorted();
}

function unavailableSources(state: SourceIndexState, file: string): UnavailableSourceEdge[] {
  const unavailable: UnavailableSourceEdge[] = [];
  const visited = new Set<string>();
  const pending = [file];
  for (const importer of pending) {
    if (!visited.has(importer)) {
      visited.add(importer);
      collectSourceEdges(state, importer, { pending, unavailable });
    }
  }
  return unavailable;
}

function collectSourceEdges(
  state: SourceIndexState,
  importer: string,
  { pending, unavailable }: { pending: string[]; unavailable: UnavailableSourceEdge[] },
): void {
  for (const specifier of runtimeModuleSpecifiers(state.sourceFiles.get(importer))) {
    const resolution = sourceModuleResolution(state, importer, specifier);
    const resolved = resolution.resolvedFile ? normalizeFile(resolution.resolvedFile) : null;
    const reason =
      resolution.reason ?? (resolved && state.records.has(resolved) ? null : "source-not-indexed");
    if (reason) {
      unavailable.push({
        importer: state.sourceFiles.get(importer)?.fileName ?? importer,
        specifier,
        reason,
        resolvedFile: resolution.resolvedFile,
      });
    } else if (resolved) {
      pending.push(resolved);
    }
  }
}

function runtimeModuleSpecifiers(source: ts.SourceFile | undefined): ReadonlySet<string> {
  const specifiers = new Set<string>();
  for (const statement of source?.statements ?? []) {
    if (
      transportsRuntimeSymbols(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.add(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

function transportsRuntimeSymbols(
  statement: ts.Statement,
): statement is ts.ImportDeclaration | ts.ExportDeclaration {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    // Side-effect imports do not transport symbols into the current source proof consumers.
    return Boolean(clause && !clause.isTypeOnly && hasRuntimeImport(clause));
  }
  return (
    ts.isExportDeclaration(statement) &&
    !statement.isTypeOnly &&
    (!statement.exportClause ||
      !ts.isNamedExports(statement.exportClause) ||
      statement.exportClause.elements.some((element) => !element.isTypeOnly))
  );
}

function hasRuntimeImport(clause: ts.ImportClause): boolean {
  return Boolean(
    clause.name ||
    (clause.namedBindings &&
      (ts.isNamespaceImport(clause.namedBindings) ||
        clause.namedBindings.elements.some((element) => !element.isTypeOnly))),
  );
}
