import type {
  SubscriptionAnalysis,
  SubscriptionMeasurement,
  SubscriptionPlan,
} from "../core/subscriptions.js";

export function applySubscriptionMeasurements(
  analysis: SubscriptionAnalysis,
  measurements: readonly (SubscriptionMeasurement | null)[],
): SubscriptionAnalysis {
  const plans: SubscriptionPlan[] = analysis.plans.map((plan) => ({
    ...plan,
    impact: { ...plan.impact, basis: "static-jsx" as const, measurement: null },
  }));
  const rejectedMeasurements = attachMeasurements(plans, measurements);
  // Choose one ordering for the whole batch: pairwise fallback can produce comparator cycles.
  plans.sort(comparableMeasurements(plans) ? compareImpact : compareStaticImpact);
  return {
    ...analysis,
    rejectedMeasurements,
    plans: plans.map((plan, index) => ({ ...plan, rank: index + 1 })),
  };
}

function attachMeasurements(
  plans: SubscriptionPlan[],
  measurements: readonly (SubscriptionMeasurement | null)[],
): SubscriptionAnalysis["rejectedMeasurements"] {
  const rejectedMeasurements: SubscriptionAnalysis["rejectedMeasurements"] = [];
  const seen = new Set<string>();
  for (const measurement of measurements) {
    const plan = measurement && plans.find((candidate) => candidate.id === measurement.planId);
    if (
      !measurement ||
      !plan ||
      plan.fingerprint !== measurement.fingerprint ||
      seen.has(measurement.planId)
    ) {
      rejectedMeasurements.push({
        planId: measurement?.planId ?? "invalid",
        reason: "invalid, stale, duplicate, or unmatched measurement",
      });
      continue;
    }
    seen.add(measurement.planId);
    plan.impact = { ...plan.impact, basis: "provided-runtime-measurement", measurement };
  }
  return rejectedMeasurements;
}

function compareImpact(left: SubscriptionPlan, right: SubscriptionPlan): number {
  const leftMeasurement = left.impact.measurement;
  const rightMeasurement = right.impact.measurement;
  if (leftMeasurement && rightMeasurement) {
    return (
      Number(
        savedRenders(rightMeasurement) * BigInt(leftMeasurement.samples) -
          savedRenders(leftMeasurement) * BigInt(rightMeasurement.samples),
      ) || left.id.localeCompare(right.id)
    );
  }
  if (leftMeasurement) {
    return savedRenders(leftMeasurement) > 0n ? -1 : 1;
  }
  if (rightMeasurement) {
    return savedRenders(rightMeasurement) > 0n ? 1 : -1;
  }
  return compareStaticImpact(left, right);
}

function staticCut(plan: SubscriptionPlan): number {
  return plan.impact.ownerJsxElements - plan.impact.affectedJsxElements;
}

function savedRenders(measurement: SubscriptionMeasurement): bigint {
  // Individual counts are safe integers, but their sums and per-sample cross-products may not be.
  return (
    BigInt(measurement.before.ownerRenders) +
    BigInt(measurement.before.siblingRenders) -
    BigInt(measurement.after.ownerRenders) -
    BigInt(measurement.after.siblingRenders)
  );
}

function compareStaticImpact(left: SubscriptionPlan, right: SubscriptionPlan): number {
  return staticCut(right) - staticCut(left) || left.id.localeCompare(right.id);
}

function comparableMeasurements(plans: readonly SubscriptionPlan[]): boolean {
  const measurements = plans.flatMap((plan) =>
    plan.impact.measurement ? [plan.impact.measurement] : [],
  );
  if (measurements.every((measurement) => !measurement.environment)) {
    // Preserve legacy render-only ranking.
    return true;
  }
  const [first] = measurements;
  return measurements.every(
    (measurement) =>
      measurement.environment !== undefined &&
      first?.environment !== undefined &&
      measurement.scenario === first.scenario &&
      measurement.environment.runtime === first.environment.runtime &&
      measurement.environment.platform === first.environment.platform &&
      measurement.environment.configuration === first.environment.configuration,
  );
}
