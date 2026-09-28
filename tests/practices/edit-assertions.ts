import type { LegendPracticeAction, LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import { applyTextEdits } from "../../src/core/text-edits.js";
import assert from "node:assert/strict";
import ts from "typescript";
import { typecheckDiagnostics } from "./typecheck.js";

const FILE_NAME = "fixture.tsx";

export function practiceFindings(
  sourceText: string,
  action: LegendPracticeAction,
): LegendPracticeFinding[] {
  return analyzeLegendPractices({ fileName: FILE_NAME, sourceText }).filter(
    (finding) => finding.action === action,
  );
}

export function applyFindingEdits(
  sourceText: string,
  findings: readonly LegendPracticeFinding[],
): string {
  const sourceFile = ts.createSourceFile(
    FILE_NAME,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  return applyTextEdits(
    sourceFile,
    findings.flatMap((finding) => finding.edits ?? []),
  );
}

/**
 * The fixture typechecks, its findings' edits together produce `expected` exactly, and that output
 * parses and typechecks. Each finding's edits must also stand alone, since agents apply a subset.
 */
export function assertVerifiedEdits(
  sourceText: string,
  expected: string,
  findings: readonly LegendPracticeFinding[],
): void {
  assert.deepEqual(typecheckDiagnostics(sourceText), []);
  const output = applyFindingEdits(sourceText, findings);
  assert.equal(output, expected);
  assert.deepEqual(typecheckDiagnostics(output), []);
  for (const finding of findings.filter((candidate) => candidate.edits)) {
    assert.deepEqual(typecheckDiagnostics(applyFindingEdits(sourceText, [finding])), []);
  }
}
