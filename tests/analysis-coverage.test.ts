import assert from "node:assert/strict";
import test from "node:test";

import {
  AnalysisCoverageLedger,
  type AnalysisCoverageEntry,
  type AnalysisCoverageOutcome,
} from "../src/analysis-coverage.js";

function outcome(
  status: AnalysisCoverageOutcome["status"],
  code: string
): AnalysisCoverageOutcome {
  return { status, reason: { code, message: code.replaceAll("-", " ") } };
}

function entry(
  target: AnalysisCoverageEntry["target"],
  detectorStatus: AnalysisCoverageOutcome["status"] = "analyzed"
): AnalysisCoverageEntry {
  return {
    target,
    stages: {
      parser: outcome("analyzed", "parsed"),
      lowering: outcome("skipped", "lowering-not-requested"),
      semantic: outcome("unsupported", "project-context-unavailable"),
      detector: outcome(detectorStatus, "detector-complete"),
    },
  };
}

test("reports every analysis stage explicitly for file and function targets", () => {
  const ledger = new AnalysisCoverageLedger();
  ledger.record(entry({ kind: "file", file: "src/view.tsx" }));
  ledger.record(
    entry(
      { kind: "function", file: "src/view.tsx", name: null, start: 40, end: 75 },
      "skipped"
    )
  );

  const report = ledger.report();
  assert.deepEqual(Object.keys(report.entries[0]?.stages ?? {}), [
    "parser",
    "lowering",
    "semantic",
    "detector",
  ]);
  assert.deepEqual(report.entries[1]?.target, {
    kind: "function",
    file: "src/view.tsx",
    name: null,
    start: 40,
    end: 75,
  });
  assert.equal(report.entries[1]?.stages.detector.status, "skipped");
  assert.equal(report.entries[1]?.stages.detector.reason.code, "detector-complete");
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.deepEqual(JSON.parse(JSON.stringify(ledger)), report);
});

test("sorts reports deterministically without depending on record order or locale", () => {
  const inputs = [
    entry({ kind: "function", file: "src/z.tsx", name: "later", start: 20, end: 30 }),
    entry({ kind: "function", file: "src/a.tsx", name: "first", start: 5, end: 10 }),
    entry({ kind: "file", file: "src/z.tsx" }),
    entry({ kind: "function", file: "src/z.tsx", name: "earlier", start: 10, end: 15 }),
  ];
  const forward = new AnalysisCoverageLedger();
  const reverse = new AnalysisCoverageLedger();
  for (const input of inputs) forward.record(input);
  for (const input of [...inputs].reverse()) reverse.record(input);

  assert.deepEqual(forward.report(), reverse.report());
  assert.deepEqual(
    forward.report().entries.map(({ target }) =>
      target.kind === "file" ? `${target.file}:file` : `${target.file}:${target.start}`
    ),
    ["src/a.tsx:5", "src/z.tsx:file", "src/z.tsx:10", "src/z.tsx:20"]
  );
});

test("rejects duplicate targets instead of silently replacing coverage", () => {
  const ledger = new AnalysisCoverageLedger();
  ledger.record(entry({ kind: "file", file: "src/view.tsx" }));
  assert.throws(
    () => ledger.record(entry({ kind: "file", file: "src/view.tsx" }, "unsupported")),
    /already recorded/
  );
});

test("rejects omitted or unexpected targets against the project universe", () => {
  const first = { kind: "file" as const, file: "src/first.ts" };
  const second = { kind: "file" as const, file: "src/second.ts" };
  const ledger = new AnalysisCoverageLedger([first, second]);
  ledger.record(entry(first));
  assert.throws(() => ledger.report(), /coverage targets were not recorded/);
  assert.throws(
    () => ledger.record(entry({ kind: "file", file: "src/third.ts" })),
    /unexpected coverage target/
  );
});

test("rejects impossible detector coverage and duplicate function ranges", () => {
  const target = { kind: "file" as const, file: "src/view.tsx" };
  const impossible = entry(target);
  assert.throws(
    () => new AnalysisCoverageLedger().record({
      ...impossible,
      stages: { ...impossible.stages, parser: outcome("unknown", "parser-recovery") },
    }),
    /detector cannot be analyzed/
  );

  const ledger = new AnalysisCoverageLedger();
  ledger.record(entry({ kind: "function", file: "src/view.tsx", name: "first", start: 1, end: 2 }));
  assert.throws(
    () => ledger.record(entry({ kind: "function", file: "src/view.tsx", name: "alias", start: 1, end: 2 })),
    /already recorded/
  );
});

test("rejects omitted stages and blank reasons instead of treating them as unknown", () => {
  const missingStage = entry({ kind: "file", file: "src/missing.tsx" }) as unknown as {
    target: AnalysisCoverageEntry["target"];
    stages: Record<string, AnalysisCoverageOutcome>;
  };
  delete missingStage.stages.semantic;

  const ledger = new AnalysisCoverageLedger();
  assert.throws(
    () => ledger.record(missingStage as unknown as AnalysisCoverageEntry),
    /must explicitly report/
  );

  const blankReason = entry({ kind: "file", file: "src/blank.tsx" });
  const invalid = {
    ...blankReason,
    stages: {
      ...blankReason.stages,
      lowering: { status: "skipped" as const, reason: { code: " ", message: "not needed" } },
    },
  };
  assert.throws(() => ledger.record(invalid), /reason code must not be empty/);
});

test("defines an empty report as no registered targets", () => {
  assert.deepEqual(new AnalysisCoverageLedger().report(), {
    schemaVersion: 1,
    entries: [],
  });
});
