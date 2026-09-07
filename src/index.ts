export { createAnalysisContext } from "./project/analyze-path/analysis-context.js";
export { analyzePath, analyzePathDetailed } from "./project/analyze-path/analyze-path.js";
export { analyzeSource } from "./analysis/analyze-source.js";
export { AnalysisProject, createAnalysisFile } from "./project/analysis-project.js";
export { resolveInstalledLegendState } from "./project/legend-state-package.js";
export { GitScopeError, resolveScopedFiles } from "./project/git-scope.js";
export {
  PRACTICE_RULES,
  disabledPracticeRules,
  enabledPracticeRules,
} from "./practices/practice-rules.js";
export { SCHEMA_VERSION } from "./core/types.js";
export type { ScanScope, ScanScopeMode } from "./project/git-scope.js";
export type { FileCapabilities } from "./project/capabilities.js";
export type {
  DisabledPracticeRule,
  PracticeRule,
  PracticeRuleGate,
  PracticeRuleGateReason,
  PracticeRuleId,
  PracticeRuleInput,
} from "./practices/practice-rules.js";
export type { AnalysisContext } from "./project/analyze-path/analysis-context.js";
export type { DetailedAnalysisResult } from "./project/analyze-path/analyze-path.js";
export type {
  AnalysisCoverageOutcome,
  AnalysisCoverageEntry,
  AnalysisCoverageReport,
  AnalysisCoverageStage,
  AnalysisCoverageStages,
  AnalysisCoverageStatus,
  AnalysisCoverageTarget,
} from "./project/analysis-coverage.js";
export type {
  AnalysisDiagnostic,
  AnalysisDialect,
  AnalysisFile,
} from "./project/analysis-project.js";
export type {
  AbstentionReason,
  AnalysisReport,
  Confidence,
  DisabledRule,
  EffectAction,
  HookAction,
  HookFinding,
  InstalledLegendState,
  LegendPracticeAction,
  LegendPracticeFinding,
  ReportCapabilities,
  ReportScope,
  StateAction,
  SyncExport,
  UseValueExport,
} from "./core/types.js";
