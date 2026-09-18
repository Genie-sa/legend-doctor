import { inspectRepository, mapSequentially } from "./runner/repository-inspection.js";
import { parseSelection, selectionLines, validateSelection } from "./runner/selection.js";
import { scoreHookCases, scorePractices, scoreStateGroups } from "./runner/scoring.js";
import type { CorpusSlice } from "./corpus/private-corpus.js";
import type { Evaluation } from "./runner/model.js";
import { goldCases } from "./corpus/hook-cases.js";
import { goldPracticeCases } from "./corpus/practice-cases.js";
import { goldStateGroups } from "./corpus/state-groups.js";
import { loadPrivateCorpus } from "./corpus/private-corpus.js";
import process from "node:process";
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
  return summaryLines(run, hooks, tallies);
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
  reportEvaluation(run, corpus);
}

function reportEvaluation(run: Evaluation, corpus: CorpusSlice): void {
  if (run.targets.size === 0) {
    run.failures.push("No targets were evaluated; refusing to report empty precision/recall.");
  } else {
    process.stdout.write(`${scoreCorpus(run, corpus).join("\n")}\n`);
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
