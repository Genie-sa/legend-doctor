import type { AnalysisReport, HookFinding } from "../src/types.js";
import type {
  CorpusRepository,
  CorpusTarget,
  GoldHookCase,
  GoldPracticeCase,
  GoldStateGroupCase,
} from "./corpus.js";
import { analyzePath, createAnalysisContext } from "../src/analyze-path.js";
import { goldCases, goldPracticeCases, goldStateGroups, repositories } from "./corpus.js";
import type { AnalysisContext } from "../src/analyze-path.js";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

interface TargetResult {
  report: AnalysisReport;
  root: string;
}

interface Evaluation {
  failures: string[];
  hooks: number;
  targets: Map<string, TargetResult>;
}

interface ActionScore {
  correct: number;
  expected: number;
  predicted: number;
}

interface Tally {
  labels: number;
  matches: number;
  predictions: number;
}

interface HookPair {
  finding: HookFinding;
  gold: GoldHookCase;
}

interface SourceLocation {
  file: string;
  line: number;
}

interface HookScore {
  actualActionable: number;
  byAction: Map<string, ActionScore>;
  correctActionable: number;
  expectedActionable: number;
  knownMisses: number;
  labeled: number;
  matched: number;
}

const USAGE =
  "Provide checked-out repositories as --repo platform=/path --repo memoria=/path --repo legend-music=/path --repo excalidraw=/path" +
  " --repo expensify=/path --repo formbricks=/path --repo outline=/path --repo genie-courses=/path";

const execFileAsync = promisify(execFile);

function* pendingResults<Item, Result>(
  items: Iterable<Item>,
  transform: (item: Item) => Promise<Result>,
): Generator<Promise<Result>> {
  for (const item of items) {
    yield transform(item);
  }
}

/** Pulls one promise at a time, so corpus analyses stay sequential instead of racing. */
async function mapSequentially<Item, Result>(
  items: Iterable<Item>,
  transform: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  for await (const result of pendingResults(items, transform)) {
    results.push(result);
  }
  return results;
}

function percentage(ratio: number): string {
  return (ratio * 100).toFixed(1);
}

function isActionable(action: string): boolean {
  return !["keep-effect", "keep-state", "review-effect", "review-state"].includes(action);
}

function isAt(location: SourceLocation, gold: SourceLocation): boolean {
  return location.file === path.normalize(gold.file) && location.line === gold.line;
}

async function headCommit(repositoryRoot: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function inspectTarget(
  run: Evaluation,
  target: CorpusTarget,
  where: { context: AnalysisContext | undefined; repositoryRoot: string },
): Promise<void> {
  const root = path.join(where.repositoryRoot, target.root);
  const report = await analyzePath(root, where.context);
  run.targets.set(target.id, { report, root });
  run.hooks += report.hooks.total;
  if (report.hooks.states !== target.states || report.hooks.effects !== target.effects) {
    run.failures.push(
      `${target.id}: expected ${target.states} useState/${target.effects} useEffect, received ${report.hooks.states}/${report.hooks.effects}`,
    );
  }
}

async function inspectRepository(
  run: Evaluation,
  repository: CorpusRepository,
  repositoryRoots: ReadonlyMap<string, string>,
): Promise<void> {
  const repositoryRoot = repositoryRoots.get(repository.name);
  if (!repositoryRoot) {
    return;
  }
  const actualCommit = await headCommit(repositoryRoot);
  if (actualCommit !== repository.commit) {
    run.failures.push(
      `${repository.name}: expected commit ${repository.commit}, received ${actualCommit}`,
    );
    return;
  }
  const context = repository.contextRoot
    ? await createAnalysisContext(path.join(repositoryRoot, repository.contextRoot))
    : undefined;
  await mapSequentially(repository.targets, (target) =>
    inspectTarget(run, target, { context, repositoryRoot }),
  );
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
  countActions(score, { finding, gold });
  recordHookMatch(run.failures, score, { finding, gold });
}

function scoreHookCases(run: Evaluation): HookScore {
  const score: HookScore = {
    actualActionable: 0,
    byAction: new Map(),
    correctActionable: 0,
    expectedActionable: 0,
    knownMisses: 0,
    labeled: 0,
    matched: 0,
  };
  for (const gold of goldCases) {
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

function scoreStateGroups(run: Evaluation): Tally {
  const score: Tally = { labels: 0, matches: 0, predictions: 0 };
  for (const gold of goldStateGroups) {
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
    (candidate) => isAt(candidate.location, gold) && candidate.action === gold.action,
  );
  score.matches += finding ? 1 : 0;
  if (finding) {
    return;
  }
  run.failures.push(
    `${gold.target}/${gold.file}:${gold.line}: expected ${gold.action} (${gold.rationale})`,
  );
}

function recordUnexpectedPractices(
  run: Evaluation,
  labeled: ReadonlySet<string>,
  score: Tally,
): void {
  for (const [targetId, target] of run.targets) {
    for (const finding of target.report.practices) {
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

function scorePractices(run: Evaluation): Tally {
  const score: Tally = { labels: 0, matches: 0, predictions: 0 };
  const labeled = new Set(
    goldPracticeCases.map((gold) => practiceKey(gold.target, gold, gold.action)),
  );
  for (const gold of goldPracticeCases) {
    scorePracticeCase(run, gold, score);
  }
  recordUnexpectedPractices(run, labeled, score);
  return score;
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

function summaryLines(
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
    `Matched ${groups.matches}/${groups.labels} grouped agent instructions.`,
    `Matched ${practices.matches}/${practices.labels} Legend practice findings.`,
    `Legend practice precision: ${percentage(hitRate)}% (${practices.matches}/${practices.predictions}).`,
    `Actionable precision on labeled hooks: ${percentage(precision)}% (${hooks.correctActionable}/${hooks.actualActionable}).`,
    `Actionable recall on labeled hooks: ${percentage(recall)}% (${hooks.correctActionable}/${hooks.expectedActionable}).`,
    ...formatActionLines(hooks.byAction),
  ];
}

function addRepositoryRoot(roots: Map<string, string>, assignment: string | undefined): void {
  if (!assignment) {
    throw new Error("--repo requires name=/absolute/path");
  }
  const separator = assignment.indexOf("=");
  if (separator <= 0) {
    throw new Error(`Invalid repository assignment: ${assignment}`);
  }
  roots.set(assignment.slice(0, separator), path.resolve(assignment.slice(separator + 1)));
}

function parseRepositoryRoots(args: readonly string[]): Map<string, string> {
  const roots = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--repo") {
      continue;
    }
    addRepositoryRoot(roots, args[index + 1]);
    index += 1;
  }
  return roots;
}

function reportFailures(failures: readonly string[]): void {
  if (failures.length === 0) {
    return;
  }
  process.stderr.write(`${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
}

async function evaluate(): Promise<void> {
  const repositoryRoots = parseRepositoryRoots(process.argv.slice(2));
  if (repositoryRoots.size === 0) {
    throw new Error(USAGE);
  }
  const run: Evaluation = { failures: [], hooks: 0, targets: new Map() };
  await mapSequentially(repositories, (repository) =>
    inspectRepository(run, repository, repositoryRoots),
  );
  const hooks = scoreHookCases(run);
  const tallies = { groups: scoreStateGroups(run), practices: scorePractices(run) };
  process.stdout.write(`${summaryLines(run, hooks, tallies).join("\n")}\n`);
  reportFailures(run.failures);
}

async function main(): Promise<void> {
  try {
    await evaluate();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function start(): void {
  main();
}

start();
