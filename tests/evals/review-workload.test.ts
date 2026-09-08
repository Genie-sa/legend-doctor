import type { HookFinding, StateAssumption } from "../../src/core/types.js";
import {
  groupFrontier,
  reviewWorkloadSummaryLines,
  reviewWorkloads,
} from "../../evals/runner/review-workload.js";
import type { Evaluation } from "../../evals/runner/model.js";
import assert from "node:assert/strict";
import test from "node:test";

function question(): StateAssumption {
  return {
    id: "panel::group",
    fingerprint: "source-version",
    status: "open",
    facts: ["atomic-transition-unproven"],
    ifConfirmed: "use-observable",
    question: "Confirm the complete transaction.",
    research: [],
    renderCost: 20,
    updateSites: 2,
    members: [
      { name: "value", outcome: "use-observable" },
      { name: "draft", outcome: "review-state", nextBlocker: "render-cut-unproven" },
      { name: "retained", outcome: "review-state" },
    ],
  };
}

function review(name: string, assumption?: StateAssumption): HookFinding {
  const finding: HookFinding = {
    action: "review-state",
    abstentionReason: "atomic-transition-unproven",
    confidence: "probable",
    disposition: "candidate",
    evidence: [],
    hook: "useState",
    location: { file: "panel.tsx", line: 1, column: 1 },
    message: "Review transaction",
    name,
  };
  if (assumption) {
    finding.assumption = assumption;
  }
  return finding;
}

function evaluation(targets: readonly (readonly [string, string, HookFinding[]])[]): Evaluation {
  return {
    failures: [],
    hooks: 0,
    targets: new Map(
      targets.map(([id, application, findings]) => [
        id,
        {
          application,
          repository: application,
          root: `/${application}/${id}`,
          report: {
            files: 1,
            schemaVersion: 4,
            findings,
            practices: [],
            hooks: { states: findings.length, effects: 0, total: findings.length },
            capabilities: { disabledRules: [], legendState: null, reactCompiler: false },
          },
        },
      ]),
    ),
  };
}

test("a repeated group question counts once without treating blocked members as conversions", () => {
  const shared = question();
  const run = evaluation([["target", "app", [review("value", shared), review("draft", shared)]]]);
  const before = JSON.stringify([...run.targets]);
  const { total } = reviewWorkloads(run);
  const frontier = groupFrontier(total);
  assert.equal(total.reviews, 2);
  assert.equal(total.openFindings, 2);
  assert.equal(total.questions.size, 1);
  assert.equal(frontier.groups, 1);
  assert.equal(frontier.converting, 1);
  assert.equal(frontier.remaining, 2);
  assert.deepEqual([...frontier.nextBlockers], [["render-cut-unproven", 1]]);
  assert.equal(
    JSON.stringify([...run.targets]),
    before,
    "measurement cannot answer questions or mutate findings",
  );
});

test("question identity cannot leak across target scopes or source versions", () => {
  const run = evaluation([
    [
      "first",
      "app",
      [review("value", question()), review("draft", { ...question(), fingerprint: "changed" })],
    ],
    ["second", "app", [review("value", question())]],
  ]);
  assert.equal(reviewWorkloads(run).total.questions.size, 3);
});

test("dependencies, inactive answers, unassisted findings and zero-review apps stay distinct", () => {
  const keep: HookFinding = {
    action: "keep-state",
    disposition: "keep",
    confidence: "certain",
    evidence: [],
    hook: "useState",
    location: { file: "small.tsx", line: 1, column: 1 },
    message: "Keep the cohesive owner",
    name: "retained",
  };
  const run = evaluation([
    [
      "reviews",
      "zeta",
      [
        review("open", question()),
        review("stale", { ...question(), status: "stale" }),
        review("rejected", { ...question(), status: "rejected" }),
        { ...review("effect"), waitsOn: ["panel::group"] },
        review("unknown"),
      ],
    ],
    ["kept", "alpha", [keep]],
  ]);
  const { total, byApplication } = reviewWorkloads(run);
  assert.equal(total.reviews, 5);
  assert.equal(total.questions.size, 1);
  assert.equal(total.openFindings, 1);
  assert.equal(total.inactiveFindings, 2);
  assert.equal(total.dependentFindings, 1);
  assert.equal(total.unassistedFindings, 1);
  assert.equal(byApplication.get("alpha")?.reviews, 0);
  const lines = reviewWorkloadSummaryLines(run);
  assert.ok(lines[1]?.startsWith("App review workload [alpha]: 0 reviews;"));
  assert.ok(lines.at(-2)?.includes("These are not proven migrations."));
});
