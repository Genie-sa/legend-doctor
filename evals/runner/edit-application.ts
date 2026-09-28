import type { Evaluation, TargetResult } from "./model.js";
import type {
  LegendPracticeAction,
  LegendPracticeFinding,
  TextEdit,
} from "../../src/core/types.js";
import { readFile, stat } from "node:fs/promises";
import { EDITABLE_PRACTICE_ACTIONS } from "../../src/core/types.js";
import { applyTextEdits } from "../../src/core/text-edits.js";
import path from "node:path";
import { scriptKindForFile } from "../../src/core/ast.js";
import ts from "typescript";

const EDITABLE_ACTIONS: ReadonlySet<LegendPracticeAction> = new Set(EDITABLE_PRACTICE_ACTIONS);

interface ActionTally {
  edited: number;
  total: number;
}

interface ApplicationTally {
  actions: Map<LegendPracticeAction, ActionTally>;
  files: number;
}

interface TargetCheck {
  readonly failures: string[];
  readonly tally: ApplicationTally;
  readonly targetId: string;
}

function syntaxErrors(fileName: string, text: string): string[] {
  const { diagnostics = [] } = ts.transpileModule(text, {
    compilerOptions: { jsx: ts.JsxEmit.Preserve },
    fileName,
    reportDiagnostics: true,
  });
  return diagnostics.map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
  );
}

/** Why the edits fail to produce a parseable file, or null when they apply cleanly. */
function applicationFailure(sourceFile: ts.SourceFile, edits: readonly TextEdit[]): string | null {
  const foreign = edits.find((edit) => edit.file !== sourceFile.fileName);
  if (foreign) {
    return `edit targets ${foreign.file}`;
  }
  try {
    return syntaxErrors(sourceFile.fileName, applyTextEdits(sourceFile, edits))[0] ?? null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function sourceRoot(root: string): Promise<string> {
  const stats = await stat(root);
  return stats.isFile() ? path.dirname(root) : root;
}

function countActions(tally: ApplicationTally, practices: readonly LegendPracticeFinding[]): void {
  for (const finding of practices) {
    const counts = tally.actions.get(finding.action) ?? { edited: 0, total: 0 };
    counts.total += 1;
    counts.edited += finding.edits ? 1 : 0;
    tally.actions.set(finding.action, counts);
  }
}

function checkFile(
  check: TargetCheck,
  sourceFile: ts.SourceFile,
  findings: readonly LegendPracticeFinding[],
): void {
  const where = `${check.targetId}/${sourceFile.fileName}`;
  for (const finding of findings) {
    const failure = EDITABLE_ACTIONS.has(finding.action)
      ? applicationFailure(sourceFile, finding.edits ?? [])
      : "the action is not listed in EDITABLE_PRACTICE_ACTIONS";
    if (failure) {
      check.failures.push(`${where}:${finding.location.line} ${finding.action} edits: ${failure}`);
    }
  }
  const joint = applicationFailure(
    sourceFile,
    findings.flatMap((finding) => finding.edits ?? []),
  );
  if (joint) {
    check.failures.push(`${where} combined edits: ${joint}`);
  }
  check.tally.files += 1;
}

function findingsWithEditsByFile(
  practices: readonly LegendPracticeFinding[],
): Map<string, LegendPracticeFinding[]> {
  const byFile = new Map<string, LegendPracticeFinding[]>();
  for (const finding of practices.filter((candidate) => candidate.edits)) {
    byFile.set(finding.location.file, [...(byFile.get(finding.location.file) ?? []), finding]);
  }
  return byFile;
}

async function checkTarget(check: TargetCheck, result: TargetResult): Promise<void> {
  const { practices } = result.report;
  countActions(check.tally, practices);
  const root = await sourceRoot(result.root);
  const files = [...findingsWithEditsByFile(practices)];
  const texts = await Promise.all(files.map(([file]) => readFile(path.join(root, file), "utf8")));
  for (const [index, [file, findings]] of files.entries()) {
    const kind = scriptKindForFile(file);
    const sourceFile = ts.createSourceFile(file, texts[index]!, ts.ScriptTarget.Latest, true, kind);
    checkFile(check, sourceFile, findings);
  }
}

function tallyLine(application: string, tally: ApplicationTally): string {
  const actions = [...tally.actions]
    .filter(([action]) => EDITABLE_ACTIONS.has(action))
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([action, counts]) => `${action} ${counts.edited}/${counts.total}`);
  const detail = actions.length > 0 ? actions.join(", ") : "no editable findings";
  return `Verified edits [${application}]: ${detail}; ${tally.files} edited files checked.`;
}

/**
 * Applies every emitted practice edit to an in-memory copy of its file, per finding and per file,
 * and requires the result to parse. Typechecking needs the application's dependencies, which the
 * pinned corpus never installs, so it stays in the unit suite.
 */
export async function editApplicationLines(run: Evaluation): Promise<string[]> {
  const tallies = new Map<string, ApplicationTally>();
  const checks = [...run.targets].map(([targetId, result]) => {
    const tally = tallies.get(result.application) ?? { actions: new Map(), files: 0 };
    tallies.set(result.application, tally);
    const check: TargetCheck = { failures: [], tally, targetId };
    return checkTarget(check, result).then(() => check.failures);
  });
  const failures = await Promise.all(checks);
  run.failures.push(...failures.flat());
  return [...tallies]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([application, tally]) => tallyLine(application, tally));
}
