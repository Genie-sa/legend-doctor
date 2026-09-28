import type { InstalledLegendState, TextEdit } from "./types.js";
import type { EditSource } from "./text-edits.js";
import { identifiersNamed } from "./ast.js";
import { isDeclarationName } from "./analysis-ast.js";
import { replaceNode } from "./text-edits.js";
import ts from "typescript";

const LEGEND_REACT_MODULE = "@legendapp/state/react";
const USE_VALUE = "useValue";
const USE_SELECTOR = "useSelector";
const LEGACY_EXPORTS: ReadonlySet<string> = new Set(["use$", USE_SELECTOR]);
/** One function in Legend State 3; the order is the preference for a new subscription's callee. */
const SUBSCRIPTION_EXPORTS = [USE_VALUE, "use$", USE_SELECTOR] as const;

/** How edited code calls `useValue`, and the import edits that make that callee resolve. */
export interface UseValueReference {
  readonly callee: string;
  readonly edits: readonly TextEdit[];
}

export function legendReactImports(sourceFile: ts.SourceFile): ts.ImportClause[] {
  return sourceFile.statements.flatMap((statement) =>
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === LEGEND_REACT_MODULE &&
    statement.importClause &&
    !statement.importClause.isTypeOnly
      ? [statement.importClause]
      : [],
  );
}

export function namedImportElements(clause: ts.ImportClause): readonly ts.ImportSpecifier[] {
  const bindings = clause.namedBindings;
  return bindings && ts.isNamedImports(bindings) ? bindings.elements : [];
}

function importedName(specifier: ts.ImportSpecifier): string {
  return (specifier.propertyName ?? specifier.name).text;
}

export function isLegacyUseValueSpecifier(specifier: ts.ImportSpecifier): boolean {
  return !specifier.isTypeOnly && LEGACY_EXPORTS.has(importedName(specifier));
}

/** The name is bound only by imports, so a call through it reaches the imported value everywhere. */
function isBoundOnlyByImport(sourceFile: ts.SourceFile, name: string): boolean {
  return identifiersNamed(sourceFile, name).every((identifier) => !isDeclarationName(identifier));
}

/** No identifier in the file spells the name, so adding it as an import cannot collide or shadow. */
export function isUnusedName(sourceFile: ts.SourceFile, name: string): boolean {
  return identifiersNamed(sourceFile, name).length === 0;
}

interface ImportedCallee {
  readonly binding: string;
  readonly callee: string;
}

function clauseUseValue(clause: ts.ImportClause): ImportedCallee | null {
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    return { binding: bindings.name.text, callee: `${bindings.name.text}.${USE_VALUE}` };
  }
  const specifier = namedImportElements(clause).find(
    (element) => !element.isTypeOnly && importedName(element) === USE_VALUE,
  );
  return specifier ? { binding: specifier.name.text, callee: specifier.name.text } : null;
}

function importedUseValue(
  sourceFile: ts.SourceFile,
  clauses: readonly ts.ImportClause[],
): string | null {
  for (const clause of clauses) {
    const imported = clauseUseValue(clause);
    if (imported && isBoundOnlyByImport(sourceFile, imported.binding)) {
      return imported.callee;
    }
  }
  return null;
}

/**
 * The last named specifier from `@legendapp/state/react` that a legacy-hook migration keeps. Adding
 * `useValue` after it gives every edit in the file the same import change, whichever findings apply.
 */
function retainedImportAnchor(clauses: readonly ts.ImportClause[]): ts.ImportSpecifier | null {
  for (const clause of clauses) {
    const anchor = namedImportElements(clause).findLast(
      (element) => !isLegacyUseValueSpecifier(element),
    );
    if (anchor) {
      return anchor;
    }
  }
  return null;
}

/**
 * Resolves a `useValue` callee: an existing value import, the Legend React namespace, or a new
 * specifier beside a retained one. Null when only a new import declaration would do, since its
 * placement and quoting are project style rather than syntax.
 */
