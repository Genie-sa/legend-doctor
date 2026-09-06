import { inspectRepository, mapSequentially } from "./runner/repository-inspection.js";
import { scoreHookCases, scorePractices, scoreStateGroups } from "./runner/scoring.js";
import type { CorpusSlice } from "./corpus/private-corpus.js";
import type { Evaluation } from "./runner/model.js";
import { goldCases } from "./corpus/hook-cases.js";
import { goldPracticeCases } from "./corpus/practice-cases.js";
import { goldStateGroups } from "./corpus/state-groups.js";
import { loadPrivateCorpus } from "./corpus/private-corpus.js";
import path from "node:path";
import process from "node:process";
import { repositories } from "./corpus/repositories.js";
import { summaryLines } from "./runner/summary.js";

const USAGE =
  "Provide checked-out repositories as --repo <name>=/path for each pinned corpus repository " +
  "(see evals/README.md); repositories without a path are reported and skipped.";

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
  const repositoryRoots = parseRepositoryRoots(process.argv.slice(2));
  if (repositoryRoots.size === 0) {
    throw new Error(USAGE);
  }
  const privateCorpus = await loadPrivateCorpus();
  const corpus = mergeCorpus(privateCorpus);
  const run: Evaluation = { failures: [], hooks: 0, targets: new Map() };
  await mapSequentially(corpus.repositories, (repository) =>
    inspectRepository(run, repository, repositoryRoots),
  );
  const header = privateCorpus ? "Private corpus loaded." : "Public corpus only.";
  process.stdout.write(`${header}\n${scoreCorpus(run, corpus).join("\n")}\n`);
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
