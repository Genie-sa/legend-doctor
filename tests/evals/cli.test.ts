import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import type { SpawnSyncReturns } from "node:child_process";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { loadPrivateCorpus } from "../../evals/corpus/private-corpus.js";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { repositories } from "../../evals/corpus/repositories.js";
import test from "node:test";

const cli = new URL("../../evals/run.js", import.meta.url);

function evaluate(args: string[], entry: URL = cli): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [fileURLToPath(entry), ...args], { encoding: "utf8" });
}

test("invalid corpus selection fails instead of reporting perfect empty metrics", () => {
  for (const [args, message] of [
    [["--repo", "typo=/tmp"], /Unknown repository: typo/u],
    [["--repo", "legend-music="], /Invalid repository assignment/u],
    [["--repo"], /--repo requires/u],
    [["--repo", "--complete"], /--repo requires/u],
    [["--repo", ""], /--repo requires/u],
    [["--repo", "=/tmp"], /Invalid repository assignment/u],
    [["--repo", "legend-music"], /Invalid repository assignment/u],
    [["--repo", "Legend-music=/tmp"], /Unknown repository/u],
    [["--complet"], /Unknown argument/u],
    [["--partial", "--complete"], /mutually exclusive/u],
    [["--complete", "--partial"], /mutually exclusive/u],
    [["--repo", "legend-music=/one", "--repo", "legend-music=/two"], /Duplicate repository/u],
  ] as const) {
    const result = evaluate([...args]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stdout, /precision/u);
  }
});

test("complete mode lists omitted repositories before attempting a supplied path", () => {
  const result = evaluate(["--complete", "--repo", "legend-music=/does-not-exist"]);
  assert.equal(result.status, 1);
  for (const name of [
    "excalidraw",
    "expensify",
    "formbricks",
    "outline",
    "open-webui-react-native",
    "hoalu",
  ]) {
    assert.match(result.stdout, new RegExp(`Omitted repository: ${name}`, "u"));
  }
  assert.match(result.stderr, /Complete corpus requires every repository/u);
  assert.doesNotMatch(result.stderr, /not a git repository|cannot change to/u);
  assert.doesNotMatch(result.stdout, /precision/u);
});

function offPinCheckout(context: TestContext): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "legend-eval-off-pin-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", directory]);
  execFileSync("git", [
    "-C",
    directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "Off-pin fixture",
  ]);
  return directory;
}

test("an off-pin partial run reports omissions and fails without empty percentages", async (context) => {
  const privateCorpus = await loadPrivateCorpus();
  const repositoryCount = repositories.length + (privateCorpus?.repositories.length ?? 0);
  const directory = offPinCheckout(context);
  const result = evaluate(["--partial", "--repo", `legend-music=${directory}`]);
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes(`Partial corpus: 1/${repositoryCount} repositories supplied`));
  assert.match(result.stdout, /Omitted repository: hoalu/u);
  assert.match(result.stderr, /legend-music: expected commit/u);
  assert.match(result.stderr, /No targets were evaluated/u);
  assert.doesNotMatch(result.stdout, /precision/u);
});

test("supplying every repository in complete mode still rejects wrong pins and zero targets", async (context) => {
  const privateCorpus = await loadPrivateCorpus();
  const allRepositories = [...repositories, ...(privateCorpus?.repositories ?? [])];
  const directory = offPinCheckout(context);
  const args = allRepositories.flatMap(({ name }) => ["--repo", `${name}=${directory}`]);
  const result = evaluate(["--complete", ...args]);
  assert.equal(result.status, 1);
  assert.ok(
    result.stdout.includes(
      `Complete corpus required: ${allRepositories.length}/${allRepositories.length}`,
    ),
  );
  assert.doesNotMatch(result.stdout, /Omitted repository|precision/u);
  for (const repository of allRepositories) {
    assert.ok(result.stderr.includes(`${repository.name}: expected commit ${repository.commit}`));
  }
  assert.match(result.stderr, /No targets were evaluated/u);
});

test("a selected missing checkout fails as an inspection error after omissions are disclosed", (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "legend-eval-missing-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = evaluate([
    "--partial",
    "--repo",
    `legend-music=${path.join(directory, "absent")}`,
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Omitted repository: hoalu/u);
  assert.match(result.stderr, /cannot change to/u);
  assert.doesNotMatch(result.stdout, /precision/u);
});

test("CLI fixtures work from paths containing spaces, hash, and non-ASCII characters", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "legend eval # ü-"));
  try {
    const entry = path.join(directory, "run # ü.js");
    symlinkSync(fileURLToPath(cli), entry);
    const result = evaluate([], pathToFileURL(entry));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No repositories supplied/u);
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
