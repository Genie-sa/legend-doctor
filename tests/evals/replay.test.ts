import type {
  AnalysisReport,
  HookAction,
  HookFinding,
  LegendPracticeFinding,
} from "../../src/core/types.js";
import type { ReplayCase, ReplayCommit } from "../../evals/corpus/contracts.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { labelDrift, scoreReplayCase } from "../../evals/runner/replay-scoring.js";
import type { ReplayOutcome } from "../../evals/runner/replay-scoring.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { replayExpertCommits } from "../../evals/runner/replay.js";
import { replaySummaryLines } from "../../evals/runner/replay-summary.js";
import test from "node:test";
import { withCommitTree } from "../../evals/runner/commit-tree.js";

const commit: ReplayCommit = {
  cases: [],
  commit: "1234567890abcdef1234567890abcdef12345678",
  parent: "abcdef1234567890abcdef1234567890abcdef12",
  repository: "app",
  root: "src",
};

const enforced: ReplayCase = {
  action: "use-unmount",
  expected: "enforced",
  file: "button.tsx",
  line: 9,
  rationale: "Teardown only.",
  source: "useEffect(",
};

type ProvenHookAction = Exclude<HookAction, "review-effect" | "review-state">;

function hookFinding(
  action: ProvenHookAction,
  disposition: HookFinding["disposition"],
  line = 9,
): HookFinding {
  return {
    action,
    confidence: "probable",
    disposition,
    evidence: [],
    hook: "useEffect",
    location: { column: 3, file: "button.tsx", line },
    message: "",
    name: null,
  };
}

function flags(findings: HookFinding[], replayCase: ReplayCase = enforced): boolean {
  return scoreReplayCase(report(findings), commit, replayCase).flagged;
}

function practiceFinding(
  action: LegendPracticeFinding["action"],
  disposition: LegendPracticeFinding["disposition"],
): LegendPracticeFinding {
  return {
    action,
    confidence: "certain",
    disposition,
    evidence: [],
    location: { column: 9, file: "button.tsx", line: 9 },
    message: "",
    practice: "reactivity",
  };
}

function report(findings: HookFinding[], practices: LegendPracticeFinding[] = []): AnalysisReport {
  return {
    capabilities: {
      disabledRules: [],
      reactCompiler: false,
    },
    files: 1,
    findings,
    hooks: { effects: findings.length, states: 0, total: findings.length },
    practices,
    schemaVersion: 7,
    subscriptionAnalysis: {
      coverage: { otherAction: 0, planned: 0, total: 1, unresolved: 1 },
      inventory: [
        {
          binding: "isOpen",
          callLocation: { column: 18, file: "button.tsx", line: 9 },
          derivations: [],
          location: { column: 9, file: "button.tsx", line: 9 },
          observable: "open$",
          owner: "Button",
          reads: [],
          reasons: ["no-render-consumer", "shadowed-or-reassigned-binding"],
          ruleGates: [{ action: "peek-unrendered-use-value", gate: "plain-seed-not-proven" }],
          status: "unresolved",
        },
      ],
      plans: [],
      rejectedMeasurements: [],
      version: 1,
    },
  };
}

test("only a proven change with the case action or an equivalent at the parent line flags a case", () => {
  assert.equal(flags([hookFinding("use-unmount", "change")]), true);
  assert.equal(flags([hookFinding("use-unmount", "candidate")]), false);
  assert.equal(flags([hookFinding("use-unmount", "change", 10)]), false);
  assert.equal(flags([hookFinding("use-mount", "change")]), false);

  const dead: ReplayCase = {
    ...enforced,
    action: "use-observable",
    equivalents: ["peek-unrendered-use-value"],
  };
  const practice = report([], [practiceFinding("peek-unrendered-use-value", "change")]);
  assert.equal(scoreReplayCase(practice, commit, dead).flagged, true);
  const candidate = report([], [practiceFinding("peek-unrendered-use-value", "candidate")]);
  assert.equal(scoreReplayCase(candidate, commit, dead).flagged, false);
});

