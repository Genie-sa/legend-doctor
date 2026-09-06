import { CLI_PATH, run, runExpectingFailure, writeFixtureRoot } from "./harness.js";
import assert from "node:assert/strict";
import process from "node:process";
import { rm } from "node:fs/promises";
import test from "node:test";

test("--fail-on exits 3 with a gate summary when a shown finding matches", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const failure = await runExpectingFailure([root, "--fail-on", "change"]);

  assert.equal(failure.code, 3);
  assert.equal(failure.stderr, "");
  // SAFETY: the CLI completed the scan, so stdout is a serialized report.
  const report = JSON.parse(failure.stdout) as {
    gate: unknown;
    practices: { action: string }[];
    status: string;
  };
  assert.equal(report.status, "ok");
  assert.ok(report.practices.some((practice) => practice.action === "assign-observable-fields"));
  assert.deepEqual(report.gate, { failOn: ["change"], matched: 1 });
});

test("--fail-on exits 0 and reports a passed gate when nothing shown matches", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, root, "--fail-on", "candidate"]);
  // SAFETY: the CLI exited successfully, so stdout is a serialized report.
  const report = JSON.parse(stdout) as { gate: unknown };

  assert.deepEqual(report.gate, { failOn: ["candidate"], matched: 0 });
});

test("--fail-on accepts a comma list and reports the gate in JSON", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const failure = await runExpectingFailure([root, "--fail-on=change,candidate"]);

  assert.equal(failure.code, 3);
  // SAFETY: the CLI completed the scan, so stdout is a serialized report.
  const report = JSON.parse(failure.stdout) as { gate: unknown; status: string };
  assert.equal(report.status, "ok");
  assert.deepEqual(report.gate, { failOn: ["change", "candidate"], matched: 1 });
});

test("--fail-on is evaluated after filters", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [
    CLI_PATH,
    root,
    "--disposition",
    "keep",
    "--fail-on",
    "change",
  ]);
  // SAFETY: the CLI exited successfully, so stdout is a serialized report.
  const report = JSON.parse(stdout) as { gate: unknown; hidden: unknown };

  assert.deepEqual(report.gate, { failOn: ["change"], matched: 0 });
  assert.deepEqual(report.hidden, { findings: 0, practices: 1 });
});
