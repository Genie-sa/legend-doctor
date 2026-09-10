import type { AnalysisReport, LegendPracticeFinding } from "../../src/core/types.js";
import type { Evaluation } from "../../evals/runner/model.js";
import type { GoldPracticeCase } from "../../evals/corpus/contracts.js";
import assert from "node:assert/strict";
import { scorePractices } from "../../evals/runner/scoring.js";
import test from "node:test";

function evaluation(disposition: LegendPracticeFinding["disposition"]): Evaluation {
  const report: AnalysisReport = {
    files: 1,
    capabilities: { disabledRules: [], legendState: null, reactCompiler: false },
    findings: [],
    hooks: { effects: 0, states: 0, total: 0 },
    practices: [
      {
        action: "pass-observable-to-use-value",
        confidence: "certain",
        disposition,
        evidence: [],
        location: { column: 1, file: "row.tsx", line: 7 },
        message: "Equivalent direct input",
        practice: "reactivity",
      },
    ],
    schemaVersion: 4,
  };
  return {
    failures: [],
    hooks: 0,
    targets: new Map([["app", { application: "app", repository: "app", root: "/app", report }]]),
  };
}

const gold: GoldPracticeCase = {
  action: "pass-observable-to-use-value",
  file: "row.tsx",
  line: 7,
  rationale: "Same node; no proven render saving.",
  target: "app",
};

test("practice labels reject the right action with an overstated cost disposition", () => {
  const run = evaluation("change");
  assert.deepEqual(scorePractices(run, [{ ...gold, disposition: "style" }]), {
    labels: 1,
    matches: 0,
    predictions: 1,
  });
  assert.deepEqual(run.failures, [
    "app/row.tsx:7: expected pass-observable-to-use-value disposition style, received change (Same node; no proven render saving.)",
  ]);
});

test("practice labels accept audited style and retain action-only compatibility", () => {
  for (const [disposition, label] of [
    ["style", { ...gold, disposition: "style" }],
    ["change", gold],
  ] as const) {
    const run = evaluation(disposition);
    assert.deepEqual(scorePractices(run, [label]), { labels: 1, matches: 1, predictions: 1 });
    assert.deepEqual(run.failures, []);
  }
});

test("candidate exclusion composes with an audited disposition at the same action and location", () => {
  const run = evaluation("candidate");
  assert.deepEqual(scorePractices(run, [{ ...gold, disposition: "style" }]), {
    labels: 1,
    matches: 0,
    predictions: 0,
  });
  assert.equal(run.failures.length, 1);

  run.failures.length = 0;
  const { report } = run.targets.get("app")!;
  report.practices.push({ ...report.practices[0]!, disposition: "style" });
  assert.deepEqual(scorePractices(run, [{ ...gold, disposition: "style" }]), {
    labels: 1,
    matches: 1,
    predictions: 1,
  });
  assert.deepEqual(run.failures, []);
});
