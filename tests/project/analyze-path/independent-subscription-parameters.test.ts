import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("independent numeric formatting cannot skip an owner's parameter clock", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-parameter-clock-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
import {observable} from "@legendapp/state";
import {useValue} from "@legendapp/state/react";
const state$=observable({open:false, count:1});
export function Screen({stamp=Date.now()}) {
  const open=useValue(state$.open);
  const count=useValue(state$.count);
  return <main><A/><B/><C/><D/><E/><F/><G/><H/><I/><J/><K/>
    <aside>{String(count)}</aside><time>{stamp}</time><output>{open}</output></main>;
}`,
  );
  const report = await analyzePath(root);
  assert.equal(
    report.practices.some(
      (finding) =>
        finding.action === "move-use-value-down" && finding.subscription?.binding === "open",
    ),
    false,
  );
});
