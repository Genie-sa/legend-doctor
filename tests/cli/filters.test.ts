import { CLI_PATH, run, runExpectingFailure, writeFixtureRoot } from "./harness.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AnalysisReport } from "../../src/core/types.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

type CliReport = AnalysisReport & {
  hidden: { abstentions: Record<string, number>; findings: number; practices: number };
};

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview /><Nav />";

async function scanPanel(source: string, flags: readonly string[]): Promise<CliReport> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-cli-review-"));
  try {
    await writeFile(path.join(root, "panel.tsx"), source, "utf8");
    const { stdout } = await run(process.execPath, [CLI_PATH, root, ...flags]);
    // SAFETY: the CLI exited successfully, so stdout is the serialized CLI report.
    return JSON.parse(stdout) as CliReport;
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function reviewedStates(report: CliReport): (string | null)[] {
  return report.findings
    .filter((finding) => finding.action === "review-state")
    .map((finding) => finding.name);
}

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
    [["use-computed-for-parent-reads", "candidate"]],
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
    "use-computed-for-parent-reads",
  ]);
  // SAFETY: same contract as above.
  const report = JSON.parse(stdout) as CliReport;

  assert.equal(
    before.practices.some((practice) => practice.action === "use-computed-for-parent-reads"),
    true,
  );
  assert.equal(
    report.practices.some((practice) => practice.action === "use-computed-for-parent-reads"),
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

test("--disposition candidate hides a review no answer converts and counts it by reason", async () => {
  const source = `
    import { useState } from "react";
    export function Panel() {
      const [render, setRender] = useState<(() => JSX.Element) | null>(null);
      return <main>${CHROME}<Slot render={render} />{render ? render() : null}<button onClick={() => setRender(null)} /></main>;
    }
  `;

  const full = await scanPanel(source, []);
  const report = await scanPanel(source, ["--disposition", "candidate"]);

  assert.deepEqual(reviewedStates(full), ["render"]);
  assert.deepEqual(reviewedStates(report), []);
  assert.deepEqual(report.hidden.abstentions, { "no-proven-optimization": 1 });
});

test("--actionable hides a co-written member its group's yes leaves under review", async () => {
  const source = `
    import { useState } from "react";
    export function Panel() {
      const [open, setOpen] = useState(false);
      const [error, setError] = useState<string | null>(null);
      const fail = (message: string) => { setError(message); setOpen(true); };
      return <main>${CHROME}
        <button onClick={() => fail("boom")} />
        {error ? <p role="alert">{error.toUpperCase()}</p> : null}
        <Drawer open={open} onClose={() => setOpen(false)} />
      </main>;
    }
  `;

  const report = await scanPanel(source, ["--actionable"]);

  assert.deepEqual(reviewedStates(report), ["open"]);
  assert.deepEqual(
    report.questions?.map((question) => question.id),
    ["panel.tsx::Panel::{open,error}::atomic-transition-unproven"],
  );
  assert.deepEqual(report.hidden.abstentions, { "atomic-transition-unproven": 1 });
});

test("--actionable keeps a co-written member when no shown review carries its group's question", async () => {
  const source = `
    import { useState } from "react";
    export function Panel({ onAdd }: { onAdd: (name: string) => void }) {
      const [name, setName] = useState("");
      const [adding, setAdding] = useState(false);
      const submit = () => {
        if (!name.trim()) return;
        onAdd(name);
        setName("");
        setAdding(false);
      };
      return <main>${CHROME}
        <button onClick={() => setAdding(!adding)}>{adding ? "Cancel" : "Add"}</button>
        {adding && <form><Input value={name} onChange={(e) => setName(e.target.value)} /><button onClick={submit} /></form>}
      </main>;
    }
    function Input({ value, onChange }: { value: string; onChange: (e: { target: { value: string } }) => void }) {
      return <input value={value} onChange={onChange} />;
    }
  `;

  const report = await scanPanel(source, ["--actionable"]);

  assert.deepEqual(
    report.findings.map((finding) => [finding.name, finding.action]),
    [
      ["name", "use-observable"],
      ["adding", "review-state"],
    ],
  );
  assert.equal(
    report.findings[1]?.assumption?.id,
    "panel.tsx::Panel::{name,adding}::atomic-transition-unproven",
  );
  assert.deepEqual(report.hidden.abstentions, {});
});
