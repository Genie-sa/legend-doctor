import type {
  HookFinding,
  LegendPracticeFinding,
  ReportedHookFinding,
  ReportedPracticeFinding,
  SourceLocation,
} from "../core/types.js";
import ts from "typescript";

const MODULE_OWNER = "(module)";
const DEFAULT_EXPORT_OWNER = "default";

export function identifyHookFindings(
  findings: readonly HookFinding[],
  sourceFile: ts.SourceFile,
): ReportedHookFinding[] {
  return withIds(
    findings,
    sourceFile,
    (finding) => `${finding.name ?? finding.hook}::${finding.action}`,
  );
}

export function identifyPracticeFindings(
  findings: readonly LegendPracticeFinding[],
  sourceFile: ts.SourceFile,
): ReportedPracticeFinding[] {
  return withIds(
    findings,
    sourceFile,
    (finding) => `${finding.subscription?.observable ?? finding.practice}::${finding.action}`,
  );
}

/**
 * Names each finding by the top-level declaration that holds it, its subject, and its action, so
 * edits elsewhere in the file leave the id alone. Findings that share all three are numbered in
 * source order from the second one.
 */
function withIds<Finding extends { readonly location: SourceLocation }>(
  findings: readonly Finding[],
  sourceFile: ts.SourceFile,
  subject: (finding: Finding) => string,
): (Finding & { id: string })[] {
  const occurrences = new Map<string, number>();
  const ids = new Map<Finding, string>();
  for (const finding of findings.toSorted(compareLocations)) {
    const base = [
      finding.location.file,
      ownerAt(sourceFile, finding.location),
      subject(finding),
    ].join("::");
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    ids.set(finding, occurrence === 1 ? base : `${base}#${occurrence}`);
  }
  return findings.map((finding) => ({ ...finding, id: ids.get(finding)! }));
}

function compareLocations(
  left: { location: SourceLocation },
  right: { location: SourceLocation },
): number {
  return left.location.line - right.location.line || left.location.column - right.location.column;
}

function ownerAt(sourceFile: ts.SourceFile, location: SourceLocation): string {
  const position = sourceFile.getPositionOfLineAndCharacter(location.line - 1, location.column - 1);
  const statement = sourceFile.statements.find(
    (candidate) => candidate.getStart(sourceFile) <= position && position < candidate.end,
  );
  return statement ? statementOwner(statement, position) : MODULE_OWNER;
}

function statementOwner(statement: ts.Statement, position: number): string {
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
    return statement.name?.text ?? DEFAULT_EXPORT_OWNER;
  }
  if (ts.isExportAssignment(statement)) {
    return DEFAULT_EXPORT_OWNER;
  }
  if (ts.isVariableStatement(statement)) {
    const declaration = statement.declarationList.declarations.find(
      (candidate) => candidate.pos <= position && position < candidate.end,
    );
    return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : MODULE_OWNER;
  }
  return MODULE_OWNER;
}
