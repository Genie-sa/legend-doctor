import type { AnalysisCoverageLedger, AnalysisCoverageTarget } from "../analysis-coverage.js";
import type { AnalysisDiagnostic, AnalysisFile } from "../analysis-project.js";
import type {
  AnalysisReport,
  DisabledRule,
  HookFinding,
  LegendPracticeFinding,
  ReportScope,
} from "../../core/types.js";
import { analyzeSourceFile, findingHookImports } from "../../analysis/analyze-source.js";
import {
  analyzedFileCoverage,
  analyzedFunctionCoverage,
  functionCoverageEntries,
  unsupportedFileCoverage,
} from "./coverage-stages.js";
import type { AnalysisContext } from "./analysis-context.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import type { ConfirmationSet } from "../../analysis/assumptions/confirmations.js";
import type { FileCapabilities } from "../capabilities.js";
import type { FunctionCoverageEntry } from "./coverage-stages.js";
import type { MaterialityPolicy } from "../../analysis/constants.js";
import { ReactCompilerResolver } from "../react-compiler-package.js";
import { SCHEMA_VERSION } from "../../core/types.js";
import { StateFlowIndex } from "../state-flow/state-flow.js";
import { analyzeLegendPracticesFile } from "../../practices/analyze-legend-practices.js";
import { createChildContractResolver } from "./child-contracts.js";
import { disabledEffectRules } from "../../rules/effects/browser-storage-persistence.js";
import { disabledPracticeRules } from "../../practices/practice-rules.js";
import { isSupportedAnalysisFile } from "../analysis-project.js";
import path from "node:path";
import { rankedQuestions } from "../../analysis/assumptions/ranked-questions.js";
import { reportConfirmations } from "../../analysis/assumptions/report-confirmations.js";

interface AnalysisFileEntry {
  analysisFile: AnalysisFile | null;
  file: string;
  functionEntries: FunctionCoverageEntry[];
  reportFileName: string;
}

interface SupportedAnalysisFileEntry extends AnalysisFileEntry {
  analysisFile: AnalysisFile;
}

interface AnalysisFileEntryOptions {
  analysisRoot: string;
  context: AnalysisContext;
  includeDetails: boolean;
}

interface AnalysisPassOptions {
  analysisRoot: string;
  confirmations: ConfirmationSet | null;
  context: AnalysisContext;
  coverage: AnalysisCoverageLedger | null;
  includeDetails: boolean;
  materiality: MaterialityPolicy;
}

interface AnalysisAccumulator {
  diagnostics: AnalysisDiagnostic[];
  disabledRules: Map<string, DisabledRule>;
  findings: HookFinding[];
  practices: LegendPracticeFinding[];
}

interface AnalysisPass extends AnalysisPassOptions {
  accumulator: AnalysisAccumulator;
  compiledFiles: ReadonlySet<string>;
  rootCompiles: boolean;
}

export function analysisFileEntries(
  files: readonly string[],
  options: AnalysisFileEntryOptions,
): AnalysisFileEntry[] {
  return files.map((file) => {
    const reportFileName = path.relative(options.analysisRoot, file) || path.basename(file);
    if (!isSupportedAnalysisFile(file)) {
      return { analysisFile: null, file, functionEntries: [], reportFileName };
    }
    const analysisFile = options.context.project.getFile(file);
    if (!analysisFile) {
      throw new Error(`analysis context does not own target file: ${reportFileName}`);
    }
    return {
      analysisFile,
      file,
      functionEntries: options.includeDetails
        ? functionCoverageEntries(analysisFile, reportFileName)
        : [],
      reportFileName,
    };
  });
}

export function coverageTargets(entries: readonly AnalysisFileEntry[]): AnalysisCoverageTarget[] {
  return entries.flatMap((entry) => [
    { file: entry.reportFileName, kind: "file" as const },
    ...entry.functionEntries.map((functionEntry) => functionEntry.target),
  ]);
}

