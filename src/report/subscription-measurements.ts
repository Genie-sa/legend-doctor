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
  plans.sort(compareImpact);
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
      savedRenders(rightMeasurement) - savedRenders(leftMeasurement) ||
      left.id.localeCompare(right.id)
    );
  }
  if (leftMeasurement) {
    return savedRenders(leftMeasurement) > 0 ? -1 : 1;
  }
  if (rightMeasurement) {
    return savedRenders(rightMeasurement) > 0 ? 1 : -1;
  }
  return staticCut(right) - staticCut(left) || left.id.localeCompare(right.id);
}

function staticCut(plan: SubscriptionPlan): number {
  return plan.impact.ownerJsxElements - plan.impact.affectedJsxElements;
}

function savedRenders(measurement: SubscriptionMeasurement): number {
  return (
    (measurement.before.ownerRenders +
      measurement.before.siblingRenders -
      measurement.after.ownerRenders -
      measurement.after.siblingRenders) /
    measurement.samples
  );
}
