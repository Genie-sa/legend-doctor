import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { AnalysisReport } from "../src/types.js";

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
    "utf8"
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
    "utf8"
  );
  return root;
}

test("--disposition change keeps only change findings and practices", async t => {
  const root = await writeFixtureRoot();
  t.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, root, "--json", "--disposition", "change"]);
  const report = JSON.parse(stdout) as AnalysisReport;

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.findings.length, 0);
  assert.deepEqual(
    report.practices.map(practice => [practice.action, practice.disposition]),
    [["assign-observable-fields", "change"]]
  );
});

test("--disposition keep composes with the equals form and drops practices", async t => {
  const root = await writeFixtureRoot();
  t.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, root, "--json", "--disposition=keep"]);
  const report = JSON.parse(stdout) as AnalysisReport;

  assert.deepEqual(report.findings.map(finding => finding.disposition), ["keep"]);
  assert.deepEqual(report.practices, []);
});

test("rejects an unknown disposition value", async t => {
  const root = await writeFixtureRoot();
  t.after(() => rm(root, { force: true, recursive: true }));

  await assert.rejects(
    run(process.execPath, [CLI_PATH, root, "--json", "--disposition", "bogus"]),
    (error: unknown) =>
      error instanceof Error && /--disposition must be one of/.test((error as { stderr?: string }).stderr ?? "")
  );
});

test("text output appends the re-run hint when change findings are shown", async t => {
  const root = await writeFixtureRoot();
  t.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, root]);

  assert.match(stdout, /Re-run legend-doctor after applying change findings/);
});
