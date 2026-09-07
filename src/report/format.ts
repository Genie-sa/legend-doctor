import type { HookFinding } from "../core/types.js";

export interface HiddenCounts {
  findings: number;
  practices: number;
}

export interface GateResult {
  failOn: readonly string[];
  matched: number;
}

const REVIEW_ACTIONS: ReadonlySet<HookFinding["action"]> = new Set([
  "review-effect",
  "review-state",
]);

/** A review finding with no assumption has no question to answer, so no answer can turn it into an edit. */
function isUnanswerableReview(finding: HookFinding): boolean {
  return REVIEW_ACTIONS.has(finding.action) && !finding.assumption;
}

/**
 * One entry per edit: keep findings drop, reviews that cannot be converted by any answer drop, and a
 * finding group is represented by its primary member.
 */
export function agentFindings(findings: readonly HookFinding[]): HookFinding[] {
  const seenGroups = new Set<string>();
  return findings.filter((finding) => {
    if (finding.disposition === "keep" || isUnanswerableReview(finding)) {
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
