import type {
  DisabledRule,
  ReportedHookFinding,
  ReportedPracticeFinding,
} from "../../core/types.js";
import type { AnalysisDiagnostic } from "../analysis-project.js";
import type { SubscriptionInventory } from "../../core/subscriptions.js";

export interface AnalysisAccumulator {
  subscriptions: SubscriptionInventory[];
  diagnostics: AnalysisDiagnostic[];
  disabledRules: Map<string, DisabledRule>;
  findings: ReportedHookFinding[];
  practices: ReportedPracticeFinding[];
}

export function emptyAccumulator(): AnalysisAccumulator {
  return {
    diagnostics: [],
    disabledRules: new Map(),
    findings: [],
    practices: [],
    subscriptions: [],
  };
}

/** A file's results join the pass only once its analysis finished, so a skipped file leaves none. */
export function mergeAccumulator(into: AnalysisAccumulator, from: AnalysisAccumulator): void {
  into.diagnostics.push(...from.diagnostics);
  into.findings.push(...from.findings);
  into.practices.push(...from.practices);
  into.subscriptions.push(...from.subscriptions);
  for (const [key, rule] of from.disabledRules) {
    const existing = into.disabledRules.get(key);
    into.disabledRules.set(
      key,
      existing ? { ...existing, files: existing.files + rule.files } : rule,
    );
  }
}
