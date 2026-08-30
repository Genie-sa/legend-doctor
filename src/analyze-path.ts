import type {
  AnalysisCoverageOutcome,
  AnalysisCoverageReport,
  AnalysisCoverageStages,
  AnalysisCoverageTarget,
} from "./analysis-coverage.js";
import type { AnalysisDiagnostic, AnalysisFile } from "./analysis-project.js";
import { AnalysisProject, isSupportedAnalysisFile } from "./analysis-project.js";
import type { AnalysisReport, HookFinding, LegendPracticeFinding } from "./types.js";
import type {
  CallbackContractSourceResolver,
  ChildComponentSource,
  ChildContractResolver,
} from "./rules/child-contract.js";
import type { SemanticContext, SemanticContextDiagnostic } from "./semantic-context.js";
import type {
  SourceHookDeclaration,
  SourceHookResolver,
} from "./rules/source-callback-contract.js";
import { analyzeSourceFile, findingHookImports } from "./analyze-source.js";
import {
  collectReactComponentWrappers,
  isReactComponentWrapper,
} from "./react-component-wrappers.js";
import { isNonProductionHarness, isRuntimeFunctionLike } from "./ast.js";
import {
  propCallbackIsDeferred,
  propCallbackRunsOnlyInReactEffect,
  propDefersArrayItemCallback,
  propObjectCallbackIsDeferred,
} from "./rules/child-contract.js";
import { readFile, readdir, stat } from "node:fs/promises";
import { AnalysisCoverageLedger } from "./analysis-coverage.js";
import type { InstalledLegendState } from "./legend-state-package.js";
import { ReactCompilerResolver } from "./react-compiler-package.js";
import type { ReactComponentWrappers } from "./react-component-wrappers.js";
import type { RuntimeFunctionLike } from "./ast.js";
import type { SourceIndex } from "./source-components.js";
import type { StateFlowCoverage } from "./state-flow.js";
import { StateFlowIndex } from "./state-flow.js";
import { analyzeLegendPracticesFile } from "./analyze-legend-practices.js";
import { buildSourceIndexFromFiles } from "./source-components.js";
import { createSemanticContext } from "./semantic-context.js";
import { keyedCursorConsumerResult } from "./rules/hook-keyed-cursor-contract.js";
import path from "node:path";
import { pathIdentityKey } from "./path-identity.js";
import { resolveInstalledLegendState } from "./legend-state-package.js";
import { sourceHookDefersCallback } from "./rules/source-callback-contract.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "./analysis-ast.js";

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
const SOURCE_READ_BATCH_SIZE = 64;
const HOOK_BINDING_PATTERN = /^use[A-Z0-9]/u;

interface ComponentDeclarationQuery {
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>;
  file: string;
  localName: string;
  sourceFile: ts.SourceFile;
}

export interface AnalysisContext {
  installedLegendState: InstalledLegendState | null;
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
  options: AnalysisContextOptions = {},
): Promise<AnalysisContext> {
  const root = path.resolve(rootPath);
  const files = await collectSourceFiles(root);
  return createAnalysisContextFromFiles(root, files, options);
}

async function createAnalysisContextFromFiles(
  root: string,
  files: readonly string[],
  options: AnalysisContextOptions,
): Promise<AnalysisContext> {
  const sources = new Map<string, string>();
  await readSourceBatch(files, 0, sources);
  const project = new AnalysisProject(sources);
  const semantic = options.configFilePath
    ? createSemanticContext(project, { configFilePath: options.configFilePath })
    : { context: null, diagnostics: [] };
  return {
    installedLegendState: await resolveInstalledLegendState(root),
    project,
    root,
    semanticContext: semantic.context,
    semanticDiagnostics: semantic.diagnostics,
    sourceIndex: buildSourceIndexFromFiles(root, project.files),
  };
}

