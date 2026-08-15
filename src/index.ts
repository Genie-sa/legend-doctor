export {
  analyzePath,
  analyzePathDetailed,
  createAnalysisContext,
} from "./analyze-path.js";
export { analyzeSource } from "./analyze-source.js";
export { AnalysisProject, createAnalysisFile } from "./analysis-project.js";
export { createSemanticContext } from "./semantic-context.js";
export { formatTextReport } from "./format.js";
export type {
  AnalysisContext,
  AnalysisContextOptions,
  DetailedAnalysisResult,
} from "./analyze-path.js";
export type {
  AnalysisCoverageOutcome,
  AnalysisCoverageEntry,
  AnalysisCoverageReport,
  AnalysisCoverageStage,
  AnalysisCoverageStages,
  AnalysisCoverageStatus,
  AnalysisCoverageTarget,
} from "./analysis-coverage.js";
export type {
  AnalysisDiagnostic,
  AnalysisDialect,
  AnalysisFile,
} from "./analysis-project.js";
export type {
  CreateSemanticContextOptions,
  ImportProvenance,
  SemanticContext,
  SemanticContextDiagnostic,
  SemanticContextResult,
} from "./semantic-context.js";
export type {
  AnalysisReport,
  Confidence,
  EffectAction,
  HookAction,
  HookFinding,
  LegendPracticeAction,
  LegendPracticeFinding,
  StateAction,
} from "./types.js";
