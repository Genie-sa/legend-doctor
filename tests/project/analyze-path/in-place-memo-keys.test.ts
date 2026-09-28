import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { LegendPracticeFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

const STORE = `
  import { observable } from "@legendapp/state";
  export const tabs$ = observable({ order: [] as string[], active: "" });
`;

const COMPONENT = `
  import { useMemo } from "react";
  import { useValue } from "@legendapp/state/react";
  import { tabs$ } from "./state/tabs";
  export function TabStrip() {
    const order = useValue(tabs$.order);
    const labels = useMemo(() => order.map((id) => id.toUpperCase()), [order]);
    return <nav>{labels.join(" ")}</nav>;
  }
`;

async function snapshotFindings(writer: string): Promise<LegendPracticeFinding[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-in-place-memo-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(path.join(root, "state", "tabs.ts"), STORE, "utf8");
    await writeFile(path.join(root, "state", "actions.ts"), writer, "utf8");
    await writeFile(path.join(root, "tab-strip.tsx"), COMPONENT, "utf8");
    const report = await analyzePath(root);
    return report.practices.filter((finding) => finding.action === "snapshot-mutated-use-value");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("proves a stale memo from an in-place write in another module", async () => {
  const [finding, ...rest] = await snapshotFindings(`
    import { tabs$ } from "./tabs";
    export function openTab(id: string) {
      tabs$.order.push(id);
    }
  `);
  assert.deepEqual(rest, []);
  const proven = requireValue(finding);
  assert.equal(proven.disposition, "change");
  assert.equal(proven.location.file, "tab-strip.tsx");
  assert.match(proven.message, /in-place write at state\/actions\.ts:4 \(`push`\)/u);
  assert.match(proven.message, /`useValue\(\(\) => \[\.\.\.tabs\$\.order\.get\(\)\]\)`/u);
});

test("ignores writes through a module-local binding that shadows the imported root", async () => {
  assert.deepEqual(
    await snapshotFindings(`
      import { observable } from "@legendapp/state";
      const tabs$ = observable({ order: [] as string[] });
      export function openTab(id: string) {
        tabs$.order.push(id);
      }
    `),
    [],
  );
});

test("ignores modules that only replace the imported array", async () => {
  assert.deepEqual(
    await snapshotFindings(`
      import { tabs$ } from "./tabs";
      export function openTab(id: string) {
        tabs$.order.set((order) => [...order, id]);
      }
    `),
    [],
  );
});
