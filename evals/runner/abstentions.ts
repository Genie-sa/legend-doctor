import type { AbstentionReason, HookFinding } from "../../src/core/types.js";
import type { Evaluation } from "./model.js";

export interface AbstentionCounts {
  byApplication: ReadonlyMap<string, ReadonlyMap<AbstentionReason, number>>;
  byReason: ReadonlyMap<AbstentionReason, number>;
  total: number;
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function increment(counts: Map<AbstentionReason, number>, reason: AbstentionReason): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
}

function sortCounts(counts: ReadonlyMap<AbstentionReason, number>): Map<AbstentionReason, number> {
  return new Map(
    [...counts].toSorted(([leftReason, leftCount], [rightReason, rightCount]) => {
      const countOrder = rightCount - leftCount;
      return countOrder === 0 ? compareText(leftReason, rightReason) : countOrder;
    }),
  );
}

function structuredReviewReason(finding: HookFinding): AbstentionReason | undefined {
  if (finding.action !== "review-state" && finding.action !== "review-effect") {
    return undefined;
  }
  const reason: AbstentionReason | undefined = finding.abstentionReason;
  if (reason === undefined) {
    throw new Error(
      `Review finding at ${finding.location.file}:${finding.location.line} has no abstention reason.`,
    );
  }
  return reason;
}

function countFindings(
  byReason: Map<AbstentionReason, number>,
  byRepository: Map<AbstentionReason, number>,
  findings: readonly HookFinding[],
): number {
  let total = 0;
  for (const finding of findings) {
    const reason = structuredReviewReason(finding);
    if (reason === undefined) {
      continue;
    }
    increment(byReason, reason);
    increment(byRepository, reason);
    total += 1;
  }
  return total;
}

export function countAbstentions(run: Evaluation): AbstentionCounts {
  const byReason = new Map<AbstentionReason, number>();
  const applicationCounts = new Map<string, Map<AbstentionReason, number>>();
  let total = 0;

  for (const { application, report } of run.targets.values()) {
    const counts = applicationCounts.get(application) ?? new Map<AbstentionReason, number>();
    applicationCounts.set(application, counts);
    total += countFindings(byReason, counts, report.findings);
  }

  return {
    byApplication: new Map(
      [...applicationCounts]
        .toSorted(([left], [right]) => compareText(left, right))
        .map(([application, counts]) => [application, sortCounts(counts)]),
    ),
    byReason: sortCounts(byReason),
    total,
  };
}

function totalCounts(counts: ReadonlyMap<AbstentionReason, number>): number {
  let total = 0;
  for (const count of counts.values()) {
    total += count;
  }
  return total;
}

function formatCounts(counts: ReadonlyMap<AbstentionReason, number>): string {
  return [...counts].map(([reason, count]) => `${reason}: ${count}`).join(", ");
}

function formatHistogram(prefix: string, counts: ReadonlyMap<AbstentionReason, number>): string {
  const total = totalCounts(counts);
  return total === 0 ? `${prefix}: 0.` : `${prefix}: ${total} (${formatCounts(counts)}).`;
}

export function abstentionSummaryLines(run: Evaluation): string[] {
  const counts = countAbstentions(run);
  return [
    formatHistogram("Abstentions", counts.byReason),
    ...[...counts.byApplication].map(([application, applicationReasonCounts]) =>
      formatHistogram(`App abstentions [${application}]`, applicationReasonCounts),
    ),
  ];
}
