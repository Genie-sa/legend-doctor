import type { AnalysisReport, HookFinding } from "./types.js";

export function formatTextReport(report: AnalysisReport, actionableOnly: boolean): string {
  const findings = actionableOnly
    ? agentFindings(report.findings)
    : report.findings;
  const lines = findings.map(formatFinding);
  lines.push(
    `Scanned ${report.files} files: ${report.hooks.states} useState, ${report.hooks.effects} useEffect, ${findings.length} shown.`
  );
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