async function readSourceBatch(
  files: readonly string[],
  start: number,
  sources: Map<string, string>,
): Promise<void> {
  if (start >= files.length) {
    return;
  }
  const batch = files.slice(start, start + SOURCE_READ_BATCH_SIZE);
  const results = await Promise.allSettled(batch.map((file) => readFile(file, "utf8")));
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      throw result.reason;
    }
    sources.set(batch[index]!, result.value);
  }
  await readSourceBatch(files, start + SOURCE_READ_BATCH_SIZE, sources);
}

export function analyzePath(
  targetPath: string,
  sharedContext?: AnalysisContext,
): Promise<AnalysisReport> {
  return analyzePathInternal(targetPath, sharedContext, false);
}

export function analyzePathDetailed(
  targetPath: string,
  sharedContext?: AnalysisContext,
): Promise<DetailedAnalysisResult> {
  return analyzePathInternal(targetPath, sharedContext, true);
}

async function analyzePathInternal(
  targetPath: string,
  sharedContext: AnalysisContext | undefined,
  includeDetails: false,
): Promise<AnalysisReport>;
async function analyzePathInternal(
  targetPath: string,
  sharedContext: AnalysisContext | undefined,
  includeDetails: true,
): Promise<DetailedAnalysisResult>;
async function analyzePathInternal(
  targetPath: string,
  sharedContext: AnalysisContext | undefined,
  includeDetails: boolean,
): Promise<AnalysisReport | DetailedAnalysisResult> {
  const target = await resolveAnalysisTarget(targetPath);
  const context = sharedContext ?? (await createTargetContext(target));
  const entries = analysisFileEntries(target.files, {
    analysisRoot: target.analysisRoot,
    context,
    includeDetails,
  });
  const coverage = includeDetails ? new AnalysisCoverageLedger(coverageTargets(entries)) : null;
  const pass = await runAnalysisPass(entries, { context, coverage, includeDetails });
  const report = analysisReport(target.files.length, pass);
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
  context: AnalysisContext;
  coverage: AnalysisCoverageLedger | null;
  includeDetails: boolean;
}

interface AnalysisAccumulator {
  diagnostics: AnalysisDiagnostic[];
  findings: HookFinding[];
  practices: LegendPracticeFinding[];
}

interface AnalysisPass extends AnalysisPassOptions {
  accumulator: AnalysisAccumulator;
  compiledFiles: ReadonlySet<string>;
}

function analysisFileEntries(
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

function coverageTargets(entries: readonly AnalysisFileEntry[]): AnalysisCoverageTarget[] {
  return entries.flatMap((entry) => [
    { file: entry.reportFileName, kind: "file" as const },
    ...entry.functionEntries.map((functionEntry) => functionEntry.target),
  ]);
}

async function runAnalysisPass(
  entries: readonly AnalysisFileEntry[],
  options: AnalysisPassOptions,
): Promise<AnalysisPass> {
  const pass: AnalysisPass = {
    ...options,
    accumulator: { diagnostics: [], findings: [], practices: [] },
    compiledFiles: await reactCompiledFiles(entries, options.includeDetails),
  };
  for (const entry of entries) {
    analyzeFileEntry(entry, pass);
  }
  return pass;
}

async function reactCompiledFiles(
  entries: readonly AnalysisFileEntry[],
  includeDetails: boolean,
): Promise<ReadonlySet<string>> {
  const reactCompiler = new ReactCompilerResolver();
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
    pass.accumulator.findings.push(
      ...analyzeSourceFile({
        file: entry.analysisFile,
        reportFileName: entry.reportFileName,
        sourceComponents: pass.context.sourceIndex.componentsFor(entry.file),
        stateFlow,
        childContracts,
        legendValueBridges: pass.context.sourceIndex.legendValueBridgesFor(entry.file),
        deferredCallbackHooks: pass.context.sourceIndex.deferredCallbackHooksFor(entry.file),
        hookImports,
      }),
    );
  }
  if (analyzePractices) {
    pass.accumulator.practices.push(...legendPracticeFindings(entry, pass, childContracts));
  }
  recordEntryCoverage(entry, pass, stateFlow);
}

