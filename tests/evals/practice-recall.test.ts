import { scoreHookCases, scorePractices, scoreStateGroups } from "../../evals/runner/scoring.js";
import type { Evaluation } from "../../evals/runner/model.js";
import type { LegendPracticeFinding } from "../../src/core/types.js";
import assert from "node:assert/strict";
import { summaryLines } from "../../evals/runner/summary.js";
import test from "node:test";

const label = {
  action: "move-use-value-down",
  file: "Screen.tsx",
  line: 4,
  rationale: "A manually audited derived read belongs in a stable child.",
  target: "app",
} as const;

function evaluation(practices: LegendPracticeFinding[] = []): Evaluation {
  return {
    failures: [],
    hooks: 0,
    targets: new Map([
      [
        "app",
        {
          application: "app",
          repository: "repo",
          root: "/repo",
          report: {
            files: 1,
            findings: [],
            practices,
            hooks: { states: 0, effects: 0, total: 0 },
            capabilities: { disabledRules: [], legendState: null, reactCompiler: false },
            schemaVersion: 4,
          },
        },
      ],
    ]),
  };
}

function finding(action: LegendPracticeFinding["action"] = label.action): LegendPracticeFinding {
  return {
    action,
    confidence: "certain",
    disposition: "change",
    evidence: [],
    location: { file: label.file, line: label.line, column: 1 },
    message: "Extract the child",
    practice: "reactivity",
  };
}

test("an audited missing opportunity counts against recall without weakening enforcement", () => {
  const run = evaluation();
  const labels = [{ ...label, enforced: false }];
  const score = scorePractices(run, labels);
  assert.deepEqual(run.failures, []);
  assert.deepEqual(score, { labels: 1, matches: 0, predictions: 0, knownMisses: 1 });
  const enforced = evaluation();
  scorePractices(enforced, [label]);
  assert.equal(enforced.failures.length, 1, "ordinary missing labels must still fail");
});

test("a known miss cannot excuse a different emitted action", () => {
  const run = evaluation([finding("narrow-use-value-subscription")]);
  const labels = [{ ...label, enforced: false }];
  const score = scorePractices(run, labels);
  assert.deepEqual(score, { labels: 1, matches: 0, predictions: 1, knownMisses: 1 });
  assert.equal(run.failures.length, 1);
  assert.match(run.failures[0]!, /unexpected Legend practice narrow-use-value-subscription/u);
});

test("implementing a known opportunity improves recall automatically", () => {
  const run = evaluation([finding()]);
  const labels = [{ ...label, enforced: false }];
  assert.deepEqual(scorePractices(run, labels), {
    labels: 1,
    matches: 1,
    predictions: 1,
    knownMisses: 0,
  });
  assert.deepEqual(run.failures, []);
});

test("unscanned targets contribute neither recall labels nor known misses", () => {
  const run = evaluation();
  const labels = [{ ...label, target: "absent", enforced: false }];
  assert.deepEqual(scorePractices(run, labels), {
    labels: 0,
    matches: 0,
    predictions: 0,
    knownMisses: 0,
  });
  assert.deepEqual(run.failures, []);
});

test("the summary distinguishes perfect emitted precision from incomplete labeled recall", () => {
  const run = evaluation([finding()]);
  const labels = [label, { ...label, line: 8, enforced: false }];
  const lines = summaryLines(run, scoreHookCases(run, []), {
    groups: scoreStateGroups(run, []),
    practices: scorePractices(run, labels),
  });
  assert.ok(lines.includes("Legend practice precision: 100.0% (1/1)."));
  assert.ok(lines.includes("Legend practice recall on labeled opportunities: 50.0% (1/2)."));
  assert.ok(lines.includes("Known labeled Legend practice misses: 1."));
});
