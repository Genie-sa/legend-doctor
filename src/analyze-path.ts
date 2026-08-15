import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import { analyzeLegendPracticesFile } from "./analyze-legend-practices.js";
import { analyzeSourceFile } from "./analyze-source.js";
import { isRuntimeFunctionLike, type RuntimeFunctionLike } from "./ast.js";
import {
  AnalysisCoverageLedger,
  type AnalysisCoverageOutcome,
  type AnalysisCoverageReport,
  type AnalysisCoverageStages,
  type AnalysisCoverageTarget,
} from "./analysis-coverage.js";
import {
  AnalysisProject,
  isSupportedAnalysisFile,
  type AnalysisDiagnostic,
  type AnalysisFile,
} from "./analysis-project.js";
import {
  createSemanticContext,
  type SemanticContext,
  type SemanticContextDiagnostic,
} from "./semantic-context.js";
import { pathIdentityKey } from "./path-identity.js";
import { buildSourceIndexFromFiles, type SourceIndex } from "./source-components.js";
import { StateFlowIndex, type StateFlowCoverage } from "./state-flow.js";
import type { AnalysisReport, HookFinding, LegendPracticeFinding } from "./types.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

export interface AnalysisContext {
  project: AnalysisProject;
  semanticContext: SemanticContext | null;
  semanticDiagnostics: readonly SemanticContextDiagnostic[];
  sourceIndex: SourceIndex;
  root: string;
}

export interface DetailedAnalysisResult {
  coverage: AnalysisCoverageReport;
  diagnostics: {
    parser: readonly AnalysisDiagnostic[];
    semantic: readonly SemanticContextDiagnostic[];
  };
  report: AnalysisReport;
}

export interface AnalysisContextOptions {
  /** Build one fail-closed semantic shard from this explicit tsconfig. */
  configFilePath?: string;
}

export async function createAnalysisContext(
  rootPath: string,
  options: AnalysisContextOptions = {}
): Promise<AnalysisContext> {
  const root = path.resolve(rootPath);
  const files = await collectSourceFiles(root);
  const sources = new Map<string, string>();
  for (const file of files) sources.set(file, await readFile(file, "utf8"));
  const project = new AnalysisProject(sources);
  const semantic = options.configFilePath
    ? createSemanticContext(project, { configFilePath: options.configFilePath })
    : { context: null, diagnostics: [] };
  return {
    project,
    semanticContext: semantic.context,
    semanticDiagnostics: semantic.diagnostics,
    sourceIndex: buildSourceIndexFromFiles(root, project.files),
    root,
  };
}

export async function analyzePath(
  targetPath: string,
  sharedContext?: AnalysisContext
): Promise<AnalysisReport> {
  return (await analyzePathDetailed(targetPath, sharedContext)).report;
}

export async function analyzePathDetailed(
  targetPath: string,
  sharedContext?: AnalysisContext
): Promise<DetailedAnalysisResult> {
  const absoluteTarget = path.resolve(targetPath);
  const targetStats = await stat(absoluteTarget);
  const analysisRoot = targetStats.isDirectory() ? absoluteTarget : path.dirname(absoluteTarget);
  const files = targetStats.isDirectory() ? await collectSourceFiles(absoluteTarget) : [absoluteTarget];
  const context = sharedContext ?? await createAnalysisContext(analysisRoot);
  const findings: HookFinding[] = [];
  const practices: LegendPracticeFinding[] = [];
  const analysisFiles = files.map(file => {
    const reportFileName = path.relative(analysisRoot, file) || path.basename(file);
    if (!isSupportedAnalysisFile(file)) {
      return { analysisFile: null, file, functionEntries: [], reportFileName };
    }
    const analysisFile = context.project.getFile(file);
    if (!analysisFile) {
      throw new Error(`analysis context does not own target file: ${reportFileName}`);
    }
    return {
      analysisFile,
      file,
      functionEntries: functionCoverageEntries(analysisFile, reportFileName),
      reportFileName,
    };
  });
  const coverageTargets: AnalysisCoverageTarget[] = analysisFiles.flatMap(entry => [
    { kind: "file" as const, file: entry.reportFileName },
    ...entry.functionEntries.map(functionEntry => functionEntry.target),
  ]);
  const coverage = new AnalysisCoverageLedger(coverageTargets);
  const diagnostics: AnalysisDiagnostic[] = [];
  for (const { analysisFile, file, functionEntries, reportFileName } of analysisFiles) {
    if (!analysisFile) {
      coverage.record({
        target: { kind: "file", file: reportFileName },
        stages: unsupportedFileCoverage(),
      });
      continue;
    }
    diagnostics.push(
      ...analysisFile.parserDiagnostics.map(diagnostic => ({
        ...diagnostic,
        file: reportFileName,
      }))
    );
    const stateFlow = new StateFlowIndex();
    findings.push(
      ...analyzeSourceFile(
        analysisFile,
        reportFileName,
        context.sourceIndex.componentsFor(file),
        stateFlow
      )
    );
    const importedObservables = context.sourceIndex.observablesFor(file);
    const importedObservableFactories = context.sourceIndex.observableFactoriesFor(file);
    practices.push(
      ...analyzeLegendPracticesFile(
        analysisFile,
        reportFileName,
        importedObservables,
        importedObservableFactories,
        isLegendPracticeEligible(
          analysisFile,
          importedObservables,
          importedObservableFactories
        )
      )
    );
    const stages = analyzedFileCoverage(analysisFile, context, functionEntries, stateFlow);
    coverage.record({
      target: { kind: "file", file: reportFileName },
      stages,
    });
    for (const { node, target } of functionEntries) {
      coverage.record({
        target,
        stages: analyzedFunctionCoverage(analysisFile, context, target, node, stateFlow),
      });
    }
  }

  const states = findings.filter(finding => finding.hook === "useState").length;
  const effects = findings.filter(finding => finding.hook === "useEffect").length;
  return {
    coverage: coverage.report(),
    diagnostics: {
      parser: diagnostics,
      semantic: displaySemanticDiagnostics(
        context.semanticDiagnostics,
        analysisFiles.flatMap(entry => entry.analysisFile ? [entry.analysisFile] : []),
        analysisRoot
      ),
    },
    report: {
      files: files.length,
      findings,
      hooks: { effects, states, total: states + effects },
      practices,
    },
  };
}

