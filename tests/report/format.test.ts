import type { HookFinding } from "../../src/core/types.js";
import { agentFindings } from "../../src/report/format.js";
import assert from "node:assert/strict";
import test from "node:test";

function finding(disposition: HookFinding["disposition"]): HookFinding {
  if (disposition === "keep") {
    return stateFinding("keep-state", disposition, {
      ownership: "react",
      subscription: "owner-react",
    });
  }
  if (disposition === "change") {
    return stateFinding("use-observable", disposition, {
      ownership: "local-observable",
      subscription: "leaf-use-value",
    });
  }
  return {
    ...stateFindingBase(disposition),
    abstentionReason: "ownership-flow-unresolved",
    action: "review-state",
    stateModel: { ownership: "review", subscription: "review" },
  };
}

function stateFindingBase(
  disposition: HookFinding["disposition"],
): Omit<HookFinding, "abstentionReason" | "action"> {
  return {
    confidence: "probable",
    disposition,
    evidence: [],
    hook: "useState",
    location: { column: 1, file: "fixture.tsx", line: 1 },
    message: disposition,
    name: "value",
  };
}

function stateFinding(
  action: "keep-state" | "use-observable",
  disposition: "change" | "keep",
  stateModel: NonNullable<HookFinding["stateModel"]>,
): HookFinding {
  return { ...stateFindingBase(disposition), action, stateModel };
}

test("agent output includes answerable candidates and changes but hides keeps", () => {
  const findings = [finding("keep"), answerableReview(), finding("change")];
  assert.deepEqual(
    agentFindings(findings).map((item) => item.disposition),
    ["candidate", "change"],
  );
});

test("agent output hides a review no answer could convert", () => {
  assert.deepEqual(agentFindings([finding("candidate"), finding("change")]), [finding("change")]);
});

function answerableReview(): HookFinding {
  return {
    ...finding("candidate"),
    assumption: {
      facts: ["ownership-flow-unresolved"],
      fingerprint: "abc123",
      id: "fixture.tsx::Owner::value::ownership-flow-unresolved",
      ifConfirmed: "use-observable",
      question: "confirm every escaped consumer reads the value only after render",
      renderCost: 12,
      research: [{ check: "read the setter's callers", file: "fixture.tsx", line: 1 }],
      status: "open",
      updateSites: 1,
    },
  };
}
