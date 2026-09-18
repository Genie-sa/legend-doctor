import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

for (const [name, expression, setup] of [
  ["increment inside boolean coercion", "combine(!(counter++))", ""],
  ["assignment in conditional", 'combine((counter += 1) ? "on" : "off")', ""],
  ["getter condition", 'combine(model.flag ? "on" : "off")', ""],
  ["aliased getter condition", 'combine(active ? "on" : "off")', "const active = model.flag;"],
  ["mutable global condition", 'combine(counter ? "on" : "off")', ""],
  [
    "getter behind prop alias",
    'combine(active ? "on" : "off")',
    "const active = options?.active ?? false;",
  ],
] as const) {
  test(`class projection cannot hide ${name}`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "legend-class-evaluation-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      path.join(root, "projection.ts"),
      'import { clsx } from "clsx"; import { twMerge } from "tailwind-merge"; export function combine(...values: unknown[]) { return twMerge(clsx(values)); }',
    );
    await writeFile(
      path.join(root, "Screen.tsx"),
      `import { observable } from "@legendapp/state";
       import { useValue } from "@legendapp/state/react";
       import { combine } from "./projection";
       const state$ = observable({ open: false });
       let counter = 0;
       const model = { get flag() { return ++counter; } };
       export function Screen({ options }) {
         const open = useValue(state$.open);
         ${setup}
         return <main><A/><B/><C/><D/><E/><F/><G/><H/><I/><J/><K/>
           <aside className={${expression}}/><output>{open}</output></main>;
       }`,
    );
    const report = await analyzePath(root);
    assert.equal(
      report.practices.some((finding) => finding.action === "move-use-value-down"),
      false,
      "a primitive class result does not prove pure or stable argument evaluation",
    );
  });
}
