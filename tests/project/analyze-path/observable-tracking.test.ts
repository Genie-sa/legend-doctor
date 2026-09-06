import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("proves untracked render reads and eager reactive inputs through imported observables", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-tracking-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "store.ts"),
    `
      import { observable } from "@legendapp/state";
      export const state$ = observable({ ready: false, count: 0 });
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "screen.tsx"),
    `
      import { Show, observer } from "@legendapp/state/react";
      import { state$ } from "./store";
      export function Screen() {
        const count = state$.count.get();
        return <Show if={state$.ready.get()}>{() => <b>{count}</b>}</Show>;
      }
      export const Tracked = observer(function Tracked() {
        return <b>{state$.count.get()}</b>;
      });
    `,
    "utf8",
  );

  const report = await analyzePath(root);

  assert.deepEqual(
    report.practices.map((practice) => [
      practice.location.file,
      practice.location.line,
      practice.action,
    ]),
    [
      ["screen.tsx", 5, "use-value-for-render-read"],
      ["screen.tsx", 6, "pass-observable-to-reactive-input"],
    ],
  );
  assert.deepEqual(report.capabilities.disabledRules, []);
});