interface FunctionCoverageEntry {
  node: RuntimeFunctionLike;
  target: Extract<AnalysisCoverageTarget, { kind: "function" }>;
}

function functionCoverageEntries(
  file: AnalysisFile,
  reportFileName: string
): FunctionCoverageEntry[] {
  const entries: FunctionCoverageEntry[] = [];
  const sourceFile = file.sourceFile;
  const visit = (node: ts.Node): void => {
    if (isRuntimeFunctionLike(node) && node.body) {
      entries.push({
        node,
        target: {
          kind: "function",
          file: reportFileName,
          name: runtimeFunctionName(node),
          start: node.getStart(sourceFile),
          end: node.end,
        },
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return entries;
}

function runtimeFunctionName(node: RuntimeFunctionLike): string | null {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (node.name) return node.name.getText(node.getSourceFile());
  const parent = node.parent;
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
    ? parent.name.text
    : null;
}

function displaySemanticDiagnostics(
  diagnostics: readonly SemanticContextDiagnostic[],
  files: readonly AnalysisFile[],
  root: string
): SemanticContextDiagnostic[] {
  const fileKeys = new Set(files.map(file => pathIdentityKey(file.identityPath)));
  return diagnostics
    .filter(diagnostic =>
      !diagnostic.fileName ||
      diagnostic.code === "config-invalid" ||
      diagnostic.code === "config-read-failed" ||
      fileKeys.has(pathIdentityKey(diagnostic.fileName))
    )
    .map(diagnostic => {
      if (!diagnostic.fileName) {
        return { ...diagnostic, message: portableDiagnosticMessage(diagnostic.message, root) };
      }
      const fileName = path.relative(root, diagnostic.fileName) || path.basename(diagnostic.fileName);
      return {
        ...diagnostic,
        fileName,
        message: portableDiagnosticMessage(
          diagnostic.message.replaceAll(diagnostic.fileName, fileName),
          root
        ),
      };
    });
}

function isLegendPracticeEligible(
  file: AnalysisFile,
  importedObservables: ReadonlySet<string>,
  importedObservableFactories: ReadonlySet<string>
): boolean {
  const sourceText = file.sourceFile.text;
  const mayContainPractice =
    /\.(?:get|set)\s*\(/.test(sourceText) || /\buseValue\s*\(/.test(sourceText);
  return mayContainPractice &&
    (sourceText.includes("@legendapp/state") ||
      importedObservables.size > 0 ||
      importedObservableFactories.size > 0);
}

function portableDiagnosticMessage(message: string, root: string): string {
  return message.replaceAll(`${path.resolve(root)}${path.sep}`, "");
}

function outcome(
  status: AnalysisCoverageOutcome["status"],
  code: string,
  message: string
): AnalysisCoverageOutcome {
  return { status, reason: { code, message } };
}

function analyzedFileCoverage(
  file: AnalysisFile,
  context: AnalysisContext,
  functionEntries: readonly FunctionCoverageEntry[],
  stateFlow: StateFlowIndex
): AnalysisCoverageStages {
  const recovered = file.parserDiagnostics.length > 0;
  return {
    parser: recovered
      ? outcome("analyzed", "parser-recovered", "The parser recovered with reported diagnostics.")
      : outcome("analyzed", "parser-complete", "The source parsed without recovery diagnostics."),
    lowering: boundedFlowCoverage(
      recovered ? "unknown" : aggregateStateFlowCoverage(functionEntries, stateFlow),
      "file"
    ),
    semantic: semanticCoverage(file, context),
    detector: recovered
      ? outcome("unknown", "detector-recovery-uncertain", "Detectors ran, but results in recovered source regions are not trusted as complete.")
      : outcome("analyzed", "detectors-complete", "All current source detectors ran on the cached AST."),
  };
}

function analyzedFunctionCoverage(
  file: AnalysisFile,
  context: AnalysisContext,
  target: Extract<AnalysisCoverageTarget, { kind: "function" }>,
  node: RuntimeFunctionLike,
  stateFlow: StateFlowIndex
): AnalysisCoverageStages {
  const recovered = file.parserDiagnostics.some(diagnostic =>
    diagnosticAffectsTarget(diagnostic, target)
  );
  return {
    parser: recovered
      ? outcome("analyzed", "parser-recovered-in-function", "The parser recovered within this function range.")
      : outcome("analyzed", "parser-complete", "No parser recovery diagnostic overlaps this function."),
    lowering: boundedFlowCoverage(recovered ? "unknown" : stateFlow.coverageFor(node), "function"),
    semantic: semanticCoverage(file, context),
    detector: recovered
      ? outcome("unknown", "detector-recovery-uncertain", "Detectors ran, but results in this recovered function are not trusted as complete.")
      : outcome("analyzed", "detectors-complete", "All current source detectors ran on this cached function AST."),
  };
}

function aggregateStateFlowCoverage(
  entries: readonly FunctionCoverageEntry[],
  stateFlow: StateFlowIndex
): StateFlowCoverage {
  const outcomes = entries.map(entry => stateFlow.coverageFor(entry.node));
  if (outcomes.includes("unknown")) return "unknown";
  return outcomes.includes("complete") ? "complete" : "not-requested";
}

function boundedFlowCoverage(
  coverage: StateFlowCoverage,
  scope: "file" | "function"
): AnalysisCoverageOutcome {
  if (coverage === "complete") {
    return outcome(
      "analyzed",
      "bounded-flow-complete",
      `Every requested bounded state-flow proof in this ${scope} completed.`
    );
  }
  if (coverage === "unknown") {
    return outcome(
      "unknown",
      "bounded-flow-uncertain",
      `At least one bounded state-flow proof in this ${scope} encountered unsupported or recovered control flow.`
    );
  }
  return outcome(
    "skipped",
    "bounded-flow-not-requested",
    `No detector requested a bounded state-flow proof in this ${scope}.`
  );
}

function diagnosticAffectsTarget(
  diagnostic: AnalysisDiagnostic,
  target: Extract<AnalysisCoverageTarget, { kind: "function" }>
): boolean {
  if (diagnostic.start === null) return true;
  if (!diagnostic.length) {
    return diagnostic.start >= target.start && diagnostic.start <= target.end;
  }
  const end = diagnostic.start + diagnostic.length;
  return diagnostic.start < target.end && end > target.start;
}

function semanticCoverage(
  file: AnalysisFile,
  context: AnalysisContext
): AnalysisCoverageOutcome {
  if (context.semanticContext?.getSourceFile(file)) {
    return outcome("analyzed", "semantic-complete", "Semantic facts are available from the selected tsconfig shard.");
  }
  if (context.semanticContext) {
    return outcome("unknown", "semantic-file-not-owned", "The selected semantic shard does not own this file.");
  }
  return context.semanticDiagnostics.length > 0
    ? outcome("unknown", "semantic-unavailable", "The requested semantic context could not be created.")
    : outcome("skipped", "semantic-not-requested", "Semantic project analysis was not requested.");
}

function unsupportedFileCoverage(): AnalysisCoverageStages {
  return {
    parser: outcome("unsupported", "unsupported-extension", "This file extension is not supported."),
    lowering: outcome("unsupported", "unsupported-extension", "This file extension is not supported."),
    semantic: outcome("unsupported", "unsupported-extension", "This file extension is not supported."),
    detector: outcome("unsupported", "unsupported-extension", "This file extension is not supported."),
  };
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(entryPath);
      } else if (entry.isFile() && isSupportedAnalysisFile(entry.name)) {
        files.push(entryPath);
      }
    }
  }
  await walk(root);
  return files;
}
