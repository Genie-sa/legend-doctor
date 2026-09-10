import {
  analysisFileEntries,
  analysisReport,
  coverageTargets,
  runAnalysisPass,
} from "./analysis-pass.js";
import {
  collectSourceFiles,
  createAnalysisContext,
  createAnalysisContextFromFiles,
} from "./analysis-context.js";
import type { AnalysisContext } from "./analysis-context.js";
import { AnalysisCoverageLedger } from "../analysis-coverage.js";
import type { AnalysisCoverageReport } from "../analysis-coverage.js";
import type { AnalysisDiagnostic } from "../analysis-project.js";
import type { AnalysisReport } from "../../core/types.js";
import type { ConfirmationSet } from "../../analysis/assumptions/confirmations.js";
import { DEFAULT_MATERIALITY } from "../../analysis/constants.js";
import type { MaterialityPolicy } from "../../analysis/constants.js";
import type { SubscriptionMeasurement } from "../../core/subscriptions.js";
import { attachSubscriptionMeasurements } from "../subscription-measurements.js";
import path from "node:path";
import { stat } from "node:fs/promises";
import ts from "typescript";

export interface DetailedAnalysisResult {
  coverage: AnalysisCoverageReport;
  diagnostics: {
    parser: readonly AnalysisDiagnostic[];
  };
  report: AnalysisReport;
}

export interface AnalyzePathOptions {
  readonly subscriptionMeasurements?: readonly (SubscriptionMeasurement | null)[];
  /** Answered review questions to honour; a confirmed id converts its review finding. */
  readonly confirmations?: ConfirmationSet | null;
  /**
   * Analyze only the target files this predicate accepts. Every target file still loads into
   * the cross-file context, so proofs for the accepted files see the whole program.
   */
  readonly fileFilter?: (absolutePath: string) => boolean;
  readonly materiality?: MaterialityPolicy;
  readonly sharedContext?: AnalysisContext | undefined;
}

export function analyzePath(
  targetPath: string,
  options: AnalyzePathOptions = {},
): Promise<AnalysisReport> {
  return analyzePathInternal(targetPath, options, false);
}

export function analyzePathDetailed(
  targetPath: string,
  options: AnalyzePathOptions = {},
): Promise<DetailedAnalysisResult> {
  return analyzePathInternal(targetPath, options, true);
}

async function analyzePathInternal(
  targetPath: string,
  options: AnalyzePathOptions,
  includeDetails: false,
): Promise<AnalysisReport>;

async function analyzePathInternal(
  targetPath: string,
  options: AnalyzePathOptions,
  includeDetails: true,
): Promise<DetailedAnalysisResult>;

async function analyzePathInternal(
  targetPath: string,
  {
    confirmations = null,
    fileFilter,
    materiality = DEFAULT_MATERIALITY,
    sharedContext,
    subscriptionMeasurements,
  }: AnalyzePathOptions,
  includeDetails: boolean,
): Promise<AnalysisReport | DetailedAnalysisResult> {
  const target = await resolveAnalysisTarget(targetPath);
  const context = sharedContext ?? (await createTargetContext(target));
  const entries = analysisFileEntries(fileFilter ? target.files.filter(fileFilter) : target.files, {
    analysisRoot: target.analysisRoot,
    context,
    includeDetails,
  });
  const coverage = includeDetails ? new AnalysisCoverageLedger(coverageTargets(entries)) : null;
  const pass = await runAnalysisPass(entries, {
    analysisRoot: target.analysisRoot,
    confirmations,
    context,
    coverage,
    includeDetails,
    materiality,
  });
  const report = analysisReport(
    entries.length,
    pass,
    fileFilter ? { contextFiles: target.files.length } : null,
  );
  await attachSubscriptionMeasurements(report, target.analysisRoot, subscriptionMeasurements);
  if (!coverage) {
    return report;
  }
  return {
    coverage: sourceCoverageReport(coverage, entries, { context, root: target.analysisRoot }),
    diagnostics: {
      parser: pass.accumulator.diagnostics,
    },
    report,
  };
}

function sourceCoverageReport(
  coverage: AnalysisCoverageLedger,
  entries: readonly { file: string; reportFileName: string }[],
  { context, root }: { context: AnalysisContext; root: string },
): AnalysisCoverageReport {
  const relative = (file: string): string =>
    path.relative(ts.sys.realpath?.(root) ?? root, ts.sys.realpath?.(file) ?? file);
  return {
    ...coverage.report(),
    sourceContext: entries.map((entry) => {
      const source = context.sourceIndex.sourceContextFor(entry.file);
      return {
        ...source,
        file: entry.reportFileName,
        unavailable: source.unavailable.map((edge) => ({
          ...edge,
          importer: relative(edge.importer),
          resolvedFile: edge.resolvedFile === null ? null : relative(edge.resolvedFile),
        })),
      };
    }),
  };
}

interface AnalysisTarget {
  analysisRoot: string;
  files: readonly string[];
  isDirectory: boolean;
}

async function resolveAnalysisTarget(targetPath: string): Promise<AnalysisTarget> {
  const absoluteTarget = path.resolve(targetPath);
  const targetStats = await stat(absoluteTarget);
  const isDirectory = targetStats.isDirectory();
  return {
    analysisRoot: isDirectory ? absoluteTarget : path.dirname(absoluteTarget),
    files: isDirectory ? await collectSourceFiles(absoluteTarget) : [absoluteTarget],
    isDirectory,
  };
}

function createTargetContext(target: AnalysisTarget): Promise<AnalysisContext> {
  return target.isDirectory
    ? createAnalysisContextFromFiles(target.analysisRoot, target.files)
    : createAnalysisContext(target.analysisRoot);
}
