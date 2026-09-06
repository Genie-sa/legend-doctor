import type { CorpusRepository, CorpusTarget } from "../corpus/contracts.js";
import type { AnalysisContext } from "../../src/project/analyze-path/analysis-context.js";
import type { Evaluation } from "./model.js";
import { analyzePath } from "../../src/project/analyze-path/analyze-path.js";
import { createAnalysisContext } from "../../src/project/analyze-path/analysis-context.js";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

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
export async function mapSequentially<Item, Result>(
  items: Iterable<Item>,
  transform: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  for await (const result of pendingResults(items, transform)) {
    results.push(result);
  }
  return results;
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
  where: {
    application: string;
    context: AnalysisContext | undefined;
    repository: string;
    repositoryRoot: string;
  },
): Promise<void> {
  const root = path.join(where.repositoryRoot, target.root);
  const context = target.contextRoot
    ? await createAnalysisContext(path.join(where.repositoryRoot, target.contextRoot))
    : where.context;
  const report = await analyzePath(root, { sharedContext: context });
  run.targets.set(target.id, {
    application: where.application,
    report,
    repository: where.repository,
    root,
  });
  run.hooks += report.hooks.total;
  if (report.hooks.states !== target.states || report.hooks.effects !== target.effects) {
    run.failures.push(
      `${target.id}: expected ${target.states} useState/${target.effects} useEffect, received ${report.hooks.states}/${report.hooks.effects}`,
    );
  }
}

export async function inspectRepository(
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
    inspectTarget(run, target, {
      application: target.application ?? repository.name,
      context,
      repository: repository.name,
      repositoryRoot,
    }),
  );
}
