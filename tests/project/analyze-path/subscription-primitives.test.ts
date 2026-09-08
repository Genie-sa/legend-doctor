import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const screen = `import { useValue } from "@legendapp/state/react";
import { state$ } from "./state";
export function Screen() {
  const stored = useValue(state$.bins); const bins = stored ?? 64;
  return <main><A/><B/><C/><D/><E/><F/><G/><H/><I/><J/><K/>
    <output>{bins}</output><input value={String(bins)}/></main>;
}`;

test("primitive coercion follows only a factory's direct Observable<T> return", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-primitive-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "Screen.tsx"), screen);
  await writeFile(
    path.join(root, "state.ts"),
    `import { make } from "./factory";
    export const state$ = make<{ bins: number }>({ bins: 64 });`,
  );
  for (const [result, body, expected] of [
    ["Observable<T>", "observable(value)", 1],
    ["Observable<{ bins: T }>", "observable({ bins: value })", 0],
  ] as const) {
    await writeFile(
      path.join(root, "factory.ts"),
      `import { observable, type Observable } from "@legendapp/state";
      export function make<T>(value: T): ${result} { return ${body}; }`,
    );
    const report = await analyzePath(root);
    assert.equal(
      report.practices.filter((finding) => finding.action === "move-use-value-down").length,
      expected,
    );
  }
});
