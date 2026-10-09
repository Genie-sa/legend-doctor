import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "action",
  "render-summary.mjs",
);

const FAILED_SCAN = {
  message: "a scan-wide failure",
  reason: "scan_failed",
  schemaVersion: 7,
  status: "error",
};

const SCAN_WITH_SKIPPED_FILE = {
  analyzer: { build: "test", version: "0.0.0" },
  files: 1,
  findings: [],
  practices: [],
  schemaVersion: 7,
  skippedFiles: [
    {
      file: "src/generated.ts",
      message: "Maximum call stack size exceeded",
      phase: "parse",
    },
  ],
  status: "ok",
};

type ReportFixture = typeof FAILED_SCAN | typeof SCAN_WITH_SKIPPED_FILE;

interface RenderedSummary {
  readonly comment: string;
  readonly outputs: ReadonlyMap<string, string>;
}

async function renderSummary(
  report: ReportFixture,
  blocking: string,
  testContext: test.TestContext,
): Promise<RenderedSummary> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-action-"));
  testContext.after(() => rm(directory, { force: true, recursive: true }));
  const headReport = path.join(directory, "head.json");
  const outputFile = path.join(directory, "outputs.txt");
  await writeFile(headReport, JSON.stringify(report), "utf8");
  await writeFile(outputFile, "", "utf8");
  await run(process.execPath, [SCRIPT_PATH], {
    env: {
      ...process.env,
      BLOCKING: blocking,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: "",
      HEAD_REPORT: headReport,
      OUT_DIR: directory,
    },
  });
  const outputs = parseOutputs(await readFile(outputFile, "utf8"));
  const comment = await readFile(path.join(directory, "legend-doctor-comment.md"), "utf8");
  return { comment, outputs };
}

/** Reads `$GITHUB_OUTPUT` the way the runner does: the last value written for a name wins. */
function parseOutputs(text: string): ReadonlyMap<string, string> {
  const outputs = new Map<string, string>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heredoc = /^(?<name>[^=<]+)<<(?<delimiter>.+)$/u.exec(line)?.groups;
    if (heredoc?.name && heredoc.delimiter) {
      const end = lines.indexOf(heredoc.delimiter, index + 1);
      outputs.set(heredoc.name, lines.slice(index + 1, end).join("\n"));
      index = end;
    } else if (line.includes("=")) {
      outputs.set(line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1));
    }
  }
  return outputs;
}

test("an advisory check reports a failed scan without failing the job", async (testContext) => {
  const { outputs } = await renderSummary(FAILED_SCAN, "none", testContext);

  assert.equal(outputs.get("gate-failed"), "false");
  assert.equal(outputs.get("status-state"), "error");
});

test("a blocking check fails closed on a failed scan", async (testContext) => {
  const { outputs } = await renderSummary(FAILED_SCAN, "change", testContext);

  assert.equal(outputs.get("gate-failed"), "true");
});

test("skipped files are listed, and only a blocking check fails on them", async (testContext) => {
  const advisory = await renderSummary(SCAN_WITH_SKIPPED_FILE, "none", testContext);
  const blocking = await renderSummary(SCAN_WITH_SKIPPED_FILE, "change", testContext);

  assert.match(advisory.comment, /1 file\(s\) could not be scanned/u);
  assert.match(advisory.comment, /`src\/generated\.ts` \(parse\)/u);
  assert.equal(advisory.outputs.get("gate-failed"), "false");
  assert.equal(blocking.outputs.get("gate-failed"), "true");
  assert.match(blocking.outputs.get("gate-reason") ?? "", /src\/generated\.ts/u);
});

test("a skipped path cannot inject an output that reopens a blocking gate", async (testContext) => {
  const injected = {
    ...SCAN_WITH_SKIPPED_FILE,
    skippedFiles: [{ file: "src/x.ts\ngate-failed=false", message: "boom", phase: "parse" }],
  };

  const { comment, outputs } = await renderSummary(injected, "change", testContext);

  assert.equal(outputs.get("gate-failed"), "true");
  assert.match(comment, /`src\/x\.ts gate-failed=false` \(parse\)/u);
});