export async function runAnalysisPass(
  entries: readonly AnalysisFileEntry[],
  options: AnalysisPassOptions,
): Promise<AnalysisPass> {
  const reactCompiler = new ReactCompilerResolver();
  const [compiledFiles, rootCompiles] = await Promise.all([
    reactCompiledFiles(reactCompiler, entries, options.includeDetails),
    reactCompiler.compilesDirectory(options.context.root),
  ]);
  const pass: AnalysisPass = {
    ...options,
    accumulator: { diagnostics: [], disabledRules: new Map(), findings: [], practices: [] },
    compiledFiles,
    rootCompiles,
  };
  for (const entry of entries) {
    analyzeFileEntry(entry, pass);
  }
  return pass;
}

async function reactCompiledFiles(
  reactCompiler: ReactCompilerResolver,
  entries: readonly AnalysisFileEntry[],
  includeDetails: boolean,
): Promise<ReadonlySet<string>> {
  const candidates = entries.filter(
    (entry) =>
      entry.analysisFile !== null &&
      (includeDetails || mayContainLegendPractice(entry.analysisFile)),
  );
  const compiled = await Promise.all(
    candidates.map(async (entry) => ({
      compiles: await reactCompiler.packageCompilesFile(entry.file),
      file: entry.file,
    })),
  );
  return new Set(compiled.filter((entry) => entry.compiles).map((entry) => entry.file));
}

function analyzeFileEntry(entry: AnalysisFileEntry, pass: AnalysisPass): void {
  if (!isSupportedEntry(entry)) {
    pass.coverage?.record({
      stages: unsupportedFileCoverage(),
      target: { file: entry.reportFileName, kind: "file" },
    });
    return;
  }
  if (pass.includeDetails) {
    pass.accumulator.diagnostics.push(
      ...entry.analysisFile.parserDiagnostics.map((diagnostic) => ({
        ...diagnostic,
        file: entry.reportFileName,
      })),
    );
  }
  analyzeSupportedFileEntry(entry, pass);
}

function isSupportedEntry(entry: AnalysisFileEntry): entry is SupportedAnalysisFileEntry {
  return entry.analysisFile !== null;
}

function analyzeSupportedFileEntry(entry: SupportedAnalysisFileEntry, pass: AnalysisPass): void {
  const stateFlow = new StateFlowIndex();
  const hookImports = findingHookImports(entry.analysisFile);
  const analyzeHooks = hookImports !== null || pass.includeDetails;
  const analyzePractices = mayContainLegendPractice(entry.analysisFile) || pass.includeDetails;
  const childContracts =
    analyzeHooks || analyzePractices ? createChildContractResolver(pass.context, entry.file) : null;
  if (analyzeHooks) {
    pass.accumulator.findings.push(...hookFindings(entry, pass, { childContracts, stateFlow }));
  }
  if (analyzePractices) {
    pass.accumulator.practices.push(...legendPracticeFindings(entry, pass, childContracts));
  }
  recordEntryCoverage(entry, pass, stateFlow);
}

interface HookFindingScope {
  readonly childContracts: ChildContractResolver | null;
  readonly stateFlow: StateFlowIndex;
}

function hookFindings(
  entry: SupportedAnalysisFileEntry,
  pass: AnalysisPass,
  { childContracts, stateFlow }: HookFindingScope,
): readonly HookFinding[] {
  const { legendState } = fileCapabilities(entry, pass);
  recordDisabledRules(pass.accumulator.disabledRules, disabledEffectRules(legendState));
  return analyzeSourceFile({
    file: entry.analysisFile,
    legendState,
    reportFileName: entry.reportFileName,
    sourceComponents: pass.context.sourceIndex.componentsFor(entry.file),
    stateFlow,
    childContracts,
    legendValueBridges: pass.context.sourceIndex.legendValueBridgesFor(entry.file),
    deferredCallbackHooks: pass.context.sourceIndex.deferredCallbackHooksFor(entry.file),
    hookImports: findingHookImports(entry.analysisFile),
    materiality: pass.materiality,
    confirmations: pass.confirmations,
    analysisRoot: pass.analysisRoot,
  });
}

function fileCapabilities(entry: SupportedAnalysisFileEntry, pass: AnalysisPass): FileCapabilities {
  return {
    legendState: pass.context.installedLegendState,
    reactCompiler: pass.compiledFiles.has(entry.file),
  };
}

