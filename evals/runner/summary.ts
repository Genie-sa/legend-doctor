import type { ActionScore, Evaluation, HookScore, Tally } from "./model.js";
import { abstentionSummaryLines } from "./abstentions.js";
import { hookCoverageSummaryLines } from "./hook-coverage.js";

function percentage(ratio: number): string {
  return (ratio * 100).toFixed(1);
}

function formatActionLines(byAction: ReadonlyMap<string, ActionScore>): string[] {
  return [...byAction]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([action, score]) => {
      const actionPrecision = score.predicted === 0 ? 1 : score.correct / score.predicted;
      const actionRecall = score.expected === 0 ? 1 : score.correct / score.expected;
      return `${action}: precision ${percentage(actionPrecision)}% (${score.correct}/${score.predicted}), recall ${percentage(actionRecall)}% (${score.correct}/${score.expected})`;
    });
}

/** Research reviews stay visible without counting as optimization predictions. */
export function practiceReviewLines(run: Evaluation): string[] {
  const reviews = [...run.targets]
    .flatMap(([target, result]) =>
      result.report.practices
        .filter((finding) => finding.disposition === "candidate")
        .map(
          (finding) =>
            `Unscored practice review [${target}/${finding.location.file}:${finding.location.line}]: ${finding.action}`,
        ),
    )
    .toSorted();
  return [`Candidate Legend practices: ${reviews.length} (not precision-scored).`, ...reviews];
}

export function summaryLines(
  run: Evaluation,
  hooks: HookScore,
  tallies: { groups: Tally; practices: Tally },
): string[] {
  const { groups, practices } = tallies;
  const precision =
    hooks.actualActionable === 0 ? 1 : hooks.correctActionable / hooks.actualActionable;
  const recall =
    hooks.expectedActionable === 0 ? 1 : hooks.correctActionable / hooks.expectedActionable;
  const hitRate = practices.predictions === 0 ? 1 : practices.matches / practices.predictions;
  return [
    `Inventoried ${run.hooks} hooks across ${run.targets.size} targets.`,
    `Matched ${hooks.matched}/${hooks.labeled} manually labeled hooks.`,
    `Known labeled misses: ${hooks.knownMisses}.`,
    `Matched ${hooks.assumptions.matched}/${hooks.assumptions.labeled} review questions.`,
    ...abstentionSummaryLines(run),
    ...hookCoverageSummaryLines(run),
    `Matched ${groups.matches}/${groups.labels} grouped agent instructions.`,
    `Matched ${practices.matches}/${practices.labels} Legend practice findings.`,
    ...practiceReviewLines(run),
    `Legend practice precision: ${percentage(hitRate)}% (${practices.matches}/${practices.predictions}).`,
    `Actionable precision on labeled hooks: ${percentage(precision)}% (${hooks.correctActionable}/${hooks.actualActionable}).`,
    `Actionable recall on labeled hooks: ${percentage(recall)}% (${hooks.correctActionable}/${hooks.expectedActionable}).`,
    ...formatActionLines(hooks.byAction),
  ];
}
