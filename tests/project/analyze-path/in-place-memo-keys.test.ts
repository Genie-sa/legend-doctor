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

interface WriterPlacement {
  /** Directories above the scanned root, whose names say nothing about the app's own files. */
  readonly parent?: string;
  readonly writerFile?: string;
}

async function snapshotFindings(
  writer: string,
  { parent = "", writerFile = "state/actions.ts" }: WriterPlacement = {},
): Promise<LegendPracticeFinding[]> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-in-place-memo-"));
  const root = path.join(scratch, parent);
  try {
    await mkdir(path.join(root, path.dirname(writerFile)), { recursive: true });
    await writeFile(path.join(root, "state", "tabs.ts"), STORE, "utf8");
    await writeFile(path.join(root, writerFile), writer, "utf8");
    await writeFile(path.join(root, "tab-strip.tsx"), COMPONENT, "utf8");
    const report = await analyzePath(root);
    return report.practices.filter((finding) => finding.action === "snapshot-mutated-use-value");
  } finally {
    await rm(scratch, { force: true, recursive: true });
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

test("ignores in-place writes that only tests, stories, and demos run", async () => {
  const writer = `
    import { tabs$ } from "../tabs";
    export function openTab(id: string) {
      tabs$.order.push(id);
    }
  `;
  for (const harness of [
    "state/__tests__/tabs.ts",
    "state/fixtures/tabs.test.ts",
    "state/stories/tabs.ts",
  ]) {
    assert.deepEqual(await snapshotFindings(writer, { writerFile: harness }), [], harness);
  }
});

test("keeps production writes in an app checked out under a demos directory", async () => {
  const findings = await snapshotFindings(
    `
      import { tabs$ } from "./tabs";
      export function openTab(id: string) {
        tabs$.order.push(id);
      }
    `,
    { parent: "demos/tabs-app" },
  );
  assert.equal(findings.length, 1);
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
