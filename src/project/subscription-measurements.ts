import type { AnalysisReport } from "../core/types.js";
import type { SubscriptionMeasurement } from "../core/subscriptions.js";
import { applySubscriptionMeasurements } from "../report/subscription-measurements.js";
import path from "node:path";
import { readFile } from "node:fs/promises";

interface JsonObject {
  [key: string]: JsonValue;
}
type JsonValue = boolean | number | string | null | readonly JsonValue[] | JsonObject;

export async function attachSubscriptionMeasurements(
  report: AnalysisReport,
  root: string,
  supplied?: readonly (SubscriptionMeasurement | null)[],
): Promise<void> {
  if (report.subscriptionAnalysis) {
    report.subscriptionAnalysis = applySubscriptionMeasurements(
      report.subscriptionAnalysis,
      supplied ?? (await loadSubscriptionMeasurements(root)),
    );
  }
}

async function loadSubscriptionMeasurements(
  root: string,
): Promise<readonly (SubscriptionMeasurement | null)[]> {
  try {
    const value: JsonValue = JSON.parse(
      await readFile(path.join(root, ".legend-doctor", "subscription-measurements.json"), "utf8"),
    );
    return Array.isArray(value) ? value.map((entry) => parseMeasurement(entry)) : [null];
  } catch (error) {
    if (error instanceof SyntaxError) {
      return [null];
    }
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

function isMissingFile(cause: unknown): cause is Error & { code: "ENOENT" } {
  return (
    cause instanceof Error && Object.getOwnPropertyDescriptor(cause, "code")?.value === "ENOENT"
  );
}
function isObject(value: JsonValue | undefined): value is JsonObject {
  return value instanceof Object && !Array.isArray(value);
}
function isString(value: JsonValue | undefined): value is string {
  return value?.constructor === String;
}
function isCount(value: JsonValue | undefined): value is number {
  return value?.constructor === Number && Number.isSafeInteger(value) && Number(value) >= 0;
}
function parseCounts(value: JsonValue | undefined): SubscriptionMeasurement["before"] | null {
  return isObject(value) && isCount(value.ownerRenders) && isCount(value.siblingRenders)
    ? { ownerRenders: value.ownerRenders, siblingRenders: value.siblingRenders }
    : null;
}
function parseMeasurement(value: JsonValue): SubscriptionMeasurement | null {
  if (
    !isObject(value) ||
    !isString(value.planId) ||
    !isString(value.fingerprint) ||
    !isString(value.scenario) ||
    !value.scenario.trim() ||
    !isCount(value.samples) ||
    value.samples === 0 ||
    value.behaviorEquivalent !== true
  ) {
    return null;
  }
  const before = parseCounts(value.before);
  const after = parseCounts(value.after);
  return before && after
    ? {
        planId: value.planId,
        fingerprint: value.fingerprint,
        scenario: value.scenario,
        samples: value.samples,
        behaviorEquivalent: true,
        before,
        after,
      }
    : null;
}
