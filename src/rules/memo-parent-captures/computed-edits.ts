import type { MemoCaptureScan, StaleMemo } from "./model.js";
import {
  isLegacyUseValueSpecifier,
  isUnusedName,
  legendReactImports,
  namedImportElements,
  retainedImportAnchor,
} from "../../core/use-value-import.js";
import { rangeHasComment, replaceNode, replaceRange } from "../../core/text-edits.js";
import type { TextEdit } from "../../core/types.js";
import { identifiersNamed } from "../../core/ast.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import ts from "typescript";

const COMPUTED = "Computed";
const MEMO = "Memo";

interface MemoImport {
  readonly clause: ts.ImportClause;
  readonly specifier: ts.ImportSpecifier;
}

interface ImportedMemoRewrite {
  readonly computed: string;
  readonly computedImported: boolean;
  readonly memoImport: MemoImport;
  readonly stale: StaleMemo;
}

/** How the rewritten tag names `Computed`: a namespace member, an existing import, or a new specifier. */
export function computedReference(stale: StaleMemo, scan: MemoCaptureScan): string {
  const tag = stale.memo.openingTag;
  if (ts.isPropertyAccessExpression(tag)) {
    return `${tag.expression.getText(scan.sourceFile)}.${COMPUTED}`;
  }
  return importedComputed(scan) ?? COMPUTED;
}

/**
 * Renames the Memo tags to `Computed`. When the rewrite converts every use of the `Memo` import,
 * each finding carries the whole file's migration so the import can swap to `Computed`; otherwise
 * the finding renames its own tags and adds `Computed` beside `Memo`. Null when the tag is not the
 * Legend import, when a new specifier would collide with a local name or need a new declaration,
 * when the import edit would touch a specifier another rule's import edit anchors on, and when a
 * removal would drop a comment.
 */
export function computedTagEdits(
  stale: StaleMemo,
  fileStale: readonly StaleMemo[],
  scan: MemoCaptureScan,
): TextEdit[] | null {
  const tag = stale.memo.openingTag;
  const computed = computedReference(stale, scan);
  if (ts.isPropertyAccessExpression(tag)) {
    return tagEdits([stale], computed, scan);
  }
  const memoImport = ts.isIdentifier(tag) ? memoImportOf(tag, scan) : null;
  const computedImported = importedComputed(scan) !== null;
  if (!memoImport || (!computedImported && !isUnusedName(scan.sourceFile, COMPUTED))) {
    return null;
  }
  return importedTagEdits({ computed, computedImported, memoImport, stale }, fileStale, scan);
}

function importedTagEdits(
  { computed, computedImported, memoImport, stale }: ImportedMemoRewrite,
  fileStale: readonly StaleMemo[],
  scan: MemoCaptureScan,
): TextEdit[] | null {
  const tagText = stale.memo.openingTag.getText(scan.sourceFile);
  const sameTag = fileStale.filter(
    (entry) => entry.memo.openingTag.getText(scan.sourceFile) === tagText,
  );
  if (!convertsEveryUse(memoImport.specifier, sameTag, scan)) {
    const addition = computedImported ? [] : computedInsertion(memoImport, scan);
    return addition ? [...addition, ...tagEdits([stale], computed, scan)] : null;
  }
  const swap = importSwap(memoImport, computedImported, scan);
  return swap ? [swap, ...tagEdits(sameTag, computed, scan)] : null;
}

function tagEdits(
  stale: readonly StaleMemo[],
  computed: string,
  scan: MemoCaptureScan,
): TextEdit[] {
  return stale.flatMap(({ memo }) => [
    replaceNode(scan, memo.openingTag, computed),
    replaceNode(scan, memo.closingTag, computed),
  ]);
}

function memoImportOf(tag: ts.Identifier, scan: MemoCaptureScan): MemoImport | null {
  const binding = lexicalBinding(tag);
  if (binding?.kind !== "import" || binding.importedName !== MEMO) {
    return null;
  }
  for (const clause of legendReactImports(scan.sourceFile)) {
    const specifier = namedImportElements(clause).find(
      (element) => !element.isTypeOnly && element.name.text === tag.text,
    );
    if (specifier) {
      return { clause, specifier };
    }
  }
  return null;
}

function importedComputed(scan: MemoCaptureScan): string | null {
  for (const clause of legendReactImports(scan.sourceFile)) {
    const specifier = namedImportElements(clause).find(
      (element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === COMPUTED,
    );
    if (specifier) {
      return specifier.name.text;
    }
  }
  return null;
}

function convertsEveryUse(
  specifier: ts.ImportSpecifier,
  stale: readonly StaleMemo[],
  scan: MemoCaptureScan,
): boolean {
  const converted = new Set<ts.Node>(
    stale.flatMap(({ memo }) => [memo.openingTag, memo.closingTag]),
  );
  return identifiersNamed(scan.sourceFile, specifier.name.text).every(
    (identifier) =>
      identifier === specifier.name ||
      identifier === specifier.propertyName ||
      converted.has(identifier),
  );
}

/**
 * Inserts `Computed` right after the opening brace. The insertion point precedes every specifier,
 * so it cannot overlap an edit that replaces or removes one.
 */
function computedInsertion({ clause }: MemoImport, scan: MemoCaptureScan): TextEdit[] | null {
  const bindings = clause.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) {
    return null;
  }
  const afterBrace = bindings.getStart(scan.sourceFile) + 1;
  if (!/\s/u.test(scan.sourceFile.text.charAt(afterBrace))) {
    return null;
  }
  return [replaceRange(scan, { end: afterBrace, pos: afterBrace }, ` ${COMPUTED},`)];
}

/** Replaces the `Memo` specifier with `Computed`, or removes it when `Computed` is already imported. */
function importSwap(
  { clause, specifier }: MemoImport,
  computedImported: boolean,
  scan: MemoCaptureScan,
): TextEdit | null {
  if (retainedImportAnchor(legendReactImports(scan.sourceFile)) === specifier) {
    return null;
  }
  if (!computedImported) {
    return replaceNode(scan, specifier, COMPUTED);
  }
  const range = specifierRemovalRange({ clause, specifier }, scan);
  return range && !rangeHasComment(scan.sourceFile, range) ? replaceRange(scan, range, "") : null;
}

/**
 * The specifier with one adjacent separator. Null for a sole specifier and beside a legacy
 * `useValue` specifier, whose own removal range reaches into its neighbors.
 */
function specifierRemovalRange(
  { clause, specifier }: MemoImport,
  scan: MemoCaptureScan,
): ts.TextRange | null {
  const elements = namedImportElements(clause);
  const index = elements.indexOf(specifier);
  const next = elements[index + 1];
  const previous = elements[index - 1];
  if ([next, previous].some((neighbor) => neighbor && isLegacyUseValueSpecifier(neighbor))) {
    return null;
  }
  if (next) {
    return { end: next.getStart(scan.sourceFile), pos: specifier.getStart(scan.sourceFile) };
  }
  return previous ? { end: specifier.getEnd(), pos: previous.getEnd() } : null;
}
