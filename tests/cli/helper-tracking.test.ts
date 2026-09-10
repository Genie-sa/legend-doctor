import { CLI_PATH, run, writeFixtureRoot } from "./harness.js";
import { rm, writeFile } from "node:fs/promises";
import type { AnalysisReport } from "../../src/core/types.js";
import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import test from "node:test";

test("helper reviews are filterable candidates and never actionable edits", async (context) => {
  const root = await writeFixtureRoot();
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "review.tsx"),
    `
    import { observable } from "@legendapp/state";
    import { useObserveEffect } from "@legendapp/state/react";
    const state$ = observable({ trigger: 0, hidden: 0 });
    const read = () => state$.hidden.get();
    export function Screen() {
      useObserveEffect(() => { state$.trigger.get(); read(); });
      return null;
    }
  `,
  );
  const scan = async (
    flags: string[],
  ): Promise<AnalysisReport & { hidden: { practices: number } }> => {
    const { stdout } = await run(process.execPath, [CLI_PATH, root, ...flags]);
    // SAFETY: a successful CLI invocation returns the serialized report.
    return JSON.parse(stdout) as AnalysisReport & { hidden: { practices: number } };
  };
  const candidate = await scan(["--disposition", "candidate"]);
  assert.deepEqual(
    candidate.practices.map((finding) => finding.action),
    ["review-helper-tracking"],
  );
  const actionable = await scan(["--actionable"]);
  assert.equal(
    actionable.practices.some((finding) => finding.action === "review-helper-tracking"),
    false,
  );
  assert.equal(actionable.hidden.practices, 1);
  const ignored = await scan(["--ignore-action", "review-helper-tracking"]);
  assert.equal(ignored.hidden.practices, 1);
});
