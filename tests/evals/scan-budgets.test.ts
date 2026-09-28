import {
  SCAN_BASELINE_SECONDS,
  SCAN_HEAP_LIMIT_MIB,
  SCAN_TIME_FLOOR_SECONDS,
  scanBudget,
  scanTimeLimitSeconds,
} from "../../evals/performance-budgets.js";
import {
  measureScan,
  parseScanSample,
  scanOutcomeLine,
} from "../../evals/runner/scan-measurement.js";
import type { ScanBudget } from "../../evals/performance-budgets.js";
import assert from "node:assert/strict";
import { repositories } from "../../evals/corpus/repositories.js";
import test from "node:test";
import { withProject } from "../project/with-project.js";

const COMPONENT = `
  import { useState } from "react";
  export function Counter() {
    const [count, setCount] = useState(0);
    return <button onClick={() => setCount(count + 1)}>{count}</button>;
  }
`;

const budget: ScanBudget = { baselineSeconds: 1, heapLimitMiB: 512, timeLimitSeconds: 60 };

test("every public repository has exactly one scan budget", () => {
  assert.deepEqual(
    [...SCAN_BASELINE_SECONDS.keys()].toSorted(),
    repositories.map((repository) => repository.name).toSorted(),
  );
  assert.throws(() => scanBudget("unbudgeted"), /unbudgeted has no scan budget/u);
});

test("time limits triple the CI baseline and never drop below the floor", () => {
  assert.equal(scanTimeLimitSeconds(1), SCAN_TIME_FLOOR_SECONDS);
  assert.equal(scanTimeLimitSeconds(40.2), 121);
  const expensify = scanBudget("expensify");
  assert.equal(expensify.heapLimitMiB, SCAN_HEAP_LIMIT_MIB);
  assert.equal(expensify.timeLimitSeconds, scanTimeLimitSeconds(expensify.baselineSeconds));
});

test("a scan within budget reports its peak RSS and scanned size", async () => {
  await withProject({ "counter.tsx": COMPONENT }, async (root) => {
    const outcome = await measureScan(root, budget);
    assert.ok(outcome.passed);
    assert.equal(outcome.sample.files, 1);
    assert.equal(outcome.sample.hooks, 1);
    assert.ok(outcome.sample.maxRssMiB > 0);
    assert.match(
      scanOutcomeLine("app", budget, outcome),
      /^app: \d+\.\ds \(limit 60s\), peak RSS \d+ MiB, 1 files, 1 hooks$/u,
    );
  });
});

test("a scan past its time limit is killed and fails", async () => {
  await withProject({ "counter.tsx": COMPONENT }, async (root) => {
    const outcome = await measureScan(root, { ...budget, timeLimitSeconds: 0.001 });
    assert.ok(!outcome.passed);
    assert.match(
      scanOutcomeLine("app", budget, outcome),
      /^app: failed after \d+\.\ds \(limit 60s\): exceeded the 0\.001s time limit$/u,
    );
  });
});

test("a scan that exhausts its heap fails as out of memory rather than as a crash", async () => {
  await withProject({ "counter.tsx": COMPONENT }, async (root) => {
    const outcome = await measureScan(root, { ...budget, heapLimitMiB: 8 });
    assert.ok(!outcome.passed);
    assert.equal(outcome.reason, "ran out of memory at the 8 MiB heap limit");
  });
});

test("a benchmark sample without a numeric field is rejected", () => {
  assert.deepEqual(parseScanSample('{"files":2,"hooks":3,"maxRssMiB":4.5,"root":"/app"}'), {
    files: 2,
    hooks: 3,
    maxRssMiB: 4.5,
  });
  assert.throws(() => parseScanSample('{"files":2,"hooks":3}'), /no numeric maxRssMiB/u);
  assert.throws(
    () => parseScanSample('{"files":"2","hooks":3,"maxRssMiB":1}'),
    /no numeric files/u,
  );
  assert.throws(
    () => parseScanSample('{"files":2,"hooks":null,"maxRssMiB":1}'),
    /no numeric hooks/u,
  );
});
