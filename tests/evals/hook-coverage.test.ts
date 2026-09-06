import type { Evaluation } from "../../evals/runner/model.js";
import type { GoldHookCase } from "../../evals/corpus/contracts.js";
import type { HookFinding } from "../../src/core/types.js";
import assert from "node:assert/strict";
import { hookCoverage } from "../../evals/runner/hook-coverage.js";
import { scoreHookCases } from "../../evals/runner/scoring.js";
import test from "node:test";

function change(name: string, line: number): HookFinding & { action: "use-observable" } {
  return {
    action: "use-observable",
    confidence: "probable",
    disposition: "change",
    evidence: [],
    hook: "useState",
    location: { file: "Feature.tsx", line, column: 1 },
    message: "Move the subscription",
    name,
  };
}

function evaluation(findings: HookFinding[]): Evaluation {
  return {
    failures: [],
    hooks: findings.length,
    targets: new Map([
      [
        "feature",
        {
          application: "app",
          repository: "repo",
          root: "/repo/feature",
          report: {
            files: 1,
            findings,
            hooks: { states: findings.length, effects: 0, total: findings.length },
            practices: [],
            capabilities: { disabledRules: [], legendState: null, reactCompiler: false },
            schemaVersion: 3,
          },
        },
      ],
    ]),
  };
}

const label: GoldHookCase = {
  action: "use-observable",
  file: "./Feature.tsx",
  line: 1,
  hook: "useState",
  name: "open",
  rationale: "One proven presentation leaf.",
  target: "feature",
};

test("perfect labeled precision still exposes an unvalidated change at another hook", () => {
  const run = evaluation([change("open", 1), change("draft", 2)]);
  const score = scoreHookCases(run, [label]);
  assert.equal(score.correctActionable, 1);
  assert.equal(score.actualActionable, 1);
  assert.deepEqual(hookCoverage(run, [label]), {
    inventoried: 2,
    labeled: 1,
    changes: 2,
    unlabeledChanges: 1,
  });
  assert.deepEqual(
    run.failures,
    [],
    "coverage disclosure does not relabel or enforce an unknown outcome",
  );
});

test("labels match exact target, binding, and hook identity without counting absent or duplicate labels", () => {
  const run = evaluation([
    change("open", 1),
    change("another", 1),
    { ...change("idle", 3), action: "keep-state", disposition: "keep" },
  ]);
  const cases: GoldHookCase[] = [
    { ...label, action: "keep-state" },
    label,
    { ...label, name: "another", target: "other-feature" },
    { ...label, name: "another", hook: "useEffect" },
    { ...label, line: 99, name: "absent" },
  ];
  assert.deepEqual(hookCoverage(run, cases), {
    inventoried: 3,
    labeled: 1,
    changes: 2,
    unlabeledChanges: 1,
  });
  assert.deepEqual(hookCoverage(evaluation([]), cases), {
    inventoried: 0,
    labeled: 0,
    changes: 0,
    unlabeledChanges: 0,
  });
});
