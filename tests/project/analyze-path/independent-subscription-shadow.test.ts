import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

for (const binding of ["raw", "alias"]) {
  test(`independent primitive proof does not cross shadowed ${binding}`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "legend-independent-shadow-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const source = `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";
const state$ = observable<{ open: boolean; number: number }>({open: false, number: 1});
let calls = 0;
export function Screen() {
  const open = useValue(state$.open);
  const raw = useValue(state$.number);
  const alias = raw ?? 0;
  let slot;
  { const ${binding} = { toString() { calls++; return String(calls); } };
    slot = <aside>{String(${binding})}</aside>; }
  return <main><A/><B/><C/><D/><E/><F/><G/><H/><I/><J/><K/>
    {slot}<output>{open}</output><input value={alias}/></main>;
}`;
    await writeFile(path.join(root, "Screen.tsx"), source);
    const report = await analyzePath(root);
    assert.equal(
      report.practices.some(
        (finding) => finding.action === "move-use-value-down" && finding.location.line === 6,
      ),
      false,
    );
  });
}
