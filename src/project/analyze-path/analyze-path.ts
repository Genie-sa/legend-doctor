import type { AnalysisDiagnostic, AnalysisFile } from "../analysis-project.js";
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
import type { AnalysisReport } from "../../core/types.js";
import type { ConfirmationSet } from "../../analysis/assumptions/confirmations.js";
import { DEFAULT_MATERIALITY } from "../../analysis/constants.js";
import type { MaterialityPolicy } from "../../analysis/constants.js";
import type { SemanticContextDiagnostic } from "../semantic-context/model.js";
import path from "node:path";
import { pathIdentityKey } from "../../core/path-identity.js";
import { stat } from "node:fs/promises";

export interface DetailedAnalysisResult {
  coverage: AnalysisCoverageReport;
  diagnostics: {
    parser: readonly AnalysisDiagnostic[];
    semantic: readonly SemanticContextDiagnostic[];
  };
  report: AnalysisReport;
}

export interface AnalyzePathOptions {
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
  }: AnalyzePathOptions,
  includeDetails: boolean,
): Promise<AnalysisReport | DetailedAnalysisResult> {
  const target = await resolveAnalysisTarget(targetPath);
  const context = sharedContext ?? (await createTargetContext(target));
  const analyzedFiles = fileFilter ? target.files.filter(fileFilter) : target.files;
  const entries = analysisFileEntries(analyzedFiles, {
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
    analyzedFiles.length,
    pass,
    fileFilter ? { contextFiles: target.files.length } : null,
  );
  if (!coverage) {
    return report;
  }
  return {
    coverage: coverage.report(),
    diagnostics: {
      parser: pass.accumulator.diagnostics,
      semantic: displaySemanticDiagnostics(
        context.semanticDiagnostics,
        entries.flatMap((entry) => (entry.analysisFile ? [entry.analysisFile] : [])),
        target.analysisRoot,
      ),
    },
    report,
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
    ? createAnalysisContextFromFiles(target.analysisRoot, target.files, {})
    : createAnalysisContext(target.analysisRoot);
}

function displaySemanticDiagnostics(
  diagnostics: readonly SemanticContextDiagnostic[],
  files: readonly AnalysisFile[],
  root: string,
): SemanticContextDiagnostic[] {
  const fileKeys = new Set(files.map((file) => pathIdentityKey(file.identityPath)));
  return diagnostics
    .filter(
      (diagnostic) =>
        !diagnostic.fileName ||
        diagnostic.code === "config-invalid" ||
        diagnostic.code === "config-read-failed" ||
        fileKeys.has(pathIdentityKey(diagnostic.fileName)),
    )
    .map((diagnostic) => {
      if (!diagnostic.fileName) {
        return { ...diagnostic, message: portableDiagnosticMessage(diagnostic.message, root) };
      }
      const fileName =
        path.relative(root, diagnostic.fileName) || path.basename(diagnostic.fileName);
      return {
        ...diagnostic,
        fileName,
        message: portableDiagnosticMessage(
          diagnostic.message.replaceAll(diagnostic.fileName, fileName),
          root,
        ),
      };
    });
}

function portableDiagnosticMessage(message: string, root: string): string {
  return message.replaceAll(`${path.resolve(root)}${path.sep}`, "");
}
