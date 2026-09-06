import type { Evaluation } from "./model.js";
import type { GoldHookCase } from "../corpus/contracts.js";
import type { HookFinding } from "../../src/core/types.js";
import { goldCases } from "../corpus/hook-cases.js";
import path from "node:path";

interface HookCoverage {
  changes: number;
  inventoried: number;
  labeled: number;
  unlabeledChanges: number;
}

function labelKey(
  target: string,
  hook: Pick<GoldHookCase, "file" | "line" | "hook" | "name">,
): string {
  return JSON.stringify([target, path.normalize(hook.file), hook.line, hook.hook, hook.name]);
}

function findingKey(target: string, finding: HookFinding): string {
  return labelKey(target, { ...finding.location, hook: finding.hook, name: finding.name });
}

/** Coverage is independent of agreement: a wrong prediction at a labeled hook is still scored. */
export function hookCoverage(
  run: Evaluation,
  cases: readonly GoldHookCase[] = goldCases,
): HookCoverage {
  const labels = new Set(cases.map((gold) => labelKey(gold.target, gold)));
  const counts = { changes: 0, inventoried: run.hooks, labeled: 0, unlabeledChanges: 0 };
  for (const [target, result] of run.targets) {
    for (const finding of result.report.findings) {
      const hasLabel = labels.has(findingKey(target, finding));
      counts.labeled += hasLabel ? 1 : 0;
      counts.changes += finding.disposition === "change" ? 1 : 0;
      counts.unlabeledChanges += finding.disposition === "change" && !hasLabel ? 1 : 0;
    }
  }
  return counts;
}

export function hookCoverageSummaryLines(run: Evaluation): string[] {
  const coverage = hookCoverage(run);
  return [
    `Hook label coverage: ${coverage.labeled}/${coverage.inventoried} inventoried hooks.`,
    `Unlabeled change findings: ${coverage.unlabeledChanges}/${coverage.changes} (not precision-scored; grouped members counted individually).`,
  ];
}
