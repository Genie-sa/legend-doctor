import type { ReplayOutcome } from "./replay-scoring.js";
import { acceptedActions } from "./replay-scoring.js";
import { percentage } from "./summary.js";

function locationLabel({ commit, replayCase }: ReplayOutcome): string {
  return `${commit.repository}@${commit.commit.slice(0, 7)} ${replayCase.file}:${replayCase.line}`;
}

function received(outcome: ReplayOutcome): string {
  return outcome.received.length === 0 ? "no finding" : outcome.received.join("; ");
}

function missLine(outcome: ReplayOutcome): string {
  const expected = acceptedActions(outcome.replayCase).join(" or ");
  return `Replay miss [${locationLabel(outcome)}]: expected ${expected}, received ${received(outcome)} (${outcome.replayCase.rationale})`;
}

function nonEnforcedLine(outcome: ReplayOutcome): string {
  return `Non-enforced replay flag [${locationLabel(outcome)}]: ${received(outcome)} (${outcome.replayCase.rationale})`;
}

function recallLine(hits: number, enforced: number): string {
  const ratio = enforced === 0 ? "" : ` (${percentage(hits / enforced)}%)`;
  return `Expert replay recall: ${hits}/${enforced}${ratio}.`;
}

/**
 * Recall counts enforced cases only. Non-enforced cases are listed when the analyzer proposes
 * them, since a proven change there contradicts the manual audit, but they never fail the run.
 */
export function replaySummaryLines(outcomes: readonly ReplayOutcome[]): string[] {
  if (outcomes.length === 0) {
    return ["Expert replay: no replay repository supplied."];
  }
  const enforced = outcomes.filter((outcome) => outcome.replayCase.expected === "enforced");
  const misses = enforced.filter((outcome) => !outcome.flagged);
  const nonEnforced = outcomes.filter((outcome) => outcome.replayCase.expected === "non-enforced");
  const nonEnforcedFlags = nonEnforced.filter((outcome) => outcome.flagged);
  const excluded = outcomes.length - enforced.length - nonEnforced.length;
  return [
    recallLine(enforced.length - misses.length, enforced.length),
    ...misses.map((outcome) => missLine(outcome)),
    `Non-enforced replay cases flagged: ${nonEnforcedFlags.length}/${nonEnforced.length} (not scored).`,
    ...nonEnforcedFlags.map((outcome) => nonEnforcedLine(outcome)),
    `Excluded replay cases: ${excluded}.`,
  ];
}
