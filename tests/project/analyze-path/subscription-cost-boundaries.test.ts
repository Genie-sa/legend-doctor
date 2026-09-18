import type {
  SubscriptionCosts,
  SubscriptionMeasurement,
  SubscriptionPlan,
} from "../../../src/core/subscriptions.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import type { AnalysisReport } from "../../../src/core/types.js";
import type { TestContext } from "node:test";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import { applySubscriptionMeasurements } from "../../../src/report/subscription-measurements.js";
import assert from "node:assert/strict";
import { attachSubscriptionMeasurements } from "../../../src/project/subscription-measurements.js";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const environment = {
  runtime: "pinned engine and dependencies",
  platform: "jsdom",
  configuration: "development; StrictMode off; act completion",
};

async function setup(context: TestContext): Promise<{ root: string; report: AnalysisReport }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-cost-boundaries-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
    import { useValue, useObservable } from '@legendapp/state/react';
    export function Screen() {
      const state$ = useObservable(0);
      const value = useValue(state$);
      return <main><A/><B/><C/><D/><E/><F/><G/><H/><I/><J/><K/><span>{value}</span></main>;
    }`,
  );
  const report = await analyzePath(root);
  assert.equal(report.subscriptionAnalysis!.plans.length, 1);
  await mkdir(path.join(root, ".legend-doctor"));
  return { root, report };
}

function measurementFor(plan: SubscriptionPlan): SubscriptionMeasurement {
  return {
    planId: plan.id,
    fingerprint: plan.fingerprint,
    scenario: "one update",
    samples: 1,
    before: { ownerRenders: 2, siblingRenders: 0 },
    after: { ownerRenders: 0, siblingRenders: 0 },
    behaviorEquivalent: true,
  };
}

test("all optional cost subsets round-trip while absent metrics remain absent and unknown metadata is ignored", async (context) => {
  const { root, report } = await setup(context);
  const base = measurementFor(report.subscriptionAnalysis!.plans[0]!);
  const file = path.join(root, ".legend-doctor/subscription-measurements.json");
  for (let subset = 0; subset < 8; subset += 1) {
    const costs: SubscriptionCosts = { ownerRenders: 0, siblingRenders: 0 };
    if (subset & 1) {
      costs.selectorExecutions = Number.MAX_SAFE_INTEGER;
    }
    if (subset & 2) {
      costs.selectorDurationMs = 0;
    }
    if (subset & 4) {
      costs.scenarioDurationMs = Number.MAX_VALUE;
    }
    const expected = { ...base, environment, before: costs, after: costs };
    await writeFile(
      file,
      JSON.stringify([{ ...expected, futureMetadata: { units: "not interpreted" } }]),
    );
    await attachSubscriptionMeasurements(report, root);
    assert.deepEqual(report.subscriptionAnalysis!.plans[0]!.impact.measurement, expected);
    await attachSubscriptionMeasurements(report, root, [expected]);
    assert.deepEqual(report.subscriptionAnalysis!.plans[0]!.impact.measurement, expected);
    assert.equal(report.subscriptionAnalysis!.rejectedMeasurements.length, 0);
  }
  await attachSubscriptionMeasurements(report, root, [base]);
  assert.deepEqual(report.subscriptionAnalysis!.plans[0]!.impact.measurement, base);
});

test("each optional cost rejects malformed values and asymmetric presence on either side", async (context) => {
  const { root, report } = await setup(context);
  const base = { ...measurementFor(report.subscriptionAnalysis!.plans[0]!), environment };
  const file = path.join(root, ".legend-doctor/subscription-measurements.json");
  for (const key of ["selectorExecutions", "selectorDurationMs", "scenarioDurationMs"] as const) {
    const valid = {
      ...base,
      before: { ...base.before, [key]: 0 },
      after: { ...base.after, [key]: 0 },
    };
    for (const side of ["before", "after"] as const) {
      for (const value of [
        null,
        true,
        "1",
        {},
        [],
        -1,
        ...(key === "selectorExecutions" ? [0.25, Number.MAX_SAFE_INTEGER + 1] : []),
      ]) {
        await writeFile(
          file,
          JSON.stringify([{ ...valid, [side]: { ...valid[side], [key]: value } }]),
        );
        await attachSubscriptionMeasurements(report, root);
        assert.equal(
          report.subscriptionAnalysis!.rejectedMeasurements.length,
          1,
          `${side}.${key}=${JSON.stringify(value)}`,
        );
        assert.equal(report.subscriptionAnalysis!.plans[0]!.impact.measurement, null);
      }
      await attachSubscriptionMeasurements(report, root, [{ ...valid, [side]: base[side] }]);
      assert.equal(
        report.subscriptionAnalysis!.rejectedMeasurements.length,
        1,
        `missing ${side}.${key}`,
      );
      for (const value of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
        await attachSubscriptionMeasurements(report, root, [
          { ...valid, [side]: { ...valid[side], [key]: value } },
        ]);
        assert.equal(
          report.subscriptionAnalysis!.rejectedMeasurements.length,
          1,
          `nonfinite ${side}.${key}`,
        );
      }
    }
  }
});

test("provenance and envelope validation reject malformed records without poisoning a later valid record", async (context) => {
  const { root, report } = await setup(context);
  const base = { ...measurementFor(report.subscriptionAnalysis!.plans[0]!), environment };
  const file = path.join(root, ".legend-doctor/subscription-measurements.json");
  for (const key of ["runtime", "platform", "configuration"] as const) {
    for (const value of [undefined, null, false, 3, [], {}, "", " \n\t "]) {
      await writeFile(
        file,
        JSON.stringify([{ ...base, environment: { ...environment, [key]: value } }, base]),
      );
      await attachSubscriptionMeasurements(report, root);
      assert.equal(report.subscriptionAnalysis!.rejectedMeasurements.length, 1);
      assert.deepEqual(report.subscriptionAnalysis!.plans[0]!.impact.measurement, base);
    }
  }
  for (const content of ["{", "null", "{}", '"text"', "[null]", "[[]]"]) {
    await writeFile(file, content);
    await attachSubscriptionMeasurements(report, root);
    assert.equal(report.subscriptionAnalysis!.rejectedMeasurements.length, 1);
    assert.equal(report.subscriptionAnalysis!.plans[0]!.impact.measurement, null);
  }
  // An explicitly empty programmatic list overrides the file; missing evidence clears prior attachment.
  await writeFile(file, JSON.stringify([base]));
  await attachSubscriptionMeasurements(report, root, []);
  assert.equal(report.subscriptionAnalysis!.plans[0]!.impact.measurement, null);
  await attachSubscriptionMeasurements(report, root);
  await rm(file);
  await attachSubscriptionMeasurements(report, root);
  assert.equal(report.subscriptionAnalysis!.plans[0]!.impact.measurement, null);
  assert.deepEqual(report.subscriptionAnalysis!.rejectedMeasurements, []);
  // Real filesystem errors must not silently look like absent or invalid measurements.
  await mkdir(file);
  await assert.rejects(attachSubscriptionMeasurements(report, root), { code: "EISDIR" });
});

test("only accepted records determine compatibility and the first valid duplicate retains ownership", async (context) => {
  const { report } = await setup(context);
  const analysis = report.subscriptionAnalysis!;
  const original = analysis.plans[0]!;
  const small = { ...original, id: "small", impact: { ...original.impact, ownerJsxElements: 20 } };
  const large = { ...original, id: "large", impact: { ...original.impact, ownerJsxElements: 100 } };
  const input = { ...analysis, plans: [large, small] };
  const valid = { ...measurementFor(small), environment };
  const incompatible = { ...valid, environment: { ...environment, runtime: "unrelated version" } };
  const before = JSON.stringify(input);
  const ranked = applySubscriptionMeasurements(input, [
    { ...incompatible, fingerprint: "stale" },
    { ...incompatible, planId: "unmatched" },
    null,
    valid,
    incompatible,
  ]);
  assert.equal(ranked.rejectedMeasurements.length, 4);
  assert.deepEqual(
    ranked.plans.map((plan) => plan.id),
    ["small", "large"],
  );
  assert.deepEqual(ranked.plans[0]!.impact.measurement, valid);
  assert.equal(JSON.stringify(input), before);
  const cleared = applySubscriptionMeasurements(ranked, []);
  assert.deepEqual(
    cleared.plans.map((plan) => plan.id),
    ["large", "small"],
  );
  assert.ok(cleared.plans.every((plan) => plan.impact.measurement === null));
});

test("ranking normalizes samples and preserves small savings near the accepted integer boundary", async (context) => {
  const { report } = await setup(context);
  const analysis = report.subscriptionAnalysis!;
  const original = analysis.plans[0]!;
  const first = { ...original, id: "a" };
  const second = { ...original, id: "b" };
  const input = { ...analysis, plans: [second, first] };
  const oneAndHalf = {
    ...measurementFor(first),
    environment,
    samples: 2,
    before: { ownerRenders: 3, siblingRenders: 0 },
  };
  const two = {
    ...measurementFor(second),
    environment,
    before: { ownerRenders: Number.MAX_SAFE_INTEGER, siblingRenders: 2 },
    after: { ownerRenders: Number.MAX_SAFE_INTEGER, siblingRenders: 0 },
  };
  const ranked = applySubscriptionMeasurements(input, [oneAndHalf, two]);
  assert.deepEqual(
    ranked.plans.map((plan) => plan.id),
    ["b", "a"],
    "two saved renders outrank 1.5 per sample",
  );
  const tied = applySubscriptionMeasurements(input, [
    { ...oneAndHalf, samples: 3 },
    { ...two, samples: 2 },
  ]);
  assert.deepEqual(
    tied.plans.map((plan) => plan.id),
    ["a", "b"],
    "equal per-sample savings break ties by id",
  );
  // 1 + 1/(n-2) is greater than 1 + 1/(n-1), even when floating division rounds them equal.
  const maximum = Number.MAX_SAFE_INTEGER;
  const closeRatios = applySubscriptionMeasurements(input, [
    { ...oneAndHalf, samples: maximum - 1, before: { ownerRenders: maximum, siblingRenders: 0 } },
    {
      ...two,
      samples: maximum - 2,
      before: { ownerRenders: maximum - 1, siblingRenders: 0 },
      after: { ownerRenders: 0, siblingRenders: 0 },
    },
  ]);
  assert.deepEqual(
    closeRatios.plans.map((plan) => plan.id),
    ["b", "a"],
  );
});
