import { CLI_PATH, run, runExpectingFailure, writeFixtureRoot } from "./harness.js";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import type { AnalysisReport } from "../../src/core/types.js";
import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const CONFIG_FILE_NAME = "legend-doctor.config.json";

type CliReport = AnalysisReport & { hidden: { findings: number; practices: number } };

async function scan(root: string, ...flags: string[]): Promise<CliReport> {
  const { stdout } = await run(process.execPath, [CLI_PATH, root, ...flags]);
  // SAFETY: the CLI exited successfully, so stdout is the serialized CLI report.
  return JSON.parse(stdout) as CliReport;
}

test("legend-doctor.config.json in the target hides its ignoreActions", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));
  const before = await scan(root);

  await writeFile(
    path.join(root, CONFIG_FILE_NAME),
    JSON.stringify({ ignoreActions: ["assign-observable-fields"] }),
    "utf8",
  );
  const report = await scan(root);

  assert.equal(
    before.practices.some((practice) => practice.action === "assign-observable-fields"),
    true,
  );
  assert.equal(
    report.practices.some((practice) => practice.action === "assign-observable-fields"),
    false,
  );
  assert.equal(report.hidden.practices, before.practices.length - report.practices.length);
});

test("the nearest config above the target applies and --ignore-action adds to it", async (testContext) => {
  const parent = await writeFixtureRoot();
  testContext.after(() => rm(parent, { force: true, recursive: true }));
  const root = path.join(parent, "app");
  await mkdir(root);
  for (const file of await readdir(parent)) {
    if (file !== "app") {
      await rename(path.join(parent, file), path.join(root, file));
    }
  }
  await writeFile(
    path.join(parent, CONFIG_FILE_NAME),
    JSON.stringify({ ignoreActions: ["assign-observable-fields"], materiality: "compact" }),
    "utf8",
  );

  const fromConfig = await scan(root);
  assert.equal(
    fromConfig.practices.some((practice) => practice.action === "assign-observable-fields"),
    false,
  );

  const withFlag = await scan(root, "--ignore-action", "keep-state");
  assert.equal(
    withFlag.findings.some((finding) => finding.action === "keep-state"),
    false,
  );
  assert.equal(
    withFlag.practices.some((practice) => practice.action === "assign-observable-fields"),
    false,
  );
});

test("an invalid config is a usage error that names the file", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, CONFIG_FILE_NAME), JSON.stringify({ rules: {} }), "utf8");

  const failure = await runExpectingFailure([root]);

  assert.equal(failure.code, 2);
  // SAFETY: a usage error exits 2 and writes the CliFailure payload as the only stdout document.
  const payload = JSON.parse(failure.stdout) as { message: string; reason: string };
  assert.equal(payload.reason, "invalid_usage");
  assert.match(payload.message, /legend-doctor\.config\.json: unknown key 'rules'/u);
});
