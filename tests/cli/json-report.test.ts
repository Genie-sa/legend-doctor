import { CLI_PATH, run, runExpectingFailure, writeFixtureRoot } from "./harness.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

interface FailurePayload {
  message: string;
  next?: string[];
  reason: string;
  schemaVersion: number;
  status: string;
}

interface ReportPayload {
  analyzer: { build: string; version: string };
  coverage?: { entries: unknown[] };
  diagnostics?: { parser: unknown[] };
  findings: unknown[];
  hidden: { findings: number; practices: number };
  /** Never present: the report is flat, not wrapped. */
  report?: unknown;
  root: string;
  schemaVersion: number;
  status: string;
}

test("a missing target is reported as a target_not_found payload without a next command", async () => {
  const missing = path.join(os.tmpdir(), "legend-doctor-missing", "nope");
  const failure = await runExpectingFailure([missing]);

  assert.equal(failure.code, 1);
  assert.equal(failure.stderr, "");
  // SAFETY: the CLI failed, so stdout is a serialized failure payload.
  const payload = JSON.parse(failure.stdout) as FailurePayload;
  assert.equal(payload.schemaVersion, 4);
  assert.equal(payload.status, "error");
  assert.equal(payload.reason, "target_not_found");
  assert.match(payload.message, /legend-doctor-missing.*nope/u);
  assert.equal(payload.next, undefined);
});

test("the report carries status, root, and hidden counts alongside the findings", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, root, "--actionable"]);
  // SAFETY: the CLI exited successfully, so stdout is a serialized report.
  const report = JSON.parse(stdout) as ReportPayload;

  assert.equal(report.status, "ok");
  assert.equal(report.root, root);
  assert.equal(report.schemaVersion, 4);
  assert.match(report.analyzer.build, /^[0-9a-f]{16}$/u);
  assert.match(report.analyzer.version, /^\d+\.\d+\.\d+/u);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.hidden, { findings: 1, practices: 0 });
});

test("--coverage adds coverage and diagnostics to the same report root", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, root, "--coverage"]);
  // SAFETY: the CLI exited successfully, so stdout is a serialized report.
  const report = JSON.parse(stdout) as ReportPayload;

  assert.equal(report.status, "ok");
  assert.equal(report.schemaVersion, 4);
  assert.equal(report.root, root);
  assert.deepEqual(report.hidden, { findings: 0, practices: 0 });
  assert.equal(report.report, undefined);
  assert.ok((report.coverage?.entries.length ?? 0) > 0);
  assert.deepEqual(Object.keys(report.diagnostics ?? {}).toSorted(), ["parser"]);
});

test("review findings serialize abstentionReason", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-cli-abstention-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Controls.tsx"),
    `
      export function EagerControl({ loading, onRun }: { loading: boolean; onRun: () => void }) {
        onRun();
        return <span>{String(loading)}</span>;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { EagerControl } from "./Controls";

      export function Screen() {
        const [loading, setLoading] = useState(false);
        const run = async () => {
          setLoading(true);
          try { await save(); } finally { setLoading(false); }
        };
        return <main>
          <Header /><Toolbar /><Summary /><Fields /><Preview /><Help />
          <History /><Aside /><Footer /><Actions /><Status />
          <EagerControl loading={loading} onRun={run} />
        </main>;
      }
    `,
    "utf8",
  );

  const { stdout: jsonOutput } = await run(process.execPath, [CLI_PATH, root]);
  // SAFETY: the CLI exited successfully, so stdout is a serialized report.
  const report = JSON.parse(jsonOutput) as {
    findings: {
      abstentionReason?: string;
      action: string;
      location: { column: number; file: string; line: number };
      message: string;
      name: string | null;
    }[];
  };
  const finding = report.findings.find((candidate) => candidate.name === "loading");
  assert.ok(finding);
  assert.equal(finding.action, "review-state");
  assert.equal(finding.abstentionReason, "async-command-origin-unresolved");
});

test("a single-file target resolves root to its directory", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const { stdout } = await run(process.execPath, [CLI_PATH, path.join(root, "screen.tsx")]);
  // SAFETY: the CLI exited successfully, so stdout is a serialized report.
  const report = JSON.parse(stdout) as { findings: { location: { file: string } }[]; root: string };

  assert.equal(report.root, root);
  assert.deepEqual(
    report.findings.map((finding) => finding.location.file),
    ["screen.tsx"],
  );
});
