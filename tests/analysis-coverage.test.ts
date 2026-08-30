import assert from "node:assert/strict";
import test from "node:test";

import { AnalysisCoverageLedger } from "../src/analysis-coverage.js";
import type { AnalysisCoverageEntry, AnalysisCoverageOutcome } from "../src/analysis-coverage.js";

function outcome(status: AnalysisCoverageOutcome["status"], code: string): AnalysisCoverageOutcome {
  return { reason: { code, message: code.replaceAll("-", " ") }, status };
}

function entry(
  target: AnalysisCoverageEntry["target"],
  detectorStatus: AnalysisCoverageOutcome["status"] = "analyzed",
): AnalysisCoverageEntry {
  return {
    stages: {
      detector: outcome(detectorStatus, "detector-complete"),
      lowering: outcome("skipped", "lowering-not-requested"),
      parser: outcome("analyzed", "parsed"),
      semantic: outcome("unsupported", "project-context-unavailable"),
    },
    target,
  };
}

test("reports every analysis stage explicitly for file and function targets", () => {
  const ledger = new AnalysisCoverageLedger();
  ledger.record(entry({ file: "src/view.tsx", kind: "file" }));
  ledger.record(
    entry({ end: 75, file: "src/view.tsx", kind: "function", name: null, start: 40 }, "skipped"),
  );

  const report = ledger.report();
  assert.deepEqual(Object.keys(report.entries[0]?.stages ?? {}), [
    "parser",
    "lowering",
    "semantic",
    "detector",
  ]);
  assert.deepEqual(report.entries[1]?.target, {
    end: 75,
    file: "src/view.tsx",
    kind: "function",
    name: null,
    start: 40,
  });
  assert.equal(report.entries[1]?.stages.detector.status, "skipped");
  assert.equal(report.entries[1]?.stages.detector.reason.code, "detector-complete");
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.deepEqual(JSON.parse(JSON.stringify(ledger)), report);
});

test("sorts reports deterministically without depending on record order or locale", () => {
  const inputs = [
      entry({ end: 30, file: "src/z.tsx", kind: "function", name: "later", start: 20 }),
      entry({ end: 10, file: "src/a.tsx", kind: "function", name: "first", start: 5 }),
      entry({ file: "src/z.tsx", kind: "file" }),
      entry({ end: 15, file: "src/z.tsx", kind: "function", name: "earlier", start: 10 }),
    ],
    forward = new AnalysisCoverageLedger(),
    reverse = new AnalysisCoverageLedger();
  for (const input of inputs) {
    forward.record(input);
  }
  for (const input of [...inputs].reverse()) {
    reverse.record(input);
  }

  assert.deepEqual(forward.report(), reverse.report());
  assert.deepEqual(
    forward
      .report()
      .entries.map(({ target }) =>
        target.kind === "file" ? `${target.file}:file` : `${target.file}:${target.start}`,
      ),
    ["src/a.tsx:5", "src/z.tsx:file", "src/z.tsx:10", "src/z.tsx:20"],
  );
});

test("rejects duplicate targets instead of silently replacing coverage", () => {
  const ledger = new AnalysisCoverageLedger();
  ledger.record(entry({ file: "src/view.tsx", kind: "file" }));
  assert.throws(
    () => ledger.record(entry({ file: "src/view.tsx", kind: "file" }, "unsupported")),
    /already recorded/,
  );
});

test("rejects omitted or unexpected targets against the project universe", () => {
  const first = { file: "src/first.ts", kind: "file" as const },
    second = { file: "src/second.ts", kind: "file" as const },
    ledger = new AnalysisCoverageLedger([first, second]);
  ledger.record(entry(first));
  assert.throws(() => ledger.report(), /coverage targets were not recorded/);
  assert.throws(
    () => ledger.record(entry({ file: "src/third.ts", kind: "file" })),
    /unexpected coverage target/,
  );
});

test("rejects impossible detector coverage and duplicate function ranges", () => {
  const target = { file: "src/view.tsx", kind: "file" as const },
    impossible = entry(target);
  assert.throws(
    () =>
      new AnalysisCoverageLedger().record({
        ...impossible,
        stages: { ...impossible.stages, parser: outcome("unknown", "parser-recovery") },
      }),
    /detector cannot be analyzed/,
  );

  const ledger = new AnalysisCoverageLedger();
  ledger.record(entry({ end: 2, file: "src/view.tsx", kind: "function", name: "first", start: 1 }));
  assert.throws(
    () =>
      ledger.record(
        entry({ end: 2, file: "src/view.tsx", kind: "function", name: "alias", start: 1 }),
      ),
    /already recorded/,
  );
});

test("rejects omitted stages and blank reasons instead of treating them as unknown", () => {
  const missingStage = entry({ file: "src/missing.tsx", kind: "file" }) as unknown as {
    target: AnalysisCoverageEntry["target"];
    stages: Record<string, AnalysisCoverageOutcome>;
  };
  delete missingStage.stages.semantic;

  const ledger = new AnalysisCoverageLedger();
  assert.throws(
    () => ledger.record(missingStage as unknown as AnalysisCoverageEntry),
    /must explicitly report/,
  );

  const blankReason = entry({ file: "src/blank.tsx", kind: "file" }),
    invalid = {
      ...blankReason,
      stages: {
        ...blankReason.stages,
        lowering: { reason: { code: " ", message: "not needed" }, status: "skipped" as const },
      },
    };
  assert.throws(() => ledger.record(invalid), /reason code must not be empty/);
});

test("defines an empty report as no registered targets", () => {
  assert.deepEqual(new AnalysisCoverageLedger().report(), {
    entries: [],
    schemaVersion: 1,
  });
});