function legendPracticeFindings(
  entry: SupportedAnalysisFileEntry,
  pass: AnalysisPass,
  childContracts: ChildContractResolver | null,
): readonly LegendPracticeFinding[] {
  const { sourceIndex } = pass.context;
  const importedObservables = new Set([
    ...sourceIndex.observablesFor(entry.file),
    ...sourceIndex.observablePathsFor(entry.file),
  ]);
  const importedObservableFactories = sourceIndex.observableFactoriesFor(entry.file);
  return analyzeLegendPracticesFile({
    file: entry.analysisFile,
    reportFileName: entry.reportFileName,
    importedObservables,
    importedObservableFactories,
    includeFindings: isLegendPracticeEligible(
      entry.analysisFile,
      importedObservables,
      importedObservableFactories,
    ),
    installedLegendState: pass.context.installedLegendState,
    importedObservableKeys: sourceIndex.observableKeysFor(entry.file),
    childContracts,
    reactCompilerPackage: pass.compiledFiles.has(entry.file),
  });
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
      context: pass.context,
      file: entry.analysisFile,
      functionEntries: entry.functionEntries,
      stateFlow,
    }),
    target: { file: entry.reportFileName, kind: "file" },
  });
  for (const { node, target } of entry.functionEntries) {
    coverage.record({
      stages: analyzedFunctionCoverage({
        context: pass.context,
        file: entry.analysisFile,
        node,
        stateFlow,
        target,
      }),
      target,
    });
  }
}

function analysisReport(fileCount: number, pass: AnalysisPass): AnalysisReport {
  const { findings, practices } = pass.accumulator;
  const states = findings.filter((finding) => finding.hook === "useState").length;
  const effects = findings.filter((finding) => finding.hook === "useEffect").length;
  return {
    files: fileCount,
    findings,
    hooks: { effects, states, total: states + effects },
    practices,
    schemaVersion: 1,
  };
}

interface FunctionCoverageEntry {
  node: RuntimeFunctionLike;
  target: Extract<AnalysisCoverageTarget, { kind: "function" }>;
}

