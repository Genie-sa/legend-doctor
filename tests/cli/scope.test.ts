import { CLI_PATH, failurePayload, run, runExpectingFailure, writeFixtureRoot } from "./harness.js";
import { git, gitFixtureRoot } from "../project/git-harness.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const COUNTER = `
  import { useState } from "react";
  export function Counter() {
    const [count, setCount] = useState(0);
    return <button onClick={() => setCount(count + 1)}>{count}</button>;
  }
`;

test("--changed analyzes only the edited files while the report keeps the full context size", async (testContext) => {
  const root = await gitFixtureRoot("legend-doctor-cli-changed-");
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "src", "committed.tsx"), COUNTER, "utf8");
  await git(root, "commit", "-q", "-am", "committed counter");
  await writeFile(path.join(root, "src", "edited.tsx"), COUNTER, "utf8");

  const { stdout } = await run(process.execPath, [CLI_PATH, root, "--changed"]);
  // SAFETY: the CLI exited successfully, so stdout is a serialized report.
  const report = JSON.parse(stdout) as {
    files: number;
    findings: { location: { file: string } }[];
    scope: unknown;
  };

  assert.equal(report.files, 1);
  assert.deepEqual(report.scope, { mode: "changed", contextFiles: 2 });
  assert.deepEqual(
    report.findings.map((finding) => finding.location.file),
    [path.join("src", "edited.tsx")],
  );
});

test("--since names the ref in the report and counts the scoped subset", async (testContext) => {
  const root = await gitFixtureRoot("legend-doctor-cli-since-");
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await git(root, "checkout", "-q", "-b", "feature");
  await writeFile(path.join(root, "src", "edited.tsx"), COUNTER, "utf8");

  const [spaced, inline] = await Promise.all([
    run(process.execPath, [CLI_PATH, root, "--since", "main"]),
    run(process.execPath, [CLI_PATH, root, "--since=main"]),
  ]);
  // SAFETY: the CLI exited successfully, so stdout is a serialized report.
  const report = JSON.parse(spaced.stdout) as {
    files: number;
    hooks: { states: number };
    scope: unknown;
  };
  // SAFETY: same invocation with the inline flag form.
  const inlineReport = JSON.parse(inline.stdout) as { scope: unknown };

  assert.deepEqual(report.scope, { mode: "since", ref: "main", contextFiles: 2 });
  assert.equal(report.files, 1);
  assert.equal(report.hooks.states, 1);
  assert.deepEqual(inlineReport.scope, report.scope);
});

test("an empty scope says so instead of claiming there is nothing to scan", async (testContext) => {
  const root = await gitFixtureRoot("legend-doctor-cli-clean-");
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, root, "--staged"]);
  // SAFETY: the CLI exited successfully, so stdout is a serialized report.
  const report = JSON.parse(stdout) as { files: number; findings: unknown[]; scope: unknown };

  assert.equal(report.files, 0);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.scope, { mode: "staged", contextFiles: 2 });
});

test("a scope flag outside a git work tree fails with scope_unavailable", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-cli-no-git-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "screen.tsx"), COUNTER, "utf8");

  const failure = await runExpectingFailure([root, "--changed"]);

  assert.equal(failure.code, 1);
  assert.equal(failure.stderr, "");
  // SAFETY: the CLI failed, so stdout is a serialized failure payload.
  const payload = JSON.parse(failure.stdout) as { message: string; reason: string; status: string };
  assert.equal(payload.status, "error");
  assert.equal(payload.reason, "scope_unavailable");
  assert.match(payload.message, /git work tree/u);
});

test("scope flags are exclusive and need a directory target", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const [combined, fileTarget, missingRef] = await Promise.all([
    failurePayload([root, "--changed", "--staged"]),
    failurePayload([path.join(root, "screen.tsx"), "--changed"]),
    failurePayload([root, "--since"]),
  ]);

  assert.equal(combined.code, 2);
  assert.match(combined.payload.message, /one scope flag .* got --changed and --staged/u);
  assert.equal(fileTarget.code, 2);
  assert.match(fileTarget.payload.message, /--changed needs a directory target/u);
  assert.equal(missingRef.code, 2);
  assert.match(missingRef.payload.message, /--since needs a git ref/u);
});
