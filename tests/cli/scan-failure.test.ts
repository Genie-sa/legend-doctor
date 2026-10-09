import { CLI_PATH, run, writeFixtureRoot } from "./harness.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const OVERFLOWING_CHAIN_TERMS = 10_000;
const OVERFLOWING_CALL_DEPTH = 10_000;

interface ScannedFinding {
  action: string;
  disposition: string;
  location: { file: string };
  name?: string;
}

interface ScanReport {
  findings: ScannedFinding[];
  skippedFiles?: { file: string; message: string; phase: string }[];
  status: string;
}

async function scan(root: string): Promise<ScanReport> {
  const { stdout } = await run(process.execPath, [CLI_PATH, root]);
  // SAFETY: the CLI exited successfully, so stdout is a serialized report.
  return JSON.parse(stdout) as ScanReport;
}

function deeplyNestedCall(): string {
  return `${"wrap(".repeat(OVERFLOWING_CALL_DEPTH)}0${")".repeat(OVERFLOWING_CALL_DEPTH)}`;
}

test("a file that throws during analysis is skipped while every other file still reports", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));
  const chain = Array.from({ length: OVERFLOWING_CHAIN_TERMS }, () => "open").join(" && ");
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "deep.tsx"),
    `
      import { useState } from "react";
      export function Deep() {
        const [open, setOpen] = useState(false);
        return <button onClick={() => setOpen(true)}>{String(${chain})}</button>;
      }
    `,
    "utf8",
  );

  const report = await scan(root);

  assert.equal(report.status, "ok");
  assert.deepEqual(
    report.skippedFiles?.map(({ file, phase }) => ({ file, phase })),
    [{ file: path.join("src", "deep.tsx"), phase: "analyze" }],
  );
  assert.match(report.skippedFiles?.[0]?.message ?? "", /Maximum call stack size exceeded/u);
  assert.ok(report.findings.some((finding) => finding.location.file === "screen.tsx"));
  assert.ok(report.findings.every((finding) => !finding.location.file.includes("deep")));
});

test("a file the parser cannot read is skipped in the parse phase", async (testContext) => {
  const root = await writeFixtureRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "generated.ts"),
    `const wrap = (value: number): number => value;\nexport const total = ${deeplyNestedCall()};\n`,
    "utf8",
  );

  const report = await scan(root);

  assert.equal(report.status, "ok");
  assert.deepEqual(
    report.skippedFiles?.map(({ file, phase }) => ({ file, phase })),
    [{ file: "generated.ts", phase: "parse" }],
  );
  assert.ok(report.findings.some((finding) => finding.location.file === "screen.tsx"));
});

test("a skipped child proves nothing for its parent, exactly like a missing one", async (testContext) => {
  const parent = `
    import { useState } from "react";
    import { Child } from "./child";
    export function Parent() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button onClick={() => setOpen(!open)}>toggle</button>
          <Child open={open} />
        </div>
      );
    }
  `;
  const skippedRoot = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-skipped-child-"));
  const missingRoot = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-missing-child-"));
  testContext.after(async () => {
    await rm(skippedRoot, { force: true, recursive: true });
    await rm(missingRoot, { force: true, recursive: true });
  });
  await writeFile(path.join(skippedRoot, "parent.tsx"), parent, "utf8");
  await writeFile(path.join(missingRoot, "parent.tsx"), parent, "utf8");
  await writeFile(
    path.join(skippedRoot, "child.tsx"),
    `
      const wrap = (value: number): number => value;
      export const depth = ${deeplyNestedCall()};
      export function Child({ open }: { open: boolean }) {
        return <span>{open ? "on" : "off"}</span>;
      }
    `,
    "utf8",
  );

  const skipped = await scan(skippedRoot);
  const missing = await scan(missingRoot);

  assert.deepEqual(
    skipped.skippedFiles?.map((file) => file.phase),
    ["parse"],
  );
  const verdicts = (report: ScanReport): unknown[] =>
    report.findings.map(({ action, disposition, name }) => ({
      action,
      disposition,
      name,
    }));
  assert.deepEqual(verdicts(skipped), verdicts(missing));
});
