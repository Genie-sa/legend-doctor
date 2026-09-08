import { functionAndCalls, requireCall } from "./state-flow-harness.js";
import { StateFlowIndex } from "../../src/project/state-flow/state-flow.js";
import assert from "node:assert/strict";
import test from "node:test";

// Risk: unrelated later work hides a completed transition; trimming too far can instead
// Erase a suspension, an unreachable write, or an unsupported path before that transition.
for (const [body, expected] of [
  ['setName("Ada"); setOpen(true); for (const item of items) work(item);', "proven"],
  [
    'if (!enabled) return; setName("Ada"); setOpen(true); try { await work(); } finally { for (;;) break; }',
    "proven",
  ],
  ['setName("Ada"); await work(); setOpen(true); for (;;) break;', "disproven"],
  ['setName("Ada"); return; setOpen(true); for (;;) break;', "disproven"],
  ['setName("Ada"); throw Error(); setOpen(true); for (;;) break;', "disproven"],
  ['for (const item of items) work(item); setName("Ada"); setOpen(true);', "unknown"],
  [
    'if (enabled) return; if (enabled) { setName("Ada"); setOpen(true); } for (;;) break;',
    "unknown",
  ],
  // The work() call can throw before suspension, so a synchronous exceptional path exists.
  ['setName("Ada"); try { await work(); } finally { setOpen(true); }', "proven"],
]) {
  test(`keeps the relevant execution prefix: ${body}`, () => {
    const { calls, fn } = functionAndCalls(`async function run() { ${body} }`);
    const flow = new StateFlowIndex();
    const left = requireCall(calls, "setName");
    const right = requireCall(calls, "setOpen");
    assert.equal(flow.proveSynchronousCoexecution(fn, left, right), expected);
    assert.equal(flow.proveSynchronousCoexecution(fn, right, left), expected);
  });
}
