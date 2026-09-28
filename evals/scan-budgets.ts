import { SCAN_HEAP_LIMIT_MIB, scanBudget } from "./performance-budgets.js";
import { headCommit, mapSequentially } from "./runner/repository-inspection.js";
import { measureScan, scanOutcomeLine } from "./runner/scan-measurement.js";
import { parseSelection, selectionLines, validateSelection } from "./runner/selection.js";
import type { CorpusRepository } from "./corpus/contracts.js";
import os from "node:os";
import process from "node:process";
import { repositories } from "./corpus/repositories.js";

const BYTES_PER_GIB = 1024 ** 3;

function hostLine(): string {
  const memory = (os.totalmem() / BYTES_PER_GIB).toFixed(1);
  return `Whole-app scans on Node ${process.version}, ${os.availableParallelism()} CPUs, ${memory} GiB RAM, ${SCAN_HEAP_LIMIT_MIB} MiB heap limit per scan.`;
}

/** Prints the repository's measurement and returns its failure, if any. */
async function checkRepository(repository: CorpusRepository, root: string): Promise<string | null> {
  const actualCommit = await headCommit(root);
  if (actualCommit !== repository.commit) {
    return `${repository.name}: expected commit ${repository.commit}, received ${actualCommit}`;
  }
  const budget = scanBudget(repository.name);
  const outcome = await measureScan(root, budget);
  const line = scanOutcomeLine(repository.name, budget, outcome);
  process.stdout.write(`${line}\n`);
  return outcome.passed ? null : line;
}

async function checkBudgets(): Promise<void> {
  const selection = parseSelection(process.argv.slice(2), repositories);
  process.stdout.write(`${[...selectionLines(selection, repositories), hostLine()].join("\n")}\n`);
  validateSelection(selection, repositories);
  const supplied = repositories.filter((repository) => selection.roots.has(repository.name));
  const failures = await mapSequentially(supplied, (repository) =>
    checkRepository(repository, selection.roots.get(repository.name)!),
  );
  const failed = failures.filter((failure) => failure !== null);
  if (failed.length > 0) {
    process.stderr.write(`${failed.map((failure) => `- ${failure}`).join("\n")}\n`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  try {
    await checkBudgets();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function start(): void {
  main();
}

start();