test("received names every finding and subscription blocker at the location, and excluded cases never flag", () => {
  const abstained: HookFinding = {
    ...hookFinding("keep-effect", "candidate"),
    abstentionReason: "effect-causal-owner-unresolved",
    action: "review-effect",
  };
  const outcome = scoreReplayCase(
    report([abstained], [practiceFinding("replace-legacy-use-value", "change")]),
    commit,
    enforced,
  );
  assert.deepEqual(outcome.received, [
    "review-effect [candidate] (effect-causal-owner-unresolved)",
    "replace-legacy-use-value [change]",
    "subscription unresolved (no-render-consumer, shadowed-or-reassigned-binding)",
  ]);
  const excluded: ReplayCase = { ...enforced, expected: "excluded" };
  assert.equal(flags([hookFinding("use-unmount", "change")], excluded), false);
});

test("received names the targeted rule's own gate beside the inventory blockers", () => {
  const unrendered: ReplayCase = { ...enforced, action: "peek-unrendered-use-value" };
  assert.deepEqual(scoreReplayCase(report([]), commit, unrendered).received, [
    "subscription unresolved (no-render-consumer, shadowed-or-reassigned-binding)",
    "peek-unrendered-use-value abstained (plain-seed-not-proven)",
  ]);
  const equivalent: ReplayCase = { ...enforced, equivalents: ["peek-unrendered-use-value"] };
  assert.match(
    scoreReplayCase(report([]), commit, equivalent).received.join("; "),
    /peek-unrendered-use-value abstained \(plain-seed-not-proven\)/u,
  );
});

test("label drift fails a case whose parent line no longer holds its source text", () => {
  assert.equal(labelDrift(commit, enforced, "    useEffect(() => () => clear(), []);"), null);
  assert.equal(
    labelDrift(commit, enforced, "    const ref = useRef(null);"),
    "app@1234567 button.tsx:9: parent line does not contain `useEffect(`",
  );
  assert.match(labelDrift(commit, enforced, null)!, /does not contain/u);
});

function outcomeOf(replayCase: ReplayCase, flagged: boolean): ReplayOutcome {
  return { commit, flagged, received: flagged ? [] : ["keep-effect [keep]"], replayCase };
}

test("the summary scores enforced recall, lists misses, and reports non-enforced flags without scoring them", () => {
  const nonEnforced: ReplayCase = {
    ...enforced,
    expected: "non-enforced",
    line: 20,
    rationale: "Timing.",
  };
  const excluded: ReplayCase = { ...enforced, expected: "excluded", line: 30 };
  assert.deepEqual(
    replaySummaryLines([
      outcomeOf(enforced, true),
      outcomeOf({ ...enforced, equivalents: ["use-mount"], line: 12 }, false),
      outcomeOf(nonEnforced, true),
      outcomeOf(excluded, false),
    ]),
    [
      "Expert replay recall: 1/2 (50.0%).",
      "Replay miss [app@1234567 button.tsx:12]: expected use-unmount or use-mount, received keep-effect [keep] (Teardown only.)",
      "Non-enforced replay cases flagged: 1/1 (not scored).",
      "Non-enforced replay flag [app@1234567 button.tsx:20]: no finding (Timing.)",
      "Excluded replay cases: 1.",
    ],
  );
  assert.deepEqual(replaySummaryLines([outcomeOf(excluded, false)]), [
    "Expert replay recall: 0/0.",
    "Non-enforced replay cases flagged: 0/0 (not scored).",
    "Excluded replay cases: 1.",
  ]);
  assert.deepEqual(replaySummaryLines([]), ["Expert replay: no replay repository supplied."]);
});

