import type { Evaluation } from "../../evals/runner/model.js";
import type { LegendPracticeFinding } from "../../src/core/types.js";
import assert from "node:assert/strict";
import { practiceReviewLines } from "../../evals/runner/summary.js";
import { scorePractices } from "../../evals/runner/scoring.js";
import test from "node:test";

function evaluation(practices: LegendPracticeFinding[]): Evaluation {
  return {
    failures: [],
    hooks: 0,
    targets: new Map([
      [
        "feature",
        {
          application: "app",
          repository: "repo",
          root: "/repo/feature",
          report: {
            schemaVersion: 4,
            files: 1,
            hooks: { total: 0, states: 0, effects: 0 },
            findings: [],
            practices,
            capabilities: { disabledRules: [], legendState: null, reactCompiler: false },
          },
        },
      ],
    ]),
  };
}
const review: LegendPracticeFinding = {
  action: "review-helper-tracking",
  disposition: "candidate",
  confidence: "probable",
  evidence: [],
  location: { file: "screen.tsx", line: 4, column: 1 },
  message: "Review trigger intent",
  practice: "reactivity",
};

test("candidate reviews remain visible without inflating optimization precision", () => {
  const run = evaluation([review]);
  assert.deepEqual(scorePractices(run, []), { labels: 0, matches: 0, predictions: 0 });
  assert.deepEqual(run.failures, []);
  assert.deepEqual(practiceReviewLines(run), [
    "Candidate Legend practices: 1 (not precision-scored).",
    "Unscored practice review [feature/screen.tsx:4]: review-helper-tracking",
  ]);
});

test("a candidate cannot satisfy a labeled optimization or hide an unexpected change", () => {
  const run = evaluation([
    review,
    { ...review, action: "use-peek-for-snapshot", disposition: "change" },
  ]);
  assert.deepEqual(
    scorePractices(run, [
      {
        action: review.action,
        file: "screen.tsx",
        line: 4,
        rationale: "hypothetical enforced edit",
        target: "feature",
      },
    ]),
    { labels: 1, matches: 0, predictions: 1 },
  );
  assert.equal(run.failures.length, 2);
  assert.match(run.failures[0]!, /expected review-helper-tracking/u);
  assert.match(run.failures[1]!, /unexpected Legend practice use-peek-for-snapshot/u);
});
