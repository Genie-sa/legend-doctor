import type {
  AbstentionReason,
  AnalysisReport,
  HookAction,
  HookFinding,
} from "../../src/core/types.js";
import { abstentionSummaryLines, countAbstentions } from "../../evals/runner/abstentions.js";
import type { Evaluation } from "../../evals/runner/model.js";
import type { GoldHookCase } from "../../evals/corpus/contracts.js";
import assert from "node:assert/strict";
import { scoreHookCases } from "../../evals/runner/scoring.js";
import { summaryLines } from "../../evals/runner/summary.js";
import test from "node:test";

function finding(
  action: "review-effect" | "review-state",
  line: number,
  reason: AbstentionReason,
): HookFinding;
function finding(
  action: Exclude<HookAction, "review-effect" | "review-state">,
  line: number,
): HookFinding;
function finding(
  action: HookAction,
  line: number,
  abstentionReason?: AbstentionReason,
): HookFinding {
  const base: Omit<HookFinding, "abstentionReason" | "action"> = {
    confidence: "probable",
    disposition: action.startsWith("review-") ? "candidate" : "keep",
    evidence: [],
    hook: action.endsWith("effect") ? "useEffect" : "useState",
    location: { column: 1, file: "fixture.tsx", line },
    message: action,
    name: action.endsWith("effect") ? null : `value${line}`,
  };
  if (action === "review-state" || action === "review-effect") {
    if (abstentionReason === undefined) {
      throw new Error("Review fixtures require an abstention reason.");
    }
    return { ...base, action, abstentionReason };
  }
  return { ...base, action };
}

function report(findings: HookFinding[]): AnalysisReport {
  const effects = findings.filter(({ hook }) => hook === "useEffect").length;
  const states = findings.length - effects;
  return {
    files: 1,
    capabilities: { disabledRules: [], legendState: null, reactCompiler: false },
    findings,
    hooks: { effects, states, total: findings.length },
    practices: [],
    schemaVersion: 4,
  };
}

function evaluation(
  targets: readonly (readonly [
    target: string,
    application: string,
    repository: string,
    findings: HookFinding[],
  ])[],
): Evaluation {
  return {
    failures: [],
    hooks: targets.reduce((total, target) => total + target[3].length, 0),
    targets: new Map(
      targets.map(([target, application, repository, findings]) => [
        target,
        { application, report: report(findings), repository, root: `/${repository}/${target}` },
      ]),
    ),
  };
}

test("reports deterministic global and per-app abstention histograms without changing actions", () => {
  const run = evaluation([
    [
      "zeta-target",
      "shared-app",
      "zeta",
      [
        finding("review-effect", 1, "effect-causal-owner-unresolved"),
        finding("review-state", 2, "callback-timing-unresolved"),
        finding("keep-state", 3),
      ],
    ],
    [
      "alpha-target",
      "shared-app",
      "alpha",
      [finding("review-state", 1, "callback-timing-unresolved")],
    ],
    ["zero-target", "zero-app", "zero", [finding("keep-effect", 1)]],
  ]);
  const actionsBefore = [...run.targets.values()].flatMap(({ report: targetReport }) =>
    targetReport.findings.map(({ action }) => action),
  );

  const counts = countAbstentions(run);

  assert.equal(counts.total, 3);
  assert.deepEqual(Object.fromEntries(counts.byReason), {
    "callback-timing-unresolved": 2,
    "effect-causal-owner-unresolved": 1,
  });
  assert.deepEqual(
    [...counts.byApplication].map(([application, applicationCounts]) => [
      application,
      Object.fromEntries(applicationCounts),
    ]),
    [
      [
        "shared-app",
        {
          "callback-timing-unresolved": 2,
          "effect-causal-owner-unresolved": 1,
        },
      ],
      ["zero-app", {}],
    ],
  );
  const expectedSummary = [
    "Abstentions: 3 (callback-timing-unresolved: 2, effect-causal-owner-unresolved: 1).",
    "App abstentions [shared-app]: 3 (callback-timing-unresolved: 2, effect-causal-owner-unresolved: 1).",
    "App abstentions [zero-app]: 0.",
  ];
  assert.deepEqual(abstentionSummaryLines(run), expectedSummary);
  assert.deepEqual(
    summaryLines(
      run,
      {
        actualActionable: 0,
        byAction: new Map(),
        correctActionable: 0,
        expectedActionable: 0,
        assumptions: { labeled: 0, matched: 0 },
        knownMisses: 0,
        labeled: 0,
        matched: 0,
      },
      {
        groups: { labels: 0, matches: 0, predictions: 0 },
        practices: { labels: 0, matches: 0, predictions: 0, knownMisses: 0 },
      },
    ).slice(4, 4 + expectedSummary.length),
    expectedSummary,
  );
  assert.deepEqual(
    [...run.targets.values()].flatMap(({ report: targetReport }) =>
      targetReport.findings.map(({ action }) => action),
    ),
    actionsBefore,
  );
});

test("an explicit gold abstention reason is enforced without changing action scoring", () => {
  const run = evaluation([
    [
      "fixture-target",
      "fixture-app",
      "fixture-repository",
      [finding("review-state", 7, "effect-causal-owner-unresolved")],
    ],
  ]);
  const gold = {
    abstentionReason: "callback-timing-unresolved",
    action: "review-state",
    file: "fixture.tsx",
    hook: "useState",
    line: 7,
    name: "value7",
    rationale: "The callback timing is unresolved.",
    target: "fixture-target",
  } as const satisfies GoldHookCase;

  const score = scoreHookCases(run, [gold]);

  assert.deepEqual(score, {
    actualActionable: 0,
    byAction: new Map(),
    correctActionable: 0,
    expectedActionable: 0,
    assumptions: { labeled: 0, matched: 0 },
    knownMisses: 0,
    labeled: 1,
    matched: 1,
  });
  assert.deepEqual(run.failures, [
    "fixture-target/fixture.tsx:7: expected abstention reason callback-timing-unresolved, received effect-causal-owner-unresolved (The callback timing is unresolved.)",
  ]);
});
