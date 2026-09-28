import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function assertCommitPresent(repositoryRoot: string, commit: string): Promise<void> {
  try {
    await execFileAsync("git", ["-C", repositoryRoot, "cat-file", "-e", `${commit}^{commit}`]);
  } catch {
    throw new Error(
      `${commit} is not in ${repositoryRoot}; fetch it with git -C ${repositoryRoot} fetch --depth=1 <repository url> ${commit}`,
    );
  }
}

async function extractTree(
  repositoryRoot: string,
  commit: string,
  workspace: string,
): Promise<string> {
  const archive = path.join(workspace, "tree.tar");
  const treeRoot = path.join(workspace, "tree");
  await mkdir(treeRoot);
  await execFileAsync("git", [
    "-C",
    repositoryRoot,
    "archive",
    "--format=tar",
    `--output=${archive}`,
    commit,
  ]);
  await execFileAsync("tar", ["-xf", archive, "-C", treeRoot]);
  return treeRoot;
}

/**
 * Materializes `commit` from the checkout's object store into a temporary directory without
 * touching the checkout's index, HEAD, or worktree, and removes it once `use` settles.
 */
export async function withCommitTree<Result>(
  repositoryRoot: string,
  commit: string,
  use: (treeRoot: string) => Promise<Result>,
): Promise<Result> {
  await assertCommitPresent(repositoryRoot, commit);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-replay-"));
  try {
    return await use(await extractTree(repositoryRoot, commit, workspace));
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}