function legendPracticeFindings(
  entry: SupportedAnalysisFileEntry,
  pass: AnalysisPass,
  childContracts: ChildContractResolver | null,
): readonly LegendPracticeFinding[] {
  const capabilities = fileCapabilities(entry, pass);
  const { sourceIndex } = pass.context;
  const importedObservables = new Set([
    ...sourceIndex.observablesFor(entry.file),
    ...sourceIndex.observablePathsFor(entry.file),
  ]);
  const importedObservableFactories = sourceIndex.observableFactoriesFor(entry.file);
  const includeFindings = isLegendPracticeEligible(
    entry.analysisFile,
    importedObservables,
    importedObservableFactories,
  );
  if (includeFindings) {
    recordDisabledRules(pass.accumulator.disabledRules, disabledPracticeRules(capabilities));
  }
  return analyzeLegendPracticesFile({
    capabilities,
    file: entry.analysisFile,
    reportFileName: entry.reportFileName,
    importedObservables,
    importedObservableFactories,
    includeFindings,
    importedObservableArrayPaths: sourceIndex.observableArrayPathsFor(entry.file),
    importedObservableKeys: sourceIndex.observableKeysFor(entry.file),
    childContracts,
  });
}

function recordDisabledRules(
  disabledRules: Map<string, DisabledRule>,
  disabled: readonly Omit<DisabledRule, "files">[],
): void {
  for (const rule of disabled) {
    const key = `${rule.rule}\0${rule.reason}`;
    const entry = disabledRules.get(key) ?? { ...rule, files: 0 };
    disabledRules.set(key, { ...entry, files: entry.files + 1 });
  }
}

function recordEntryCoverage(
  entry: SupportedAnalysisFileEntry,
  pass: AnalysisPass,
  stateFlow: StateFlowIndex,
): void {
  const { coverage } = pass;
  if (!coverage) {
    return;
  }
  coverage.record({
    stages: analyzedFileCoverage({
      file: entry.analysisFile,
      functionEntries: entry.functionEntries,
      stateFlow,
    }),
    target: { file: entry.reportFileName, kind: "file" },
  });
  for (const { node, target } of entry.functionEntries) {
    coverage.record({
      stages: analyzedFunctionCoverage({
        file: entry.analysisFile,
        node,
        stateFlow,
        target,
      }),
      target,
    });
  }
}

export function analysisReport(
  fileCount: number,
  pass: AnalysisPass,
  scope: ReportScope | null = null,
): AnalysisReport {
  const { disabledRules, findings, practices } = pass.accumulator;
  const states = findings.filter((finding) => finding.hook === "useState").length;
  const effects = findings.filter((finding) => finding.hook === "useEffect").length;
  const report: AnalysisReport = {
    files: fileCount,
    findings,
    hooks: { effects, states, total: states + effects },
    practices,
    capabilities: {
      disabledRules: [...disabledRules.values()].toSorted((left, right) =>
        left.rule.localeCompare(right.rule),
      ),
      legendState: pass.context.installedLegendState,
      reactCompiler: pass.rootCompiles,
    },
    schemaVersion: SCHEMA_VERSION,
  };
  return withOptionalSections(report, { findings, pass, scope });
}

interface OptionalReportSections {
  readonly findings: readonly HookFinding[];
  readonly pass: AnalysisPass;
  readonly scope: ReportScope | null;
}

function withOptionalSections(
  report: AnalysisReport,
  { findings, pass, scope }: OptionalReportSections,
): AnalysisReport {
  if (scope) {
    report.scope = scope;
  }
  if (pass.confirmations) {
    report.confirmations = reportConfirmations(pass.confirmations, findings);
  }
  const questions = rankedQuestions(findings);
  if (questions.length > 0) {
    report.questions = questions;
  }
  return report;
}

function isLegendPracticeEligible(
  file: AnalysisFile,
  importedObservables: ReadonlySet<string>,
  importedObservableFactories: ReadonlySet<string>,
): boolean {
  return (
    mayContainLegendPractice(file) &&
    (file.sourceFile.text.includes("@legendapp/state") ||
      importedObservables.size > 0 ||
      importedObservableFactories.size > 0)
  );
}

function mayContainLegendPractice(file: AnalysisFile): boolean {
  const sourceText = file.sourceFile.text;
  return (
    /\.(?:get|set)\s*\(/u.test(sourceText) ||
    /\b(?:useValue|useSelector|use\$)\s*\(/u.test(sourceText)
  );
}
