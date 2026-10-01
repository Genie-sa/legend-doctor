import { CLI_PATH, run, runExpectingFailure, writeFixtureRoot } from "./harness.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AnalysisReport } from "../../src/core/types.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

type CliReport = AnalysisReport & { hidden: { findings: number; practices: number } };

test("--disposition candidate keeps only candidate findings and practices", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, root, "--disposition", "candidate"]);
  // SAFETY: the CLI exited successfully, so stdout is a serialized AnalysisReport.
  const report = JSON.parse(stdout) as AnalysisReport;

  assert.equal(report.schemaVersion, 7);
  assert.equal(report.findings.length, 0);
  assert.deepEqual(
    report.practices.map((practice) => [practice.action, practice.disposition]),
    [["assign-observable-fields", "candidate"]],
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

test("--actionable hides style practices and counts them as hidden", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-cli-style-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "count.tsx"),
    `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const count$ = observable(0);
      export function Count() {
        const count = useValue(() => count$.get());
        return <span>{count}</span>;
      }
    `,
    "utf8",
  );

  const full = await run(process.execPath, [CLI_PATH, root]);
  // SAFETY: the CLI exited successfully, so stdout is the serialized CLI report.
  const before = JSON.parse(full.stdout) as CliReport;
  const { stdout } = await run(process.execPath, [CLI_PATH, root, "--actionable"]);
  // SAFETY: same contract as above.
  const report = JSON.parse(stdout) as CliReport;

  assert.deepEqual(
    before.practices.map((practice) => [practice.action, practice.disposition]),
    [["pass-observable-to-use-value", "style"]],
  );
  assert.deepEqual(report.practices, []);
  assert.equal(report.hidden.practices, 1);
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
