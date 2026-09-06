import { CLI_PATH, run, runExpectingFailure, writeFixtureRoot } from "./harness.js";
import type { AnalysisReport } from "../../src/core/types.js";
import assert from "node:assert/strict";
import process from "node:process";
import { rm } from "node:fs/promises";
import test from "node:test";

type CliReport = AnalysisReport & { hidden: { findings: number; practices: number } };

test("--disposition change keeps only change findings and practices", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, root, "--disposition", "change"]);
  // SAFETY: the CLI exited successfully, so stdout is a serialized AnalysisReport.
  const report = JSON.parse(stdout) as AnalysisReport;

  assert.equal(report.schemaVersion, 3);
  assert.equal(report.findings.length, 0);
  assert.deepEqual(
    report.practices.map((practice) => [practice.action, practice.disposition]),
    [["assign-observable-fields", "change"]],
  );
});

test("--ignore-action hides the named actions and counts them as hidden", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const full = await run(process.execPath, [CLI_PATH, root]);
  // SAFETY: the CLI exited successfully, so stdout is the serialized CLI report.
  const before = JSON.parse(full.stdout) as CliReport;

  const { stdout } = await run(process.execPath, [
    CLI_PATH,
    root,
    "--ignore-action",
    "assign-observable-fields",
  ]);
  // SAFETY: same contract as above.
  const report = JSON.parse(stdout) as CliReport;

  assert.equal(
    before.practices.some((practice) => practice.action === "assign-observable-fields"),
    true,
  );
  assert.equal(
    report.practices.some((practice) => practice.action === "assign-observable-fields"),
    false,
  );
  assert.equal(report.findings.length, before.findings.length);
  assert.equal(report.hidden.practices, before.practices.length - report.practices.length);
});

test("--ignore-action rejects an unknown action name", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const failure = await runExpectingFailure([root, "--ignore-action", "not-an-action"]);

  assert.equal(failure.code, 2);
  assert.match(failure.stdout, /not-an-action/u);
});

test("--disposition keep composes with the equals form and drops practices", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, root, "--disposition=keep"]);
  // SAFETY: the CLI exited successfully, so stdout is a serialized AnalysisReport.
  const report = JSON.parse(stdout) as AnalysisReport;

  assert.deepEqual(
    report.findings.map((finding) => finding.disposition),
    ["keep"],
  );
  assert.deepEqual(report.practices, []);
});
