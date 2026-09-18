import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const helper = `import { clsx as classes } from "clsx";
import { twMerge as merge } from "tailwind-merge";
export function project(...values: unknown[]) { return merge(classes(values)); }`;
const shell = (projection: string, parameter = "{ flag }"): string => `
import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";
import { project as combine } from "./projection";
const state$ = observable<{ open: boolean; bins: number }>({ open: false, bins: 64 });
export function Screen(${parameter}) {
  const open = useValue(state$.open);
  const raw = useValue(state$.bins); const bins = raw ?? 64;
  return <main><A/><B/><C/><D/><E/><F/><G/><H/><I/><J/><K/>
    <aside className={${projection}}/><output>{open}</output><input value={bins}/></main>;
}`;

type ProjectionCase = readonly [
  string,
  string,
  boolean,
  { parameter?: string; domain?: string; helper?: string },
];
const cases: readonly ProjectionCase[] = [
  ["independent primitive conversion", "String(bins)", true, {}],
  [
    "source-proven aliased primitive class wrapper",
    'combine("base", flag ? "on" : "off", flag && "active")',
    true,
    {},
  ],
  [
    "effectful wrapper",
    'combine("base")',
    false,
    { helper: helper.replace("return merge", "console.log(values); return merge") },
  ],
  ["shadowed wrapper", 'combine("base")', false, { parameter: "{ flag, combine }" }],
  [
    "object class argument can execute getters",
    "combine({ get active() { return hidden$.get(); } })",
    false,
    {},
  ],
  ["unknown call inside primitive branch condition", 'combine(hidden() ? "on" : "off")', false, {}],
  ["mutable snapshot hidden in a class argument", 'combine(ref.current ? "on" : "off")', false, {}],
  ["object coercion", "String(raw)", false, { domain: "{ valueOf(): number }" }],
  ["shadowed String", "String(bins)", false, { parameter: "{ flag, String }" }],
];
for (const [name, expression, expected, options] of cases) {
  test(`owner projection: ${name}`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "legend-owner-projection-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const input = shell(expression, options.parameter).replace(
      "bins: number",
      options.domain ? `bins: ${options.domain}` : "bins: number",
    );
    await writeFile(path.join(root, "Screen.tsx"), input);
    await writeFile(path.join(root, "projection.ts"), options.helper ?? helper);
    const report = await analyzePath(root);
    const line = input.split("\n").findIndex((text) => text.includes("const open =")) + 1;
    assert.equal(
      report.practices.some(
        (finding) => finding.action === "move-use-value-down" && finding.location.line === line,
      ),
      expected,
    );
  });
}
