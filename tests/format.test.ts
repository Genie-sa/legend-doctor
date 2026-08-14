import assert from "node:assert/strict";
import test from "node:test";

import { agentFindings } from "../src/format.js";
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
