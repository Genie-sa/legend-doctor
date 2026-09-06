import type { HookFinding } from "../core/types.js";

export interface HiddenCounts {
  findings: number;
  practices: number;
}

export interface GateResult {
  failOn: readonly string[];
  matched: number;
}

/** One entry per edit: keep findings drop, and a finding group is represented by its primary member. */
export function agentFindings(findings: readonly HookFinding[]): HookFinding[] {
  const seenGroups = new Set<string>();
  return findings.filter((finding) => {
    if (finding.disposition === "keep") {
      return false;
    }
    if (!finding.group) {
      return true;
    }
    if (!finding.group.primary || seenGroups.has(finding.group.id)) {
      return false;
    }
    seenGroups.add(finding.group.id);
    return true;
  });
}
