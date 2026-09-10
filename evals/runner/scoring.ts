import type {
  ActionScore,
  Evaluation,
  HookPair,
  HookScore,
  SourceLocation,
  Tally,
} from "./model.js";
import type { GoldHookCase, GoldPracticeCase, GoldStateGroupCase } from "../corpus/contracts.js";
import { goldCases } from "../corpus/hook-cases.js";
import { goldPracticeCases } from "../corpus/practice-cases.js";
import { goldStateGroups } from "../corpus/state-groups.js";
import path from "node:path";

function isActionable(action: string): boolean {
  return !["keep-effect", "keep-state", "review-effect", "review-state"].includes(action);
}

function isAt(location: SourceLocation, gold: SourceLocation): boolean {
  return location.file === path.normalize(gold.file) && location.line === gold.line;
}

function recordActionScore(
  byAction: Map<string, ActionScore>,
  action: string,
  pair: HookPair,
): void {
  if (!isActionable(action)) {
    return;
  }
  const previous = byAction.get(action) ?? { correct: 0, expected: 0, predicted: 0 };
  const expected = pair.gold.action === action ? 1 : 0;
  const predicted = pair.finding.action === action ? 1 : 0;
  byAction.set(action, {
    correct: previous.correct + expected * predicted,
    expected: previous.expected + expected,
    predicted: previous.predicted + predicted,
  });
}

function countActions(score: HookScore, pair: HookPair): void {
  const actionable = isActionable(pair.finding.action);
  const agrees = pair.finding.action === pair.gold.action;
  score.actualActionable += actionable ? 1 : 0;
  score.correctActionable += actionable && agrees ? 1 : 0;
  score.expectedActionable += isActionable(pair.gold.action) ? 1 : 0;
  for (const action of new Set([pair.gold.action, pair.finding.action])) {
    recordActionScore(score.byAction, action, pair);
  }
}

function recordHookMatch(failures: string[], score: HookScore, pair: HookPair): void {
  const { finding, gold } = pair;
  const agrees = finding.action === gold.action;
  score.matched += agrees ? 1 : 0;
  score.knownMisses += !agrees && gold.enforced === false ? 1 : 0;
  if (agrees || gold.enforced === false) {
    return;
  }
  failures.push(
    `${gold.target}/${gold.file}:${gold.line}: expected ${gold.action}, received ${finding.action} (${gold.rationale})`,
  );
}

function recordAbstentionReasonMatch(failures: string[], pair: HookPair): void {
  const { finding, gold } = pair;
  if (gold.abstentionReason === undefined || finding.abstentionReason === gold.abstentionReason) {
    return;
  }
  failures.push(
    `${gold.target}/${gold.file}:${gold.line}: expected abstention reason ${gold.abstentionReason}, received ${finding.abstentionReason ?? "none"} (${gold.rationale})`,
  );
}

function recordAssumptionMatch(failures: string[], score: HookScore, pair: HookPair): void {
  const { finding, gold } = pair;
  if (gold.assumption === undefined) {
    return;
  }
  score.assumptions.labeled += 1;
  if (finding.assumption?.ifConfirmed === gold.assumption.ifConfirmed) {
    score.assumptions.matched += 1;
    return;
  }
  failures.push(
    `${gold.target}/${gold.file}:${gold.line}: expected a review question confirming ${gold.assumption.ifConfirmed}, received ${finding.assumption?.ifConfirmed ?? "no question"} (${gold.rationale})`,
  );
}

function recordScoredPair(run: Evaluation, score: HookScore, pair: HookPair): void {
  countActions(score, pair);
  recordHookMatch(run.failures, score, pair);
  recordAbstentionReasonMatch(run.failures, pair);
  recordAssumptionMatch(run.failures, score, pair);
}

function scoreHookCase(run: Evaluation, gold: GoldHookCase, score: HookScore): void {
  const target = run.targets.get(gold.target);
  if (!target) {
    return;
  }
  score.labeled += 1;
  const finding = target.report.findings.find(
    (candidate) =>
      isAt(candidate.location, gold) &&
      candidate.hook === gold.hook &&
      candidate.name === gold.name,
  );
  if (!finding) {
    run.failures.push(`${gold.target}/${gold.file}:${gold.line}: hook was not inventoried`);
    return;
  }
  recordScoredPair(run, score, { finding, gold });
}

