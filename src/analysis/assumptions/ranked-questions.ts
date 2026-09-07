import type { HookFinding, RankedQuestion } from "../../core/types.js";

interface OpenQuestion {
  readonly finding: HookFinding;
  readonly priority: number;
}

/** Render cost weighted by how often the state is written: the renders an answer would save. */
function priorityOf(finding: HookFinding): number {
  const { assumption } = finding;
  return assumption ? assumption.renderCost * Math.max(1, assumption.updateSites) : 0;
}

function compareQuestions(left: OpenQuestion, right: OpenQuestion): number {
  return (
    right.priority - left.priority ||
    left.finding.location.file.localeCompare(right.finding.location.file) ||
    left.finding.location.line - right.finding.location.line
  );
}

function isAwaitingAnswer(finding: HookFinding): boolean {
  const status = finding.assumption?.status;
  return status === "open" || status === "stale";
}

/** Group questions share one id across their members; the first member in source order carries it. */
function firstPerId(findings: readonly HookFinding[]): HookFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const id = finding.assumption?.id;
    if (id === undefined || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

/** Every question still awaiting an answer, including those whose answer went stale, highest expected render saving first. */
export function rankedQuestions(findings: readonly HookFinding[]): RankedQuestion[] {
  return firstPerId(findings.filter((finding) => isAwaitingAnswer(finding)))
    .map((finding) => ({ finding, priority: priorityOf(finding) }))
    .toSorted(compareQuestions)
    .map(({ finding, priority }, index) => {
      // SAFETY: the filter above keeps only findings whose assumption is present.
      const assumption = finding.assumption!;
      const question: RankedQuestion = {
        file: finding.location.file,
        id: assumption.id,
        ifConfirmed: assumption.ifConfirmed,
        line: finding.location.line,
        name: finding.name,
        priority,
        rank: index + 1,
      };
      if (assumption.members) {
        question.convertingCount = assumption.members.filter(
          (member) => member.outcome !== "review-state",
        ).length;
      }
      return question;
    });
}
