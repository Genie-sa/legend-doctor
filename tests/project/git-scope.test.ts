import { COMPONENT, git, gitFixtureRoot } from "./git-harness.js";
import { GitScopeError, resolveScopedFiles } from "../../src/project/git-scope.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { pathIdentityKey } from "../../src/core/path-identity.js";
import test from "node:test";

function keys(root: string, ...relativePaths: string[]): string[] {
  return relativePaths.map((relative) => pathIdentityKey(path.join(root, relative))).toSorted();
}

test("--changed selects edited, staged, and untracked files and drops deleted ones", async (testContext) => {
  const root = await gitFixtureRoot("legend-doctor-scope-changed-");
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "src", "edited.tsx"), `${COMPONENT}// edited\n`, "utf8");
  await writeFile(path.join(root, "src", "fresh.tsx"), COMPONENT, "utf8");
  await writeFile(path.join(root, "src", "staged.tsx"), COMPONENT, "utf8");
  await git(root, "add", "src/staged.tsx");
  await rm(path.join(root, "src", "committed.tsx"));

  const files = await resolveScopedFiles(root, { mode: "changed" });

  assert.deepEqual(
    [...files].toSorted(),
    keys(root, "src/edited.tsx", "src/fresh.tsx", "src/staged.tsx"),
  );
});

test("--staged selects only index entries", async (testContext) => {
  const root = await gitFixtureRoot("legend-doctor-scope-staged-");
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "src", "edited.tsx"), `${COMPONENT}// edited\n`, "utf8");
  await writeFile(path.join(root, "src", "staged.tsx"), COMPONENT, "utf8");
  await git(root, "add", "src/staged.tsx");

  const files = await resolveScopedFiles(root, { mode: "staged" });

  assert.deepEqual([...files], keys(root, "src/staged.tsx"));
});

test("--since selects files committed on the branch plus uncommitted work", async (testContext) => {
  const root = await gitFixtureRoot("legend-doctor-scope-since-");
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await git(root, "checkout", "-q", "-b", "feature");
  await writeFile(path.join(root, "src", "branch.tsx"), COMPONENT, "utf8");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "branch work");
  await writeFile(path.join(root, "src", "edited.tsx"), `${COMPONENT}// edited\n`, "utf8");

  const files = await resolveScopedFiles(root, { mode: "since", ref: "main" });

  assert.deepEqual([...files].toSorted(), keys(root, "src/branch.tsx", "src/edited.tsx"));
});

test("--since rejects a ref git cannot resolve", async (testContext) => {
  const root = await gitFixtureRoot("legend-doctor-scope-bad-ref-");
  testContext.after(() => rm(root, { force: true, recursive: true }));

  await assert.rejects(
    resolveScopedFiles(root, { mode: "since", ref: "no-such-branch" }),
    (error) => error instanceof GitScopeError && /no-such-branch/u.test(error.message),
  );
});

test("a repository without commits treats every tracked and untracked file as changed", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-scope-no-head-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await git(root, "init", "-q");
  await writeFile(path.join(root, "tracked.tsx"), COMPONENT, "utf8");
  await writeFile(path.join(root, "untracked.tsx"), COMPONENT, "utf8");
  await git(root, "add", "tracked.tsx");

  const [changed, staged] = await Promise.all([
    resolveScopedFiles(root, { mode: "changed" }),
    resolveScopedFiles(root, { mode: "staged" }),
  ]);

  assert.deepEqual([...changed].toSorted(), keys(root, "tracked.tsx", "untracked.tsx"));
  assert.deepEqual([...staged], keys(root, "tracked.tsx"));
});

test("a directory outside any git work tree is reported as such", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-scope-no-git-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));

  await assert.rejects(
    resolveScopedFiles(root, { mode: "changed" }),
    (error) => error instanceof GitScopeError && /git work tree/u.test(error.message),
  );
});