export function scoreHookCases(
  run: Evaluation,
  cases: readonly GoldHookCase[] = goldCases,
): HookScore {
  const score: HookScore = {
    actualActionable: 0,
    assumptions: { labeled: 0, matched: 0 },
    byAction: new Map(),
    correctActionable: 0,
    expectedActionable: 0,
    knownMisses: 0,
    labeled: 0,
    matched: 0,
  };
  for (const gold of cases) {
    scoreHookCase(run, gold, score);
  }
  return score;
}

function sameMembers(
  actual: readonly string[] | null | undefined,
  expected: readonly string[] | null,
): boolean {
  const actualMissing = actual === null || actual === undefined;
  if (actualMissing || expected === null) {
    return actualMissing && expected === null;
  }
  return (
    actual.length === expected.length && actual.every((member, index) => member === expected[index])
  );
}

function formatMembers(members: readonly string[] | null | undefined): string {
  return members ? `[${members.join(", ")}]` : "none";
}

function scoreStateGroup(run: Evaluation, gold: GoldStateGroupCase, score: Tally): void {
  const target = run.targets.get(gold.target);
  if (!target) {
    return;
  }
  score.labels += 1;
  const finding = target.report.findings.find(
    (candidate) => isAt(candidate.location, gold) && candidate.hook === "useState",
  );
  const actualMembers = finding?.group?.primary ? finding.group.members : null;
  if (sameMembers(actualMembers, gold.members)) {
    score.matches += 1;
    return;
  }
  run.failures.push(
    `${gold.target}/${gold.file}:${gold.line}: expected state group ${formatMembers(gold.members)}, received ${formatMembers(actualMembers)} (${gold.rationale})`,
  );
}

export function scoreStateGroups(
  run: Evaluation,
  cases: readonly GoldStateGroupCase[] = goldStateGroups,
): Tally {
  const score: Tally = { labels: 0, matches: 0, predictions: 0 };
  for (const gold of cases) {
    scoreStateGroup(run, gold, score);
  }
  return score;
}

function practiceKey(target: string, location: SourceLocation, action: string): string {
  return `${target}\0${path.normalize(location.file)}\0${location.line}\0${action}`;
}

function scorePracticeCase(run: Evaluation, gold: GoldPracticeCase, score: Tally): void {
  const target = run.targets.get(gold.target);
  if (!target) {
    return;
  }
  score.labels += 1;
  const finding = target.report.practices.find(
    (candidate) =>
      isAt(candidate.location, gold) &&
      candidate.action === gold.action &&
      candidate.disposition !== "candidate",
  );
  const agrees =
    finding !== undefined &&
    (gold.disposition === undefined || finding.disposition === gold.disposition);
  if (agrees) {
    score.matches += 1;
  } else {
    const detail = finding
      ? ` disposition ${gold.disposition}, received ${finding.disposition}`
      : "";
    run.failures.push(
      `${gold.target}/${gold.file}:${gold.line}: expected ${gold.action}${detail} (${gold.rationale})`,
    );
  }
}

function recordUnexpectedPractices(
  run: Evaluation,
  labeled: ReadonlySet<string>,
  score: Tally,
): void {
  for (const [targetId, target] of run.targets) {
    for (const finding of target.report.practices) {
      if (finding.disposition === "candidate") {
        continue;
      }
      score.predictions += 1;
      const { file, line } = finding.location;
      if (labeled.has(practiceKey(targetId, finding.location, finding.action))) {
        continue;
      }
      run.failures.push(
        `${targetId}/${file}:${line}: unexpected Legend practice ${finding.action}`,
      );
    }
  }
}

export function scorePractices(
  run: Evaluation,
  cases: readonly GoldPracticeCase[] = goldPracticeCases,
): Tally {
  const score: Tally = { labels: 0, matches: 0, predictions: 0 };
  const labeled = new Set(cases.map((gold) => practiceKey(gold.target, gold, gold.action)));
  for (const gold of cases) {
    scorePracticeCase(run, gold, score);
  }
  recordUnexpectedPractices(run, labeled, score);
  return score;
}
