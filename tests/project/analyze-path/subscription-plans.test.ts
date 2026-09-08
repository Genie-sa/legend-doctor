import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import { applySubscriptionMeasurements } from "../../../src/report/subscription-measurements.js";
import assert from "node:assert/strict";
import { filterSubscriptionAnalysis } from "../../../src/report/subscription-plans.js";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const source = `
  import { useObservable, useValue as read } from "@legendapp/state/react";
  export function Screen() {
    const state$ = useObservable({ enabled: true, error: "" });
    const external$ = useObservable(false);
    const enabled = read(state$.enabled);
    const error = read(state$.error);
    const unsupported = read(() => state$.enabled.get());
    return <main><A/><B/><C/><D/><E/><F/><G/><H/><I/><J/><K/>
      <section><input disabled={!enabled} className={error ? "invalid" : ""}/><output>{error}</output></section>
      <button onClick={() => save(unsupported)}/>
    </main>;
  }
`;

test("coordinates overlapping subscriptions and inventories unsupported selector flows", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-plans-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "Screen.tsx"), source);
  const report = await analyzePath(root);
  const analysis = report.subscriptionAnalysis;
  assert.ok(analysis);
  assert.equal(analysis.version, 1);
  assert.equal(analysis.coverage.total, 3);
  // An overlapping selector remains in this owner, so enabled cannot claim a removed owner render.
  assert.equal(analysis.plans.length, 1);
  assert.equal(analysis.plans[0]!.subscriptions.length, 1);
  assert.ok(
    analysis.inventory.some((item) => item.reasons.includes("overlapping-parent-subscription")),
  );
  assert.ok(analysis.inventory.some((item) => item.status !== "planned"));

  await writeFile(
    path.join(root, "Screen.tsx"),
    source.replace("state$.enabled.get()", "external$.get()"),
  );
  const independentReport = await analyzePath(root);
  const independent = independentReport.subscriptionAnalysis!;
  const plan = independent.plans[0]!;
  assert.equal(
    plan.children.length,
    1,
    "the input boundary is merged into the complete error section",
  );
  assert.deepEqual(plan.children[0]!.subscriptions.toSorted(), ["enabled", "error"]);
  assert.equal(plan.impact.affectedJsxElements, 3);
  assert.equal(plan.impact.basis, "static-jsx");
  assert.equal(plan.impact.measurement, null);

  await mkdir(path.join(root, ".legend-doctor"));
  await writeFile(
    path.join(root, ".legend-doctor", "subscription-measurements.json"),
    JSON.stringify([
      {
        planId: plan.id,
        fingerprint: plan.fingerprint,
        scenario: "toggle then clear error",
        samples: 2,
        before: { ownerRenders: 2, siblingRenders: 8 },
        after: { ownerRenders: 0, siblingRenders: 0 },
        behaviorEquivalent: true,
      },
      { planId: "stale", fingerprint: "old" },
    ]),
  );
  const measuredReport = await analyzePath(root);
  const measured = measuredReport.subscriptionAnalysis!;
  assert.equal(measured.plans[0]!.impact.basis, "provided-runtime-measurement");
  assert.equal(measured.rejectedMeasurements.length, 1);
  await writeFile(
    path.join(root, "Screen.tsx"),
    source.replace("state$.enabled.get()", "external$.get()").replace("<A/>", "<Changed/>"),
  );
  const changedReport = await analyzePath(root);
  const changed = changedReport.subscriptionAnalysis!;
  assert.equal(changed.plans[0]!.impact.measurement, null);
  assert.equal(changed.rejectedMeasurements.length, 2);
});

test("measurement ranking distinguishes positive, unmeasured, and regressive evidence", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-ranking-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const independent = source.replace("state$.enabled.get()", "external$.get()");
  await writeFile(path.join(root, "Screen.tsx"), independent);
  await writeFile(path.join(root, "Other.tsx"), independent.replaceAll("Screen", "Other"));
  const baseline = await analyzePath(root);
  const analysis = baseline.subscriptionAnalysis!;
  assert.equal(analysis.plans.length, 2);
  const plan = analysis.plans[0]!;
  const measurement = {
    planId: plan.id,
    fingerprint: plan.fingerprint,
    scenario: "update",
    samples: 1,
    before: { ownerRenders: 1, siblingRenders: 1 },
    after: { ownerRenders: 0, siblingRenders: 0 },
    behaviorEquivalent: true as const,
  };
  const positive = applySubscriptionMeasurements(analysis, [measurement]);
  assert.equal(positive.plans[0]!.id, plan.id);
  const negative = applySubscriptionMeasurements(analysis, [
    { ...measurement, after: { ownerRenders: 5, siblingRenders: 5 } },
  ]);
  assert.equal(negative.plans[1]!.id, plan.id);
  assert.equal(
    analysis.plans[0]!.impact.measurement,
    null,
    "ranking does not mutate the input report",
  );
  assert.equal(
    applySubscriptionMeasurements(analysis, [measurement, measurement]).rejectedMeasurements.length,
    1,
  );
  const partial = filterSubscriptionAnalysis(
    positive,
    baseline.practices.filter((finding) => finding.subscription?.binding === "error"),
  );
  assert.equal(partial.plans.length, 2);
  assert.ok(
    partial.plans.every((item) => item.impact.measurement === null),
    "a measurement of the complete plan must not rank a partially filtered edit",
  );
  const unchanged = filterSubscriptionAnalysis(positive, baseline.practices);
  assert.equal(unchanged.plans[0]!.impact.measurement?.planId, plan.id);
  const filtered = filterSubscriptionAnalysis(positive, []);
  assert.equal(filtered.plans.length, 0);
  assert.equal(filtered.coverage.planned, 0);
  assert.ok(
    filtered.inventory.some((entry) => entry.reasons.includes("excluded-by-report-filter")),
  );
  await mkdir(path.join(root, ".legend-doctor"));
  for (const invalid of [
    { ...measurement, samples: 0 },
    { ...measurement, behaviorEquivalent: false },
    { ...measurement, before: { ownerRenders: -1, siblingRenders: 0 } },
    { ...measurement, scenario: "" },
  ]) {
    await writeFile(
      path.join(root, ".legend-doctor", "subscription-measurements.json"),
      JSON.stringify([invalid]),
    );
    const report = await analyzePath(root);
    assert.equal(report.subscriptionAnalysis!.rejectedMeasurements.length, 1);
    assert.ok(report.subscriptionAnalysis!.plans.every((item) => item.impact.measurement === null));
  }
});
