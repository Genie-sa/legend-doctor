import type { CorpusRepository } from "../corpus/contracts.js";
import path from "node:path";

interface CorpusSelection {
  complete: boolean;
  roots: Map<string, string>;
}

function addRepositoryRoot(
  roots: Map<string, string>,
  assignment: string | undefined,
  names: ReadonlySet<string>,
): void {
  if (!assignment || assignment.startsWith("--")) {
    throw new Error("--repo requires name=/absolute/path");
  }
  const separator = assignment.indexOf("=");
  if (separator <= 0 || separator === assignment.length - 1) {
    throw new Error(`Invalid repository assignment: ${assignment}`);
  }
  const name = assignment.slice(0, separator);
  validateRepositoryName(name, roots, names);
  roots.set(name, path.resolve(assignment.slice(separator + 1)));
}

function validateRepositoryName(
  name: string,
  roots: ReadonlyMap<string, string>,
  names: ReadonlySet<string>,
): void {
  if (!names.has(name)) {
    throw new Error(`Unknown repository: ${name}. Expected one of: ${[...names].join(", ")}`);
  }
  if (roots.has(name)) {
    throw new Error(`Duplicate repository: ${name}`);
  }
}

/** Validate selection against the loaded public and optional private corpus before scanning. */
export function parseSelection(
  args: readonly string[],
  repositories: readonly CorpusRepository[],
): CorpusSelection {
  const roots = new Map<string, string>();
  const names = new Set(repositories.map((repository) => repository.name));
  const modes = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--repo") {
      addRepositoryRoot(roots, args[index + 1], names);
      index += 1;
    } else {
      recordMode(modes, argument);
    }
  }
  return { complete: completeMode(modes), roots };
}

/** Missing repositories are visible even when partial evaluation is intentional. */
export function selectionLines(
  selection: CorpusSelection,
  repositories: readonly CorpusRepository[],
): string[] {
  const omitted = repositories.filter((repository) => !selection.roots.has(repository.name));
  const mode = selection.complete ? "Complete corpus required" : "Partial corpus";
  return [
    `${mode}: ${selection.roots.size}/${repositories.length} repositories supplied.`,
    ...omitted.map((repository) => `Omitted repository: ${repository.name}`),
  ];
}

export function validateSelection(
  selection: CorpusSelection,
  repositories: readonly CorpusRepository[],
): void {
  if (selection.complete && selection.roots.size !== repositories.length) {
    throw new Error("Complete corpus requires every repository; supply all omitted --repo paths.");
  }
  if (selection.roots.size === 0) {
    throw new Error("No repositories supplied. Use --repo name=/path (see evals/README.md).");
  }
}

function completeMode(modes: ReadonlySet<string>): boolean {
  if (modes.size > 1) {
    throw new Error("--complete and --partial are mutually exclusive");
  }
  return modes.has("--complete");
}

function recordMode(modes: Set<string>, argument: string): void {
  if (argument !== "--complete" && argument !== "--partial") {
    throw new Error(`Unknown argument: ${argument}`);
  }
  modes.add(argument);
}
