import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";

export const requireValue = <Value>(value: Value | undefined): Value => {
  assert.ok(value);
  return value;
};

export function actions(source: string): string[] {
  return analyzeSource(source, "fixture.tsx").map((finding) => finding.action);
}
