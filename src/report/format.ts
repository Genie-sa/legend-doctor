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

function staysUnderReview(finding: HookFinding): boolean {
  const ownOutcome = finding.assumption?.members?.find(
    (member) => member.name === finding.name,
  )?.outcome;
  return ownOutcome === "review-state";
}

/**
 * Reviews no answer turns into an edit: those with no question, and co-written members that stay under
 * review once their group is confirmed, when a converting member carries the same question.
 */
export function unconvertibleReviews(findings: readonly HookFinding[]): Set<HookFinding> {
  const reviews = findings.filter((finding) => REVIEW_ACTIONS.has(finding.action));
  const carried = new Set(
    reviews.filter((review) => !staysUnderReview(review)).map((review) => review.assumption?.id),
  );
  return new Set(
    reviews.filter(
      (review) =>
        !review.assumption || (staysUnderReview(review) && carried.has(review.assumption.id)),
    ),
  );
}

export function abstentionCounts(reviews: readonly HookFinding[]): HiddenCounts["abstentions"] {
  const counts: HiddenCounts["abstentions"] = {};
  for (const { abstentionReason } of reviews) {
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
export function agentFindings<Finding extends HookFinding>(
  findings: readonly Finding[],
): Finding[] {
  const seenGroups = new Set<string>();
  const unconvertible = unconvertibleReviews(findings);
  return findings.filter((finding) => {
    if (finding.disposition === "keep" || unconvertible.has(finding)) {
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
