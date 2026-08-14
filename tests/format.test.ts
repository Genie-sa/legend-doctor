import assert from "node:assert/strict";
import test from "node:test";

import { agentFindings, formatTextReport } from "../src/format.js";
import type { HookFinding } from "../src/types.js";

function finding(disposition: HookFinding["disposition"]): HookFinding {
  return {
    action: disposition === "keep" ? "keep-state" : "review-state",
    confidence: "probable",
    disposition,
    evidence: [],
    hook: "useState",
    location: { column: 1, file: "fixture.tsx", line: 1 },
    message: disposition,
    name: "value",
    stateModel: { ownership: "review", subscription: "review" },
  };
}

test("agent output includes candidates and changes but hides keeps", () => {
  const findings = [finding("keep"), finding("candidate"), finding("change")];
  assert.deepEqual(agentFindings(findings).map(item => item.disposition), ["candidate", "change"]);
});

test("text output includes Legend practice findings", () => {
  const output = formatTextReport({
    files: 1,
    findings: [],
    hooks: { effects: 0, states: 0, total: 0 },
    practices: [{
      action: "batch-observable-writes",
      confidence: "probable",
      disposition: "change",
      evidence: [],
      location: { column: 3, file: "store.ts", line: 8 },
      message: "Batch these writes.",
      practice: "batch",
    }],
  }, true);
  assert.match(output, /store\.ts:8:3 \[batch-observable-writes\]/);
  assert.match(output, /1 shown/);
});
