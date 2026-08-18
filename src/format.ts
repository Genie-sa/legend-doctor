import type { AnalysisReport, HookFinding, LegendPracticeFinding } from "./types.js";

export function formatTextReport(report: AnalysisReport): string {
  const findings = report.findings;
  const lines = [...findings.map(formatFinding), ...report.practices.map(formatPracticeFinding)];
  lines.push(
    `Scanned ${report.files} files: ${report.hooks.states} useState, ${report.hooks.effects} useEffect, ${findings.length + report.practices.length} shown.`
  );
  if (findings.some(finding => finding.action === "review-effect")) {
    lines.push(
      "Keep a deliberate React effect by preceding it with `// legend-doctor keep-react-effect`; that suppresses its review-effect finding."
    );
  }
  if (
    findings.some(finding => finding.disposition === "change") ||
    report.practices.some(practice => practice.disposition === "change")
  ) {
    lines.push("Re-run legend-doctor after applying change findings; applied changes can reveal new ones.");
  }
  return lines.join("\n");
}

export function agentFindings(findings: readonly HookFinding[]): HookFinding[] {
  const seenGroups = new Set<string>();
  return findings.filter(finding => {
    if (finding.disposition === "keep") return false;
    if (!finding.group) return true;
    if (!finding.group.primary || seenGroups.has(finding.group.id)) return false;
    seenGroups.add(finding.group.id);
    return true;
  });
}

function formatFinding(finding: HookFinding): string {
  const { file, line, column } = finding.location;
  return `${file}:${line}:${column} [${finding.action}] ${finding.message}`;
}

function formatPracticeFinding(finding: LegendPracticeFinding): string {
  const { file, line, column } = finding.location;
  return `${file}:${line}:${column} [${finding.action}] ${finding.message}`;
}
