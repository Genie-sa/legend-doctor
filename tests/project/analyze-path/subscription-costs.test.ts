import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { SubscriptionMeasurement } from "../../../src/core/subscriptions.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import { applySubscriptionMeasurements } from "../../../src/report/subscription-measurements.js";
import assert from "node:assert/strict";
import { attachSubscriptionMeasurements } from "../../../src/project/subscription-measurements.js";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const source = `import { useValue, useObservable } from '@legendapp/state/react';
export function Screen() {
 const state$ = useObservable(0);
 const value = useValue(state$);
 return <main><A/><B/><C/><D/><E/><F/><G/><H/><I/><J/><K/><span>{value}</span></main>;
}`;
const environment = {
  runtime: "React 19.2.8 / Legend beta.48 / Node 22 / jsdom 26.1.0",
  platform: "jsdom on test host",
  configuration: "development, StrictMode off, act completion, selector clock instrumentation",
};

test("extended measurement survives file and programmatic input without conflating cost units", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-costs-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "Screen.tsx"), source);
  const report = await analyzePath(root);
  const plan = report.subscriptionAnalysis!.plans[0]!;
  assert.ok(plan);
  const measurement: SubscriptionMeasurement = {
    planId: plan.id,
    fingerprint: plan.fingerprint,
    scenario: "one selection",
    samples: 1,
    environment,
    behaviorEquivalent: true,
    before: {
      ownerRenders: 100,
      siblingRenders: 0,
      selectorExecutions: 0,
      selectorDurationMs: 0,
      scenarioDurationMs: 2.5,
    },
    after: {
      ownerRenders: 2,
      siblingRenders: 0,
      selectorExecutions: 102,
      selectorDurationMs: 3.25,
      scenarioDurationMs: 5,
    },
  };
  await mkdir(path.join(root, ".legend-doctor"));
  const file = path.join(root, ".legend-doctor/subscription-measurements.json");
  await writeFile(file, JSON.stringify([measurement]));
  const persisted = await analyzePath(root);
  await attachSubscriptionMeasurements(report, root, [measurement]);
  assert.deepEqual(report.subscriptionAnalysis, persisted.subscriptionAnalysis);
  assert.deepEqual(report.subscriptionAnalysis!.plans[0]!.impact.measurement, measurement);

  const invalid = [
    { ...measurement, environment: undefined },
    { ...measurement, environment: null },
    { ...measurement, environment: { ...environment, configuration: " " } },
    { ...measurement, after: { ...measurement.after, selectorExecutions: undefined } },
    { ...measurement, after: { ...measurement.after, selectorExecutions: -1 } },
    { ...measurement, after: { ...measurement.after, selectorExecutions: 0.5 } },
    {
      ...measurement,
      after: { ...measurement.after, selectorExecutions: Number.MAX_SAFE_INTEGER + 1 },
    },
    { ...measurement, before: { ...measurement.before, selectorDurationMs: -0.1 } },
    { ...measurement, before: { ...measurement.before, scenarioDurationMs: null } },
    { ...measurement, before: { ...measurement.before, scenarioDurationMs: "5" } },
  ];
  for (const entry of invalid) {
    await writeFile(file, JSON.stringify([entry]));
    const result = await analyzePath(root);
    assert.equal(result.subscriptionAnalysis!.rejectedMeasurements.length, 1);
    assert.equal(result.subscriptionAnalysis!.plans[0]!.impact.measurement, null);
  }
  for (const duration of [Number.NaN, Number.POSITIVE_INFINITY]) {
    await attachSubscriptionMeasurements(report, root, [
      { ...measurement, before: { ...measurement.before, scenarioDurationMs: duration } },
    ]);
    assert.equal(report.subscriptionAnalysis!.rejectedMeasurements.length, 1);
  }
  await attachSubscriptionMeasurements(report, root, [
    measurement,
    measurement,
    { ...measurement, fingerprint: "stale" },
  ]);
  assert.equal(report.subscriptionAnalysis!.rejectedMeasurements.length, 2);
});

test("incompatible provenance uses static ordering, while compatible counts retain render ranking", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-cost-ranking-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "Screen.tsx"), source);
  const report = await analyzePath(root);
  const plan = report.subscriptionAnalysis!.plans[0]!;
  const analysis = {
    ...report.subscriptionAnalysis!,
    plans: [
      { ...plan, id: "large", impact: { ...plan.impact, ownerJsxElements: 100 } },
      { ...plan, id: "medium", impact: { ...plan.impact, ownerJsxElements: 50 } },
      { ...plan, id: "small", impact: { ...plan.impact, ownerJsxElements: 20 } },
    ],
  };
  const measurement: SubscriptionMeasurement = {
    planId: "small",
    fingerprint: plan.fingerprint,
    scenario: "update",
    samples: 1,
    environment,
    behaviorEquivalent: true,
    before: { ownerRenders: 100, siblingRenders: 0, scenarioDurationMs: 1 },
    after: { ownerRenders: 0, siblingRenders: 0, scenarioDurationMs: 1000 },
  };
  const other = {
    ...measurement,
    planId: "large",
    before: { ...measurement.before, ownerRenders: 2 },
  };
  const ranked = applySubscriptionMeasurements(analysis, [measurement, other]);
  assert.deepEqual(
    ranked.plans.map((item) => item.id),
    ["small", "large", "medium"],
  );
  for (const incompatible of [
    { ...other, scenario: "different workload" },
    { ...other, environment: { ...environment, runtime: "different versions" } },
    { ...other, environment: { ...environment, platform: "physical device" } },
    { ...other, environment: { ...environment, configuration: "production" } },
    {
      planId: other.planId,
      fingerprint: other.fingerprint,
      scenario: other.scenario,
      samples: 1,
      before: { ownerRenders: 2, siblingRenders: 0 },
      after: { ownerRenders: 0, siblingRenders: 0 },
      behaviorEquivalent: true as const,
    },
  ]) {
    for (const plans of [analysis.plans, analysis.plans.toReversed()]) {
      const result = applySubscriptionMeasurements({ ...analysis, plans }, [
        measurement,
        incompatible,
      ]);
      assert.deepEqual(
        result.plans.map((item) => item.id),
        ["large", "medium", "small"],
      );
      assert.equal(result.rejectedMeasurements.length, 0);
      assert.deepEqual(result.plans[2]!.impact.measurement, measurement);
    }
  }
});