const managerSource = [
  'import { observable } from "@legendapp/state";',
  'import { useValue } from "@legendapp/state/react";',
  'import { useEffect } from "react";',
  'import { syncWindow } from "./native";',
  "",
  "const open$ = observable(false);",
  "",
  "export function WindowManager() {",
  "  const isOpen = useValue(open$);",
  "  useEffect(() => {",
  "    syncWindow(isOpen);",
  "  }, [isOpen]);",
  "  return null;",
  "}",
  "",
].join("\n");

const observedSource = [
  'import { observable } from "@legendapp/state";',
  'import { useObserveEffect } from "@legendapp/state/react";',
  'import { syncWindow } from "./native";',
  "",
  "const open$ = observable(false);",
  "",
  "export function WindowManager() {",
  "  useObserveEffect(() => syncWindow(open$.get()));",
  "  return null;",
  "}",
  "",
].join("\n");

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function commitAll(root: string, message: string): string {
  git(root, ["add", "--all"]);
  git(root, [
    "-c",
    "user.name=Replay",
    "-c",
    "user.email=replay@example.com",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
  return git(root, ["rev-parse", "HEAD"]);
}

interface ExpertHistory {
  after: string;
  before: string;
  root: string;
}

function expertHistory(): ExpertHistory {
  const root = mkdtempSync(path.join(os.tmpdir(), "legend-doctor-replay-test-"));
  git(root, ["init", "--quiet"]);
  mkdirSync(path.join(root, "src"));
  writeFileSync(
    path.join(root, "src/native.ts"),
    "export function syncWindow(open: boolean): void {\n  void open;\n}\n",
  );
  writeFileSync(path.join(root, "src/window-manager.tsx"), managerSource);
  const before = commitAll(root, "effect");
  writeFileSync(path.join(root, "src/window-manager.tsx"), observedSource);
  return { after: commitAll(root, "observe"), before, root };
}

test("a commit tree is read from the object store and removed without touching the checkout", async () => {
  const { before, root } = expertHistory();
  try {
    let materialized = "";
    const text = await withCommitTree(root, before, (treeRoot) => {
      materialized = treeRoot;
      return readFile(path.join(treeRoot, "src/window-manager.tsx"), "utf8");
    });
    assert.equal(text, managerSource);
    assert.equal(existsSync(materialized), false);
    assert.equal(readFileSync(path.join(root, "src/window-manager.tsx"), "utf8"), observedSource);
    assert.equal(git(root, ["status", "--porcelain"]), "");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("replay scans the parent tree, scores its cases, and fails drifted labels and missing parents", async () => {
  const { after, before, root } = expertHistory();
  const replayCase: ReplayCase = {
    action: "use-observe-effect",
    expected: "enforced",
    file: "window-manager.tsx",
    line: 10,
    rationale: "The null-rendering manager reads isOpen only in the effect.",
    source: "useEffect(() => {",
  };
  const drifted: ReplayCase = { ...replayCase, expected: "excluded", line: 9 };
  const missing = "0".repeat(40);
  try {
    const failures: string[] = [];
    const outcomes = await replayExpertCommits(
      [
        {
          cases: [replayCase, drifted],
          commit: after,
          parent: before,
          repository: "app",
          root: "src",
        },
        { cases: [replayCase], commit: missing, parent: missing, repository: "app", root: "src" },
        {
          cases: [replayCase],
          commit: after,
          parent: before,
          repository: "unsupplied",
          root: "src",
        },
      ],
      new Map([["app", root]]),
      failures,
    );
    assert.deepEqual(
      outcomes.map((result) => [result.replayCase.line, result.flagged]),
      [
        [10, true],
        [9, false],
      ],
    );
    assert.equal(failures.length, 2);
    assert.match(
      failures[0]!,
      /window-manager\.tsx:9: parent line does not contain `useEffect\(\(\) => \{`/u,
    );
    assert.match(failures[1]!, new RegExp(`^app@0000000: ${missing} is not in `, "u"));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
