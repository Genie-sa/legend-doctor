import { inspectRepository, mapSequentially } from "./runner/repository-inspection.js";
import {
  knownFalsePracticeLines,
  knownMissPracticeLines,
  scoreHookCases,
  scorePractices,
  scoreStateGroups,
} from "./runner/scoring.js";
import { parseSelection, selectionLines, validateSelection } from "./runner/selection.js";
import type { CorpusSlice } from "./corpus/private-corpus.js";
import type { Evaluation } from "./runner/model.js";
import { editApplicationLines } from "./runner/edit-application.js";
import { goldCases } from "./corpus/hook-cases.js";
import { goldPracticeCases } from "./corpus/practice-cases.js";
import { goldStateGroups } from "./corpus/state-groups.js";
import { loadPrivateCorpus } from "./corpus/private-corpus.js";
import process from "node:process";
import { replayCommits } from "./corpus/replay-commits.js";
import { replayExpertCommits } from "./runner/replay.js";
import { replaySummaryLines } from "./runner/replay-summary.js";
import { repositories } from "./corpus/repositories.js";
import { summaryLines } from "./runner/summary.js";

function mergeCorpus(privateCorpus: CorpusSlice | null): CorpusSlice {
  return {
    hookCases: [...goldCases, ...(privateCorpus?.hookCases ?? [])],
    practiceCases: [...goldPracticeCases, ...(privateCorpus?.practiceCases ?? [])],
    repositories: [...repositories, ...(privateCorpus?.repositories ?? [])],
    stateGroups: [...goldStateGroups, ...(privateCorpus?.stateGroups ?? [])],
  };
}

function scoreCorpus(run: Evaluation, corpus: CorpusSlice): readonly string[] {
  const hooks = scoreHookCases(run, corpus.hookCases);
  const tallies = {
    groups: scoreStateGroups(run, corpus.stateGroups),
    practices: scorePractices(run, corpus.practiceCases),
  };
  return [
    ...summaryLines(run, hooks, tallies),
    ...knownFalsePracticeLines(run, corpus.practiceCases),
    ...knownMissPracticeLines(run, corpus.practiceCases),
  ];
}

function reportFailures(failures: readonly string[]): void {
  if (failures.length === 0) {
    return;
  }
  process.stderr.write(`${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
}

async function evaluate(): Promise<void> {
  const privateCorpus = await loadPrivateCorpus();
  const corpus = mergeCorpus(privateCorpus);
  const selection = parseSelection(process.argv.slice(2), corpus.repositories);
  process.stdout.write(
    `${privateCorpus ? "Private corpus loaded." : "Public corpus only."}\n${selectionLines(selection, corpus.repositories).join("\n")}\n`,
  );
  validateSelection(selection, corpus.repositories);
  const run: Evaluation = { failures: [], hooks: 0, targets: new Map() };
  await mapSequentially(corpus.repositories, (repository) =>
    inspectRepository(run, repository, selection.roots),
  );
  const replays = await replayExpertCommits(replayCommits, selection.roots, run.failures);
  const editLines = await editApplicationLines(run);
  reportEvaluation(run, corpus, [...replaySummaryLines(replays), ...editLines]);
}

function reportEvaluation(
  run: Evaluation,
  corpus: CorpusSlice,
  sectionLines: readonly string[],
): void {
  if (run.targets.size === 0) {
    run.failures.push("No targets were evaluated; refusing to report empty precision/recall.");
  } else {
    const lines = [...scoreCorpus(run, corpus), ...sectionLines];
    process.stdout.write(`${lines.join("\n")}\n`);
  }
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
