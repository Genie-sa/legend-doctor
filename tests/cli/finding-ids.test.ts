import { CLI_PATH, run } from "./harness.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

interface IdentifiedFinding {
  readonly id: string;
  readonly location: { readonly line: number };
}

interface ScanReport {
  readonly findings: readonly IdentifiedFinding[];
}

const COMPONENTS = `
  import { useEffect, useState } from "react";
  export function Clock() {
    useEffect(() => {
      const timer = setInterval(() => {}, 1000);
      return () => clearInterval(timer);
    }, []);
    useEffect(() => {
      const timer = setInterval(() => {}, 5000);
      return () => clearInterval(timer);
    }, []);
    return null;
  }
  export default function () {
    const [open, setOpen] = useState(false);
    return <button onClick={() => setOpen(!open)}>{String(open)}</button>;
  }
`;

const UNRELATED_PREFIX = `
  export const VERSION = "1";
  export function banner(): string {
    return VERSION;
  }
`;

async function scanIds(root: string, source: string): Promise<readonly string[]> {
  await writeFile(path.join(root, "clock.tsx"), source, "utf8");
  const { stdout } = await run(process.execPath, [CLI_PATH, root]);
  // SAFETY: the CLI exited successfully, so stdout is a serialized report.
  const report = JSON.parse(stdout) as ScanReport;
  return report.findings
    .toSorted((left, right) => left.location.line - right.location.line)
    .map(({ id }) => id);
}

test("finding ids name their owner, number repeats, and survive edits elsewhere in the file", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-ids-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const before = await scanIds(root, COMPONENTS);
  const after = await scanIds(root, `${UNRELATED_PREFIX}${COMPONENTS}`);

  assert.deepEqual(before, [
    "clock.tsx::Clock::useEffect::keep-effect",
    "clock.tsx::Clock::useEffect::keep-effect#2",
    "clock.tsx::default::open::keep-state",
  ]);
  assert.deepEqual(after, before);
});