function functionCoverageEntries(
  file: AnalysisFile,
  reportFileName: string,
): FunctionCoverageEntry[] {
  const entries: FunctionCoverageEntry[] = [];
  const { sourceFile } = file;
  const visit = (node: ts.Node): void => {
    if (isRuntimeFunctionLike(node) && node.body) {
      entries.push({
        node,
        target: {
          end: node.end,
          file: reportFileName,
          kind: "function",
          name: runtimeFunctionName(node),
          start: node.getStart(sourceFile),
        },
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return entries;
}

function runtimeFunctionName(node: RuntimeFunctionLike): string | null {
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }
  if (node.name) {
    return node.name.getText(node.getSourceFile());
  }
  const { parent } = node;
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : null;
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

function portableDiagnosticMessage(message: string, root: string): string {
  return message.replaceAll(`${path.resolve(root)}${path.sep}`, "");
}

function outcome(
  status: AnalysisCoverageOutcome["status"],
  code: string,
  message: string,
): AnalysisCoverageOutcome {
  return { reason: { code, message }, status };
}

interface FileCoverageInputs {
  context: AnalysisContext;
  file: AnalysisFile;
  functionEntries: readonly FunctionCoverageEntry[];
  stateFlow: StateFlowIndex;
}

interface FunctionCoverageInputs {
  context: AnalysisContext;
  file: AnalysisFile;
  node: RuntimeFunctionLike;
  stateFlow: StateFlowIndex;
  target: Extract<AnalysisCoverageTarget, { kind: "function" }>;
}

function analyzedFileCoverage(inputs: FileCoverageInputs): AnalysisCoverageStages {
  const { context, file, functionEntries, stateFlow } = inputs;
  const recovered = file.parserDiagnostics.length > 0;
  return {
    detector: recovered
      ? outcome(
          "unknown",
          "detector-recovery-uncertain",
          "Detectors ran, but results in recovered source regions are not trusted as complete.",
        )
      : outcome(
          "analyzed",
          "detectors-complete",
          "All current source detectors ran on the cached AST.",
        ),
    lowering: boundedFlowCoverage(
      recovered ? "unknown" : aggregateStateFlowCoverage(functionEntries, stateFlow),
      "file",
    ),
    parser: recovered
      ? outcome("analyzed", "parser-recovered", "The parser recovered with reported diagnostics.")
      : outcome("analyzed", "parser-complete", "The source parsed without recovery diagnostics."),
    semantic: semanticCoverage(file, context),
  };
}

function analyzedFunctionCoverage(inputs: FunctionCoverageInputs): AnalysisCoverageStages {
  const { context, file, node, stateFlow, target } = inputs;
  const recovered = file.parserDiagnostics.some((diagnostic) =>
    diagnosticAffectsTarget(diagnostic, target),
  );
  const fileRecovered = file.parserDiagnostics.length > 0;
  return {
    detector: fileRecovered
      ? outcome(
          "unknown",
          "detector-recovery-uncertain",
          "Detectors ran, but file-wide facts from recovered source make function results uncertain.",
        )
      : outcome(
          "analyzed",
          "detectors-complete",
          "All current source detectors ran on this cached function AST.",
        ),
    lowering: boundedFlowCoverage(recovered ? "unknown" : stateFlow.coverageFor(node), "function"),
    parser: recovered
      ? outcome(
          "analyzed",
          "parser-recovered-in-function",
          "The parser recovered within this function range.",
        )
      : outcome(
          "analyzed",
          "parser-complete",
          "No parser recovery diagnostic overlaps this function.",
        ),
    semantic: semanticCoverage(file, context),
  };
}

function aggregateStateFlowCoverage(
  entries: readonly FunctionCoverageEntry[],
  stateFlow: StateFlowIndex,
): StateFlowCoverage {
  const outcomes = new Set(entries.map((entry) => stateFlow.coverageFor(entry.node)));
  if (outcomes.has("unknown")) {
    return "unknown";
  }
  return outcomes.has("complete") ? "complete" : "not-requested";
}

function boundedFlowCoverage(
  coverage: StateFlowCoverage,
  scope: "file" | "function",
): AnalysisCoverageOutcome {
  if (coverage === "complete") {
    return outcome(
      "analyzed",
      "bounded-flow-complete",
      `Every requested bounded state-flow proof in this ${scope} completed.`,
    );
  }
  if (coverage === "unknown") {
    return outcome(
      "unknown",
      "bounded-flow-uncertain",
      `At least one bounded state-flow proof in this ${scope} encountered unsupported or recovered control flow.`,
    );
  }
  return outcome(
    "skipped",
    "bounded-flow-not-requested",
    `No detector requested a bounded state-flow proof in this ${scope}.`,
  );
}

function diagnosticAffectsTarget(
  diagnostic: AnalysisDiagnostic,
  target: Extract<AnalysisCoverageTarget, { kind: "function" }>,
): boolean {
  if (diagnostic.start === null || diagnostic.length === null) {
    return true;
  }
  if (diagnostic.length === 0) {
    return diagnostic.start >= target.start && diagnostic.start <= target.end;
  }
  const end = diagnostic.start + diagnostic.length;
  return diagnostic.start < target.end && end > target.start;
}

function semanticCoverage(file: AnalysisFile, context: AnalysisContext): AnalysisCoverageOutcome {
  if (context.semanticContext?.getSourceFile(file)) {
    return outcome(
      "analyzed",
      "semantic-complete",
      "Semantic facts are available from the selected tsconfig shard.",
    );
  }
  if (context.semanticContext) {
    return outcome(
      "unknown",
      "semantic-file-not-owned",
      "The selected semantic shard does not own this file.",
    );
  }
  return context.semanticDiagnostics.length > 0
    ? outcome(
        "unknown",
        "semantic-unavailable",
        "The requested semantic context could not be created.",
      )
    : outcome("skipped", "semantic-not-requested", "Semantic project analysis was not requested.");
}

function unsupportedFileCoverage(): AnalysisCoverageStages {
  return {
    detector: outcome(
      "unsupported",
      "unsupported-extension",
      "This file extension is not supported.",
    ),
    lowering: outcome(
      "unsupported",
      "unsupported-extension",
      "This file extension is not supported.",
    ),
    parser: outcome(
      "unsupported",
      "unsupported-extension",
      "This file extension is not supported.",
    ),
    semantic: outcome(
      "unsupported",
      "unsupported-extension",
      "This file extension is not supported.",
    ),
  };
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const collected = await Promise.all(
    entries
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        if (entry.isSymbolicLink()) {
          return [];
        }
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          return IGNORED_DIRECTORIES.has(entry.name) ? [] : await collectSourceFiles(entryPath);
        }
        return entry.isFile() && isSupportedAnalysisFile(entry.name) ? [entryPath] : [];
      }),
  );
  return collected.flat();
}

function cached(cache: Map<string, boolean>, key: string, compute: () => boolean): boolean {
  const hit = cache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const value = compute();
  cache.set(key, value);
  return value;
}

type HookDeclarationRef = NonNullable<ReturnType<SourceIndex["hookDeclarationFor"]>>;

interface KeyedRowConsumerQuery {
  declaration: HookDeclarationRef;
  setterProperty: string;
  stateProperty: string;
}

class ChildContracts implements ChildContractResolver {
  private readonly arrayItemCallbackContracts = new Map<string, boolean>();
  private readonly callbackContracts = new Map<string, boolean>();
  private readonly componentCallbackContracts = new Map<string, boolean>();
  private readonly componentEffectCallbackContracts = new Map<string, boolean>();
  private readonly componentInvocationCallbackContracts = new Map<string, boolean>();
  private readonly componentSources = new Map<string, ChildComponentSource | null>();
  private readonly hookDeclarations = new Map<string, SourceHookDeclaration | null>();
  private readonly keyedCursorContracts = new Map<string, boolean>();
  private readonly context: AnalysisContext;
  private readonly importerFile: string;
  private readonly deferredRegistrations: ReturnType<
    SourceIndex["deferredCallbackRegistrationsFor"]
  >;

  private readonly hookResolver: SourceHookResolver = {
    resolveHook: (file, name) => this.resolveHookDeclaration(file, name),
  };

  private readonly callbackSources: CallbackContractSourceResolver = {
    contextReaderHooks: (file, contextName) =>
      this.context.sourceIndex.contextReaderHooksFor(file, contextName),
    deferredCallbackHooks: (file) => this.context.sourceIndex.deferredCallbackHooksFor(file),
    frameworkEventComponent: (file, name) =>
      this.context.sourceIndex.frameworkEventComponentFor(file, name),
    hookCallbackIsDeferred: (file, name, argumentIndex) =>
      this.hookDefersCallback(file, name, argumentIndex),
    resolveComponent: (file, name) => this.resolveComponentSource(file, name),
    resolveHook: (file, name) => this.hookComponentSource(file, name),
    sourceFile: (file) => this.context.project.getFile(file)?.sourceFile ?? null,
  };

  public constructor(context: AnalysisContext, importerFile: string) {
    this.context = context;
    this.importerFile = importerFile;
    this.deferredRegistrations = context.sourceIndex.deferredCallbackRegistrationsFor(importerFile);
  }

  public callbackPropertyIsDeferred(
    hookName: string,
    argumentIndex: number,
    property: string,
  ): boolean {
    return cached(this.callbackContracts, `${hookName}\0${argumentIndex}\0${property}`, () => {
      const source = this.resolveHookDeclaration(this.importerFile, hookName);
      return (
        source !== null &&
        sourceHookDefersCallback({ source, argumentIndex, property, resolver: this.hookResolver })
      );
    });
  }

  public callbackRegistrationIsDeferred(
    ownerBinding: string,
    method: string,
    argumentIndex: number,
  ): boolean {
    return this.deferredRegistrations.get(ownerBinding)?.get(method)?.has(argumentIndex) ?? false;
  }

  public componentArrayItemCallbackIsDeferred(
    componentName: string,
    propName: string,
    callbackProperty: string,
  ): boolean {
    return cached(
      this.arrayItemCallbackContracts,
      `${componentName}\0${propName}\0${callbackProperty}`,
      () => {
        const source = this.resolveComponentSource(this.importerFile, componentName);
        return (
          source !== null &&
          propDefersArrayItemCallback({
            source,
            propName,
            callbackProp: callbackProperty,
            resolver: this.callbackSources,
          })
        );
      },
    );
  }

  public componentCallbackPropIsDeferred(componentName: string, propName: string): boolean {
    return cached(this.componentCallbackContracts, `${componentName}\0${propName}\0`, () => {
      const source = this.resolveComponentSource(this.importerFile, componentName);
      return source !== null && propCallbackIsDeferred(source, propName, this.callbackSources);
    });
  }

  public componentCallbackPropIsDeferredAtInvocation(
    componentName: string,
    propName: string,
    invocation: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  ): boolean {
    return cached(
      this.componentInvocationCallbackContracts,
      `${componentName}\0${propName}\0${invocation.pos}`,
      () => {
        const source = this.resolveComponentSource(this.importerFile, componentName);
        return (
          source !== null &&
          propCallbackIsDeferred({ ...source, invocation }, propName, this.callbackSources)
        );
      },
    );
  }

  public componentCallbackPropRunsOnlyInReactEffect(
    componentName: string,
    propName: string,
  ): boolean {
    return cached(this.componentEffectCallbackContracts, `${componentName}\0${propName}`, () => {
      const source = this.resolveComponentSource(this.importerFile, componentName);
      return source !== null && propCallbackRunsOnlyInReactEffect(source, propName);
    });
  }

  public componentPropCallbackIsDeferred(
    componentName: string,
    propName: string,
    callbackProperty: string,
  ): boolean {
    return cached(
      this.componentCallbackContracts,
      `${componentName}\0${propName}\0${callbackProperty}`,
      () => {
        const source = this.resolveComponentSource(this.importerFile, componentName);
        return (
          source !== null &&
          propObjectCallbackIsDeferred({
            source,
            propName,
            callbackProperty,
            resolver: this.callbackSources,
          })
        );
      },
    );
  }

  public frameworkEventComponent(componentName: string): boolean {
    return this.context.sourceIndex.frameworkEventComponentFor(this.importerFile, componentName);
  }

  public hookStateHasKeyedRowConsumer(
    hookName: string,
    stateProperty: string,
    setterProperty: string,
  ): boolean {
    return cached(
      this.keyedCursorContracts,
      `${hookName}\0${stateProperty}\0${setterProperty}`,
      () => this.hasSingleKeyedRowConsumer(hookName, stateProperty, setterProperty),
    );
  }

  public pureProjectionBindings(): ReadonlySet<string> {
    return this.context.sourceIndex.pureProjectionsFor(this.importerFile);
  }

  public resolveComponent(name: string): ChildComponentSource | null {
    return this.resolveComponentSource(this.importerFile, name);
  }

  private hookDefersCallback(file: string, name: string, argumentIndex: number): boolean {
    const source = this.resolveHookDeclaration(file, name);
    return (
      source !== null &&
      sourceHookDefersCallback({
        source,
        argumentIndex,
        property: null,
        resolver: this.hookResolver,
      })
    );
  }

  private hookComponentSource(file: string, name: string): ChildComponentSource | null {
    const source = this.resolveHookDeclaration(file, name);
    if (!source?.owner.body) {
      return null;
    }
    return {
      ...source,
      body: source.owner.body,
      deferredCallbackHooks: this.context.sourceIndex.deferredCallbackHooksFor(source.file),
    };
  }

  private resolveHookDeclaration(file: string, name: string): SourceHookDeclaration | null {
    const key = `${file}\0${name}`;
    const hit = this.hookDeclarations.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const declaration = this.readHookDeclaration(file, name);
    this.hookDeclarations.set(key, declaration);
    return declaration;
  }

  private readHookDeclaration(file: string, name: string): SourceHookDeclaration | null {
    const resolved = this.context.sourceIndex.hookDeclarationFor(file, name);
    const analysisFile = resolved ? this.context.project.getFile(resolved.file) : null;
    if (!resolved || !analysisFile) {
      return null;
    }
    const owner = findHookDeclaration(analysisFile.sourceFile, resolved.localName);
    return owner ? { file: resolved.file, owner, sourceFile: analysisFile.sourceFile } : null;
  }

  private resolveComponentSource(file: string, name: string): ChildComponentSource | null {
    const key = `${file}\0${name}`;
    const hit = this.componentSources.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const source = this.readComponentSource(file, name);
    this.componentSources.set(key, source);
    return source;
  }

  private readComponentSource(file: string, name: string): ChildComponentSource | null {
    const resolved = this.context.sourceIndex.componentDeclarationFor(file, name);
    const analysisFile = resolved ? this.context.project.getFile(resolved.file) : null;
    if (!resolved || !analysisFile) {
      return null;
    }
    return findComponentDeclaration({
      deferredCallbackHooks: this.context.sourceIndex.deferredCallbackHooksFor(resolved.file),
      file: resolved.file,
      localName: resolved.localName,
      sourceFile: analysisFile.sourceFile,
    });
  }

  private hasSingleKeyedRowConsumer(
    hookName: string,
    stateProperty: string,
    setterProperty: string,
  ): boolean {
    const declaration = this.context.sourceIndex.hookDeclarationFor(this.importerFile, hookName);
    if (!declaration) {
      return false;
    }
    const query: KeyedRowConsumerQuery = { declaration, setterProperty, stateProperty };
    const results = this.context.project.files
      .filter((file) => !isNonProductionHarness(file.originalPath))
      .flatMap((file) => this.keyedCursorResults(file, query));
    return (
      !results.includes("unsafe") && results.filter((result) => result === "safe").length === 1
    );
  }

  private keyedCursorResults(
    file: AnalysisFile,
    query: KeyedRowConsumerQuery,
  ): ReturnType<typeof keyedCursorConsumerResult>[] {
    return importedHookBindings(file.sourceFile)
      .filter((binding) => this.bindingResolvesTo(file, binding, query.declaration))
      .map((binding) =>
        keyedCursorConsumerResult({
          sourceFile: file.sourceFile,
          hookBinding: binding,
          cursorProperty: query.stateProperty,
          setterProperty: query.setterProperty,
        }),
      );
  }

  private bindingResolvesTo(
    file: AnalysisFile,
    binding: string,
    declaration: HookDeclarationRef,
  ): boolean {
    const resolved = this.context.sourceIndex.hookDeclarationFor(file.identityPath, binding);
    return (
      resolved !== null &&
      pathIdentityKey(resolved.file) === pathIdentityKey(declaration.file) &&
      resolved.localName === declaration.localName
    );
  }
}

function createChildContractResolver(
  context: AnalysisContext,
  importerFile: string,
): ChildContractResolver {
  return new ChildContracts(context, importerFile);
}

function importedHookBindings(sourceFile: ts.SourceFile): readonly string[] {
  return sourceFile.statements.flatMap((statement) => statementHookBindings(statement));
}

function statementHookBindings(statement: ts.Statement): string[] {
  if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) {
    return [];
  }
  const clause = statement.importClause;
  const defaultBinding =
    clause?.name && HOOK_BINDING_PATTERN.test(clause.name.text) ? [clause.name.text] : [];
  return [...defaultBinding, ...namedHookBindings(clause?.namedBindings)];
}

