import type { AbstentionReason, HookFinding } from "../core/types.js";

export interface HiddenCounts {
  /** Hidden reviews that no answer converts, counted by `abstentionReason`. */
  abstentions: Partial<Record<AbstentionReason, number>>;
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

/**
 * A review no answer turns into an edit: it has no question, or it is a co-written member that stays
 * under review once its group's question, asked on a converting member, is confirmed.
 */
export function isUnconvertibleReview(finding: HookFinding): boolean {
  const ownOutcome = finding.assumption?.members?.find(
    (member) => member.name === finding.name,
  )?.outcome;
  return (
    REVIEW_ACTIONS.has(finding.action) && (!finding.assumption || ownOutcome === "review-state")
  );
}

export function abstentionCounts(hidden: readonly HookFinding[]): HiddenCounts["abstentions"] {
  const counts: HiddenCounts["abstentions"] = {};
  for (const { abstentionReason } of hidden.filter((finding) => isUnconvertibleReview(finding))) {
    if (abstentionReason) {
      counts[abstentionReason] = (counts[abstentionReason] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * One entry per edit: keep findings drop, reviews that cannot be converted by any answer drop, and a
 * finding group is represented by its primary member.
 */
export function agentFindings(findings: readonly HookFinding[]): HookFinding[] {
  const seenGroups = new Set<string>();
  return findings.filter((finding) => {
    if (finding.disposition === "keep" || isUnconvertibleReview(finding)) {
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
