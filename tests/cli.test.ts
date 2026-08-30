import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AnalysisReport } from "../src/types.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const CLI_PATH = path.join(import.meta.dirname, "..", "src", "cli.js");

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

test("--disposition change keeps only change findings and practices", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [
    CLI_PATH,
    root,
    "--json",
    "--disposition",
    "change",
  ]);
  // SAFETY: the CLI ran with --json and exited successfully, so stdout is a serialized AnalysisReport.
  const report = JSON.parse(stdout) as AnalysisReport;

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.findings.length, 0);
  assert.deepEqual(
    report.practices.map((practice) => [practice.action, practice.disposition]),
    [["assign-observable-fields", "change"]],
  );
});

test("--disposition keep composes with the equals form and drops practices", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, root, "--json", "--disposition=keep"]);
  // SAFETY: the CLI ran with --json and exited successfully, so stdout is a serialized AnalysisReport.
  const report = JSON.parse(stdout) as AnalysisReport;

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
    // SAFETY: execFile rejects with an Error carrying the child's exit code and captured streams;
    // Every property of the asserted shape is optional and read through a `??` fallback below.
    const failure = error as { code?: number; stderr?: string; stdout?: string };
    return { code: failure.code ?? 0, stderr: failure.stderr ?? "", stdout: failure.stdout ?? "" };
  }
  throw new Error(`expected CLI failure for: ${args.join(" ")}`);
}

test("rejects an unknown disposition value as a usage error", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const failure = await runExpectingFailure([root, "--json", "--disposition", "bogus"]);

  assert.equal(failure.code, 2);
  assert.equal(failure.stdout, "");
  assert.match(failure.stderr, /bogus/u);
  for (const valid of ["candidate", "change", "keep", "style"]) {
    assert.match(failure.stderr, new RegExp(valid, "u"));
  }
  assert.match(failure.stderr, /--help/u);
});

test("rejects --disposition without a value", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const failure = await runExpectingFailure([root, "--disposition", "--json"]);

  assert.equal(failure.code, 2);
  assert.match(failure.stderr, /--disposition/u);
});

test("rejects an unknown flag and suggests the closest known flag", async () => {
  const failure = await runExpectingFailure([".", "--acitonable"]);

  assert.equal(failure.code, 2);
  assert.equal(failure.stdout, "");
  assert.match(failure.stderr, /--acitonable/u);
  assert.match(failure.stderr, /--actionable/u);
  assert.match(failure.stderr, /--help/u);
});

test("rejects a second positional target", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const failure = await runExpectingFailure([root, "extra-target"]);

  assert.equal(failure.code, 2);
  assert.match(failure.stderr, /extra-target/u);
});

test("rejects --coverage without --json and names the fix", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const failure = await runExpectingFailure([root, "--coverage"]);

  assert.equal(failure.code, 2);
  assert.match(failure.stderr, /--json/u);
});

test("reports a missing target with the resolved path and exit code 1", async () => {
  const missing = path.join(os.tmpdir(), "legend-doctor-missing", "nope");
  const failure = await runExpectingFailure([missing, "--json"]);

  assert.equal(failure.code, 1);
  assert.equal(failure.stdout, "");
  assert.match(failure.stderr, /legend-doctor-missing.*nope/u);
  assert.doesNotMatch(failure.stderr, /--help/u);
});

test("--help documents flags, dispositions, and exit codes on stdout", async () => {
  const { stdout, stderr } = await run(process.execPath, [CLI_PATH, "--help"]);

  assert.equal(stderr, "");
  assert.match(stdout, /Usage/u);
  assert.match(stdout, /--json/u);
  assert.match(stdout, /--actionable/u);
  assert.match(stdout, /--disposition/u);
  assert.match(stdout, /--coverage/u);
  assert.match(stdout, /candidate \| change \| keep \| style/u);
  assert.match(stdout, /Agent loop/u);
  assert.match(stdout, /keep-react-effect/u);
  assert.match(stdout, /Exit codes/u);
});

test("-h prints the same help without scanning", async () => {
  const { stdout } = await run(process.execPath, [CLI_PATH, "-h", "/definitely/not/a/real/path"]);

  assert.match(stdout, /Usage/u);
});

test("--version prints the package version", async () => {
  const { stdout, stderr } = await run(process.execPath, [CLI_PATH, "--version"]);

  assert.equal(stderr, "");
  assert.match(stdout, /^legend-doctor \d+\.\d+\.\d+\n$/u);
});

test("text summary names the resolved scan root", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, root]);

  assert.match(stdout, new RegExp(`Scanned \\d+ files under .*${path.basename(root)}`, "u"));
});

test("text output appends the re-run hint when change findings are shown", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, root]);

  assert.match(stdout, /Re-run legend-doctor after applying change findings/u);
});
