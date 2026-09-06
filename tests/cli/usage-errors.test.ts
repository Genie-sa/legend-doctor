import { CLI_PATH, failurePayload, run, writeFixtureRoot } from "./harness.js";
import { rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

test("rejects an unknown disposition value as a usage error payload", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const { code, payload, stderr } = await failurePayload([root, "--disposition", "bogus"]);

  assert.equal(code, 2);
  assert.equal(stderr, "");
  assert.deepEqual(payload, {
    schemaVersion: 3,
    status: "error",
    reason: "invalid_usage",
    message: "--disposition must be one of: candidate, change, keep, style; got 'bogus'",
    next: ["legend-doctor --help"],
  });
});

test("rejects '-' as a target because stdin is not read", async () => {
  const { code, payload } = await failurePayload(["-"]);

  assert.equal(code, 2);
  assert.match(payload.message, /stdin/u);
  assert.doesNotMatch(payload.message, /does not exist/u);
});

test("rejects a single-file target that is not a scannable source file", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));
  const notes = path.join(root, "NOTES.md");
  await writeFile(notes, "# notes\n", "utf8");

  const { code, payload } = await failurePayload([notes]);

  assert.equal(code, 2);
  assert.equal(payload.reason, "unsupported_target");
  assert.match(payload.message, /'\.md'/u);
  assert.match(payload.message, /\.tsx/u);
});

test("rejects --disposition without a value", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const { code, payload } = await failurePayload([root, "--disposition"]);

  assert.equal(code, 2);
  assert.equal(payload.reason, "invalid_usage");
  assert.match(payload.message, /--disposition needs a value/u);
});

test("rejects an unknown flag and suggests the closest known flag", async () => {
  const { code, payload } = await failurePayload([".", "--acitonable"]);

  assert.equal(code, 2);
  assert.match(payload.message, /--acitonable/u);
  assert.match(payload.message, /--actionable/u);
  assert.deepEqual(payload.next, ["legend-doctor --help"]);
});

test("rejects a second positional target", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const { code, payload } = await failurePayload([root, "extra-target"]);

  assert.equal(code, 2);
  assert.match(payload.message, /extra-target/u);
});

test("--coverage adds coverage to the report", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, root, "--coverage"]);
  // SAFETY: the CLI exited successfully, so stdout is a serialized report.
  const report = JSON.parse(stdout) as { coverage?: { entries: unknown[] } };
  assert.ok(report.coverage && report.coverage.entries.length > 0);
});

test("reports a missing target with the resolved path and exit code 1", async () => {
  const missing = path.join(os.tmpdir(), "legend-doctor-missing", "nope");
  const { code, payload } = await failurePayload([missing]);

  assert.equal(code, 1);
  assert.equal(payload.reason, "target_not_found");
  assert.match(payload.message, /legend-doctor-missing.*nope/u);
  assert.equal(payload.next, undefined);
});

test("rejects an unknown --fail-on value and names the valid set", async () => {
  const { code, payload } = await failurePayload([".", "--fail-on", "change,bogus"]);

  assert.equal(code, 2);
  assert.match(payload.message, /bogus/u);
  assert.match(payload.message, /candidate, change, keep, style/u);
});

test("rejects --fail-on without a value", async () => {
  const { code, payload } = await failurePayload([".", "--fail-on"]);

  assert.equal(code, 2);
  assert.match(payload.message, /--fail-on needs one or more/u);
});