export function useValueReference(source: EditSource): UseValueReference | null {
  const clauses = legendReactImports(source.sourceFile);
  const existing = importedUseValue(source.sourceFile, clauses);
  if (existing) {
    return { callee: existing, edits: [] };
  }
  const anchor = retainedImportAnchor(clauses);
  if (!anchor || !isUnusedName(source.sourceFile, USE_VALUE)) {
    return null;
  }
  return {
    callee: USE_VALUE,
    edits: [replaceNode(source, anchor, `${anchor.getText(source.sourceFile)}, ${USE_VALUE}`)],
  };
}

/** How a new subscription calls its hook, and whether that callee is a legacy binding. */
export interface SubscriptionHookReference extends UseValueReference {
  readonly legacy: boolean;
}

/** The export a new subscription names when the file imports none: `useValue`, unless the package lacks it. */
function exportedSubscriptionHook(legendState: InstalledLegendState | null): string {
  return legendState?.useValueExport === "missing" ? USE_SELECTOR : USE_VALUE;
}

function namedSubscriptionHook(
  sourceFile: ts.SourceFile,
  clauses: readonly ts.ImportClause[],
): SubscriptionHookReference | null {
  for (const exported of SUBSCRIPTION_EXPORTS) {
    for (const clause of clauses) {
      const specifier = namedImportElements(clause).find(
        (element) => !element.isTypeOnly && importedName(element) === exported,
      );
      if (specifier && isBoundOnlyByImport(sourceFile, specifier.name.text)) {
        return { callee: specifier.name.text, edits: [], legacy: exported !== USE_VALUE };
      }
    }
  }
  return null;
}

function namespaceSubscriptionHook(
  sourceFile: ts.SourceFile,
  clauses: readonly ts.ImportClause[],
  legendState: InstalledLegendState | null,
): SubscriptionHookReference | null {
  const namespace = clauses
    .map((clause) => clause.namedBindings)
    .find(
      (bindings): bindings is ts.NamespaceImport =>
        bindings !== undefined &&
        ts.isNamespaceImport(bindings) &&
        isBoundOnlyByImport(sourceFile, bindings.name.text),
    );
  const exported = exportedSubscriptionHook(legendState);
  return namespace
    ? { callee: `${namespace.name.text}.${exported}`, edits: [], legacy: exported !== USE_VALUE }
    : null;
}

function importedSubscriptionHook(
  sourceFile: ts.SourceFile,
  clauses: readonly ts.ImportClause[],
  legendState: InstalledLegendState | null,
): SubscriptionHookReference | null {
  return (
    namedSubscriptionHook(sourceFile, clauses) ??
    namespaceSubscriptionHook(sourceFile, clauses, legendState)
  );
}

/**
 * The callee an instruction for a new subscription names: the subscription hook the file already
 * imports from `@legendapp/state/react`, else the export the resolved package provides.
 */
export function subscriptionHookCallee(
  sourceFile: ts.SourceFile,
  legendState: InstalledLegendState | null,
): string {
  return (
    importedSubscriptionHook(sourceFile, legendReactImports(sourceFile), legendState)?.callee ??
    exportedSubscriptionHook(legendState)
  );
}

/**
 * Resolves the callee of {@link subscriptionHookCallee} for an edit, adding a specifier beside a
 * retained one when the file imports no subscription hook. Null when only a new import declaration
 * would do.
 */
export function subscriptionHookReference(
  source: EditSource,
  legendState: InstalledLegendState | null,
): SubscriptionHookReference | null {
  const clauses = legendReactImports(source.sourceFile);
  const imported = importedSubscriptionHook(source.sourceFile, clauses, legendState);
  if (imported) {
    return imported;
  }
  const exported = exportedSubscriptionHook(legendState);
  const anchor = retainedImportAnchor(clauses);
  if (!anchor || !isUnusedName(source.sourceFile, exported)) {
    return null;
  }
  return {
    callee: exported,
    edits: [replaceNode(source, anchor, `${anchor.getText(source.sourceFile)}, ${exported}`)],
    legacy: exported !== USE_VALUE,
  };
}
