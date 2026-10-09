import type { ReplayCase, ReplayCommit } from "../corpus/contracts.js";
import { labelDrift, scoreReplayCase } from "./replay-scoring.js";
import type { ReplayOutcome } from "./replay-scoring.js";
import { analyzePath } from "../../src/project/analyze-path/analyze-path.js";
import { mapSequentially } from "./repository-inspection.js";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { withCommitTree } from "./commit-tree.js";

interface CommitReplay {
  drift: string[];
  outcomes: ReplayOutcome[];
}

async function sourceLine(sourceRoot: string, replayCase: ReplayCase): Promise<string | null> {
  try {
    const text = await readFile(path.join(sourceRoot, replayCase.file), "utf8");
    return text.split("\n")[replayCase.line - 1] ?? null;
  } catch {
    return null;
  }
}

async function driftIn(sourceRoot: string, commit: ReplayCommit): Promise<string[]> {
  const drift = await mapSequentially(commit.cases, async (replayCase) =>
    labelDrift(commit, replayCase, await sourceLine(sourceRoot, replayCase)),
  );
  return drift.filter((message) => message !== null);
}

async function replayTree(treeRoot: string, commit: ReplayCommit): Promise<CommitReplay> {
  const sourceRoot = path.join(treeRoot, commit.root);
  const report = await analyzePath(sourceRoot);
  const skipped = (report.skippedFiles ?? []).map(
    (file) =>
      `${commit.repository}@${commit.commit.slice(0, 7)}: skipped ${file.file} (${file.phase}): ${file.message}`,
  );
  return {
    drift: [...skipped, ...(await driftIn(sourceRoot, commit))],
    outcomes: commit.cases.map((replayCase) => scoreReplayCase(report, commit, replayCase)),
  };
}

async function replayCommit(
  commit: ReplayCommit,
  repositoryRoot: string,
  failures: string[],
): Promise<ReplayOutcome[]> {
  try {
    const replay = await withCommitTree(repositoryRoot, commit.parent, (treeRoot) =>
      replayTree(treeRoot, commit),
    );
    failures.push(...replay.drift);
    return replay.outcomes;
  } catch (error) {
    failures.push(
      `${commit.repository}@${commit.commit.slice(0, 7)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * Scans each expert commit's parent tree from the supplied checkouts. Misses never fail the run;
 * a missing parent object or a drifted label does, because either would silently skew recall.
 */
export async function replayExpertCommits(
  commits: readonly ReplayCommit[],
  roots: ReadonlyMap<string, string>,
  failures: string[],
): Promise<ReplayOutcome[]> {
  const supplied = commits.filter((commit) => roots.has(commit.repository));
  const outcomes = await mapSequentially(supplied, (commit) =>
    replayCommit(commit, roots.get(commit.repository)!, failures),
  );
  return outcomes.flat();
}
