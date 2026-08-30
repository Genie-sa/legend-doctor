import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { AnalysisReport } from "../src/types.js";

const run = promisify(execFile),
  CLI_PATH = path.join(import.meta.dirname, "..", "src", "cli.js");

async function writeFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-cli-"));
  await writeFile(
    path.join(root, "store.ts"),
    `
      import { observable } from "@legendapp/state";
      export const player$ = observable({ index: -1, isPlaying: false });
      export function play(index: number) {
        player$.index.set(index);
        player$.isPlaying.set(true);
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "screen.tsx"),
    `
      import { useState } from "react";
      export function Counter() {
        const [count, setCount] = useState(0);
        return <button onClick={() => setCount(count + 1)}>{count}</button>;
      }
    `,
    "utf8",
  );
  return root;
}

test("--disposition change keeps only change findings and practices", async (t) => {
  const root = await writeFixtureRoot();
  t.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [
      CLI_PATH,
      root,
      "--json",
      "--disposition",
      "change",
    ]),
    report = JSON.parse(stdout) as AnalysisReport;

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.findings.length, 0);
  assert.deepEqual(
    report.practices.map((practice) => [practice.action, practice.disposition]),
    [["assign-observable-fields", "change"]],
  );
});

test("--disposition keep composes with the equals form and drops practices", async (t) => {
  const root = await writeFixtureRoot();
  t.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, root, "--json", "--disposition=keep"]),
    report = JSON.parse(stdout) as AnalysisReport;

  assert.deepEqual(
    report.findings.map((finding) => finding.disposition),
    ["keep"],
  );
  assert.deepEqual(report.practices, []);
});

interface CliFailure {
  code: number;
  stderr: string;
  stdout: string;
}

async function runExpectingFailure(args: readonly string[]): Promise<CliFailure> {
  try {
    await run(process.execPath, [CLI_PATH, ...args]);
  } catch (error) {
    const failure = error as { code?: number; stderr?: string; stdout?: string };
    return { code: failure.code ?? 0, stderr: failure.stderr ?? "", stdout: failure.stdout ?? "" };
  }
  throw new Error(`expected CLI failure for: ${args.join(" ")}`);
}

test("rejects an unknown disposition value as a usage error", async (t) => {
  const root = await writeFixtureRoot();
  t.after(() => rm(root, { force: true, recursive: true }));

  const failure = await runExpectingFailure([root, "--json", "--disposition", "bogus"]);

  assert.equal(failure.code, 2);
  assert.equal(failure.stdout, "");
  assert.match(failure.stderr, /bogus/);
  for (const valid of ["candidate", "change", "keep", "style"]) {
    assert.match(failure.stderr, new RegExp(valid));
  }
  assert.match(failure.stderr, /--help/);
});

test("rejects --disposition without a value", async (t) => {
  const root = await writeFixtureRoot();
  t.after(() => rm(root, { force: true, recursive: true }));

  const failure = await runExpectingFailure([root, "--disposition", "--json"]);

  assert.equal(failure.code, 2);
  assert.match(failure.stderr, /--disposition/);
});

test("rejects an unknown flag and suggests the closest known flag", async () => {
  const failure = await runExpectingFailure([".", "--acitonable"]);

  assert.equal(failure.code, 2);
  assert.equal(failure.stdout, "");
  assert.match(failure.stderr, /--acitonable/);
  assert.match(failure.stderr, /--actionable/);
  assert.match(failure.stderr, /--help/);
});

test("rejects a second positional target", async (t) => {
  const root = await writeFixtureRoot();
  t.after(() => rm(root, { force: true, recursive: true }));

  const failure = await runExpectingFailure([root, "extra-target"]);

  assert.equal(failure.code, 2);
  assert.match(failure.stderr, /extra-target/);
});

test("rejects --coverage without --json and names the fix", async (t) => {
  const root = await writeFixtureRoot();
  t.after(() => rm(root, { force: true, recursive: true }));

  const failure = await runExpectingFailure([root, "--coverage"]);

  assert.equal(failure.code, 2);
  assert.match(failure.stderr, /--json/);
});

test("reports a missing target with the resolved path and exit code 1", async () => {
  const missing = path.join(os.tmpdir(), "legend-doctor-missing", "nope"),
    failure = await runExpectingFailure([missing, "--json"]);

  assert.equal(failure.code, 1);
  assert.equal(failure.stdout, "");
  assert.match(failure.stderr, new RegExp(`legend-doctor-missing.*nope`));
  assert.doesNotMatch(failure.stderr, /--help/);
});

test("--help documents flags, dispositions, and exit codes on stdout", async () => {
  const { stdout, stderr } = await run(process.execPath, [CLI_PATH, "--help"]);

  assert.equal(stderr, "");
  assert.match(stdout, /Usage/);
  assert.match(stdout, /--json/);
  assert.match(stdout, /--actionable/);
  assert.match(stdout, /--disposition/);
  assert.match(stdout, /--coverage/);
  assert.match(stdout, /candidate \| change \| keep \| style/);
  assert.match(stdout, /Agent loop/);
  assert.match(stdout, /keep-react-effect/);
  assert.match(stdout, /Exit codes/);
});

test("-h prints the same help without scanning", async () => {
  const { stdout } = await run(process.execPath, [CLI_PATH, "-h", "/definitely/not/a/real/path"]);

  assert.match(stdout, /Usage/);
});

test("--version prints the package version", async () => {
  const { stdout, stderr } = await run(process.execPath, [CLI_PATH, "--version"]);

  assert.equal(stderr, "");
  assert.match(stdout, /^legend-doctor \d+\.\d+\.\d+\n$/);
});

test("text summary names the resolved scan root", async (t) => {
  const root = await writeFixtureRoot();
  t.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, root]);

  assert.match(stdout, new RegExp(`Scanned \\d+ files under .*${path.basename(root)}`));
});

test("text output appends the re-run hint when change findings are shown", async (t) => {
  const root = await writeFixtureRoot();
  t.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, root]);

  assert.match(stdout, /Re-run legend-doctor after applying change findings/);
});
