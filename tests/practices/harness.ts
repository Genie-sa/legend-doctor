import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";

export const requireValue = <Value>(value: Value | undefined): Value => {
  assert.ok(value);
  return value;
};

export function actions(source: string): string[] {
  return analyzeLegendPractices({ sourceText: source, fileName: "fixture.ts" }).map(
    (finding) => finding.action,
  );
}
