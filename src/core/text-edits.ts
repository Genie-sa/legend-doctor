import type { LegendPracticeFinding, SourcePosition, TextEdit } from "./types.js";
import ts from "typescript";

/** The parsed file an edit targets, and the report-relative name its edits carry. */
export interface EditSource {
  readonly fileName: string;
  readonly sourceFile: ts.SourceFile;
}

interface OffsetEdit {
  readonly end: number;
  readonly newText: string;
  readonly start: number;
}

function sourcePosition(sourceFile: ts.SourceFile, offset: number): SourcePosition {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);
  return { column: character + 1, line: line + 1 };
}

export function replaceRange(source: EditSource, range: ts.TextRange, newText: string): TextEdit {
  return {
    end: sourcePosition(source.sourceFile, range.end),
    file: source.fileName,
    newText,
    start: sourcePosition(source.sourceFile, range.pos),
  };
}

export function replaceNode(source: EditSource, node: ts.Node, newText: string): TextEdit {
  return replaceRange(
    source,
    { end: node.getEnd(), pos: node.getStart(source.sourceFile) },
    newText,
  );
}

/** Whether the source between two offsets holds a comment an edit of that range would drop. */
export function rangeHasComment(sourceFile: ts.SourceFile, range: ts.TextRange): boolean {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    sourceFile.languageVariant,
    sourceFile.text,
    undefined,
    range.pos,
    range.end - range.pos,
  );
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      return true;
    }
  }
  return false;
}

/** Replaces `outer` with the source of its descendant `inner`, or null when that would drop a comment. */
export function replaceWithDescendant(
  source: EditSource,
  outer: ts.Node,
  inner: ts.Node,
): TextEdit | null {
  const { sourceFile } = source;
  const innerStart = inner.getStart(sourceFile);
  if (
    rangeHasComment(sourceFile, { end: innerStart, pos: outer.getStart(sourceFile) }) ||
    rangeHasComment(sourceFile, { end: outer.getEnd(), pos: inner.getEnd() })
  ) {
    return null;
  }
  return replaceNode(source, outer, inner.getText(sourceFile));
}

/** Replaces `node` wholesale, or null when that would drop a comment inside it. */
export function replaceCommentFreeNode(
  source: EditSource,
  node: ts.Node,
  newText: string,
): TextEdit | null {
  const range = { end: node.getEnd(), pos: node.getStart(source.sourceFile) };
  return rangeHasComment(source.sourceFile, range) ? null : replaceRange(source, range, newText);
}

export function withEdits(
  finding: LegendPracticeFinding,
  edits: readonly TextEdit[] | null,
): LegendPracticeFinding {
  return edits && edits.length > 0 ? { ...finding, edits } : finding;
}

function editKey(edit: TextEdit): string {
  return JSON.stringify([edit.file, edit.start, edit.end, edit.newText]);
}

function toOffsetEdit(sourceFile: ts.SourceFile, edit: TextEdit): OffsetEdit {
  return {
    end: sourceFile.getPositionOfLineAndCharacter(edit.end.line - 1, edit.end.column - 1),
    newText: edit.newText,
    start: sourceFile.getPositionOfLineAndCharacter(edit.start.line - 1, edit.start.column - 1),
  };
}

/** Two edits conflict when their ranges overlap, or when an insertion's order against a neighbor is ambiguous. */
function conflicts(earlier: OffsetEdit, later: OffsetEdit): boolean {
  if (earlier.end !== later.start) {
    return earlier.end > later.start;
  }
  return earlier.start === earlier.end || later.start === later.end;
}

/**
 * Applies one file's edits to the source they were computed from. Identical copies apply once; any
 * other overlap throws, because no application order would be well defined.
 */
export function applyTextEdits(sourceFile: ts.SourceFile, edits: readonly TextEdit[]): string {
  const unique = new Map(edits.map((edit) => [editKey(edit), edit]));
  const ordered = [...unique.values()]
    .map((edit) => toOffsetEdit(sourceFile, edit))
    .toSorted((left, right) => left.start - right.start || left.end - right.end);
  let { text } = sourceFile;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const edit = ordered[index]!;
    const previous = ordered[index - 1];
    if (previous && conflicts(previous, edit)) {
      throw new Error(`Overlapping edits at offsets ${previous.start} and ${edit.start}`);
    }
    text = text.slice(0, edit.start) + edit.newText + text.slice(edit.end);
  }
  return text;
}