function namedHookBindings(namedBindings: ts.NamedImportBindings | undefined): string[] {
  if (!namedBindings || !ts.isNamedImports(namedBindings)) {
    return [];
  }
  return namedBindings.elements
    .filter((element) => !element.isTypeOnly && HOOK_BINDING_PATTERN.test(element.name.text))
    .map((element) => element.name.text);
}

function findHookDeclaration(
  sourceFile: ts.SourceFile,
  localName: string,
): SourceHookDeclaration["owner"] | null {
  for (const statement of sourceFile.statements) {
    const owner = statementHookOwner(statement, localName);
    if (owner) {
      return owner;
    }
  }
  return null;
}

function statementHookOwner(
  statement: ts.Statement,
  localName: string,
): SourceHookDeclaration["owner"] | null {
  if (ts.isFunctionDeclaration(statement)) {
    return statement.name?.text === localName && statement.body ? statement : null;
  }
  if (!ts.isVariableStatement(statement)) {
    return null;
  }
  for (const declaration of statement.declarationList.declarations) {
    const owner = declarationHookOwner(declaration, localName);
    if (owner) {
      return owner;
    }
  }
  return null;
}

function declarationHookOwner(
  declaration: ts.VariableDeclaration,
  localName: string,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (
    !ts.isIdentifier(declaration.name) ||
    declaration.name.text !== localName ||
    !declaration.initializer
  ) {
    return null;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
    ? initializer
    : null;
}

function findComponentDeclaration(query: ComponentDeclarationQuery): ChildComponentSource | null {
  const reactWrappers = collectReactComponentWrappers(query.sourceFile);
  for (const statement of query.sourceFile.statements) {
    const source = statementComponentSource(statement, query, reactWrappers);
    if (source) {
      return source;
    }
  }
  return null;
}

function statementComponentSource(
  statement: ts.Statement,
  query: ComponentDeclarationQuery,
  reactWrappers: ReactComponentWrappers,
): ChildComponentSource | null {
  if (ts.isFunctionDeclaration(statement)) {
    return statement.name?.text === query.localName && statement.body
      ? {
          body: statement.body,
          deferredCallbackHooks: query.deferredCallbackHooks,
          file: query.file,
          owner: statement,
          reactWrapped: false,
        }
      : null;
  }
  if (!ts.isVariableStatement(statement)) {
    return null;
  }
  for (const declaration of statement.declarationList.declarations) {
    const source = declarationComponentSource(declaration, query, reactWrappers);
    if (source) {
      return source;
    }
  }
  return null;
}

function declarationComponentSource(
  declaration: ts.VariableDeclaration,
  query: ComponentDeclarationQuery,
  reactWrappers: ReactComponentWrappers,
): ChildComponentSource | null {
  if (
    !ts.isIdentifier(declaration.name) ||
    declaration.name.text !== query.localName ||
    !declaration.initializer
  ) {
    return null;
  }
  const unwrapped = unwrapTransparentExpression(declaration.initializer);
  const wrapped = wrapperRenderFunction(unwrapped, reactWrappers);
  const initializer = wrapped ?? unwrapped;
  if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) {
    return null;
  }
  return {
    body: initializer.body,
    deferredCallbackHooks: query.deferredCallbackHooks,
    file: query.file,
    owner: initializer,
    reactWrapped: wrapped !== null,
  };
}

function wrapperRenderFunction(
  initializer: ts.Expression,
  reactWrappers: ReactComponentWrappers,
): ts.Expression | null {
  if (
    !ts.isCallExpression(initializer) ||
    !isReactComponentWrapper(initializer.expression, reactWrappers) ||
    initializer.arguments.length === 0
  ) {
    return null;
  }
  const inner = unwrapTransparentExpression(initializer.arguments[0]!);
  return wrapperRenderFunction(inner, reactWrappers) ?? inner;
}
