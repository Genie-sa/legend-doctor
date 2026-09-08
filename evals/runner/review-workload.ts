import type { AbstentionReason, HookFinding, StateAssumption } from "../../src/core/types.js";
import type { Evaluation } from "./model.js";

export interface ReviewWorkload {
  reviews: number;
  openFindings: number;
  dependentFindings: number;
  inactiveFindings: number;
  unassistedFindings: number;
  questions: Map<string, StateAssumption>;
}

export interface GroupFrontier {
  groups: number;
  converting: number;
  remaining: number;
  nextBlockers: Map<AbstentionReason, number>;
}

function emptyWorkload(): ReviewWorkload {
  return {
    reviews: 0,
    openFindings: 0,
    dependentFindings: 0,
    inactiveFindings: 0,
    unassistedFindings: 0,
    questions: new Map(),
  };
}

/** Question identity is local to a target; a source-version change is separate evidence. */
function addReview(workload: ReviewWorkload, target: string, finding: HookFinding): void {
  if (finding.action !== "review-state" && finding.action !== "review-effect") {
    return;
  }
  workload.reviews += 1;
  if (finding.assumption?.status === "open") {
    const question = finding.assumption;
    workload.questions.set(JSON.stringify([target, question.id, question.fingerprint]), question);
    workload.openFindings += 1;
  } else if (finding.assumption) {
    workload.inactiveFindings += 1;
  } else if (finding.waitsOn?.length) {
    workload.dependentFindings += 1;
  } else {
    workload.unassistedFindings += 1;
  }
}

/** Descriptive workload only: no answers are assumed and no classifier input is changed. */
export interface ReviewWorkloads {
  total: ReviewWorkload;
  byApplication: ReadonlyMap<string, ReviewWorkload>;
}

export function reviewWorkloads(run: Evaluation): ReviewWorkloads {
  const total = emptyWorkload();
  const byApplication = new Map<string, ReviewWorkload>();
  for (const [target, { application, report }] of run.targets) {
    const app = byApplication.get(application) ?? emptyWorkload();
    byApplication.set(application, app);
    for (const finding of report.findings) {
      addReview(total, target, finding);
      addReview(app, target, finding);
    }
  }
  return { total, byApplication };
}

/** Group member outcomes are conditional predictions, never proven migrations or render savings. */
export function groupFrontier(workload: ReviewWorkload): GroupFrontier {
  const frontier: GroupFrontier = {
    groups: 0,
    converting: 0,
    remaining: 0,
    nextBlockers: new Map(),
  };
  for (const question of workload.questions.values()) {
    if (question.members) {
      frontier.groups += 1;
      countMembers(frontier, question.members);
    }
  }
  return frontier;
}

function countMembers(
  frontier: GroupFrontier,
  members: NonNullable<StateAssumption["members"]>,
): void {
  for (const member of members) {
    if (member.outcome === "review-state") {
      frontier.remaining += 1;
      if (member.nextBlocker) {
        const previous = frontier.nextBlockers.get(member.nextBlocker) ?? 0;
        frontier.nextBlockers.set(member.nextBlocker, previous + 1);
      }
    } else {
      frontier.converting += 1;
    }
  }
}

function workloadLine(prefix: string, workload: ReviewWorkload): string {
  return `${prefix}: ${workload.reviews} reviews; ${workload.questions.size} distinct open question versions across ${workload.openFindings} findings; ${workload.dependentFindings} dependent; ${workload.inactiveFindings} answered/stale; ${workload.unassistedFindings} without a question or dependency.`;
}

function frontierLines(workload: ReviewWorkload): string[] {
  const frontier = groupFrontier(workload);
  const blockers = [...frontier.nextBlockers]
    .toSorted(
      ([left, leftCount], [right, rightCount]) =>
        rightCount - leftCount || left.localeCompare(right),
    )
    .map(([reason, count]) => `${reason}: ${count}`);
  return [
    `Conditional group frontier: ${frontier.groups} open groups; ${frontier.converting} members would convert if confirmed; ${frontier.remaining} remain blocked or retained. These are not proven migrations.`,
    `Known next group blockers: ${blockers.join(", ") || "none recorded"}. Not an exhaustive proof ledger.`,
  ];
}

export function reviewWorkloadSummaryLines(run: Evaluation): string[] {
  const { total, byApplication } = reviewWorkloads(run);
  return [
    workloadLine("Review workload", total),
    ...[...byApplication]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([app, workload]) => workloadLine(`App review workload [${app}]`, workload)),
    ...frontierLines(total),
  ];
}
