import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import { unwrapTransparentExpression } from "./analysis-ast.js";
import { analyzeLegendPracticesFile } from "./analyze-legend-practices.js";
import { ReactCompilerResolver } from "./react-compiler-package.js";
import { analyzeSourceFile, findingHookImports } from "./analyze-source.js";
import { isNonProductionHarness, isRuntimeFunctionLike } from "./ast.js";
import type { RuntimeFunctionLike } from "./ast.js";
import {
  propCallbackIsDeferred,
  propCallbackRunsOnlyInReactEffect,
  propDefersArrayItemCallback,
  propObjectCallbackIsDeferred,
} from "./rules/child-contract.js";
import type {
  CallbackContractSourceResolver,
  ChildComponentSource,
  ChildContractResolver,
} from "./rules/child-contract.js";
import { sourceHookDefersCallback } from "./rules/source-callback-contract.js";
import type {
  SourceHookDeclaration,
  SourceHookResolver,
} from "./rules/source-callback-contract.js";
import { keyedCursorConsumerResult } from "./rules/hook-keyed-cursor-contract.js";
import { AnalysisCoverageLedger } from "./analysis-coverage.js";
import type {
  AnalysisCoverageOutcome,
  AnalysisCoverageReport,
  AnalysisCoverageStages,
  AnalysisCoverageTarget,
} from "./analysis-coverage.js";
import { AnalysisProject, isSupportedAnalysisFile } from "./analysis-project.js";
import type { AnalysisDiagnostic, AnalysisFile } from "./analysis-project.js";
import { createSemanticContext } from "./semantic-context.js";
import type { SemanticContext, SemanticContextDiagnostic } from "./semantic-context.js";
import { resolveInstalledLegendState } from "./legend-state-package.js";
import type { InstalledLegendState } from "./legend-state-package.js";
import { pathIdentityKey } from "./path-identity.js";
import {
  collectReactComponentWrappers,
  isReactComponentWrapper,
} from "./react-component-wrappers.js";
import type { ReactComponentWrappers } from "./react-component-wrappers.js";
import { buildSourceIndexFromFiles } from "./source-components.js";
import type { SourceIndex } from "./source-components.js";
import { StateFlowIndex } from "./state-flow.js";
import type { StateFlowCoverage } from "./state-flow.js";
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
const SOURCE_READ_BATCH_SIZE = 64;

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
  for (let start = 0; start < files.length; start += SOURCE_READ_BATCH_SIZE) {
    const batch = files.slice(start, start + SOURCE_READ_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((file) => readFile(file, "utf8")));
    for (let index = 0; index < batch.length; index += 1) {
      const result = results[index]!;
      if (result.status === "rejected") {
        throw result.reason;
      }
      sources.set(batch[index]!, result.value);
    }
  }
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

export async function analyzePath(
  targetPath: string,
  sharedContext?: AnalysisContext,
): Promise<AnalysisReport> {
  return analyzePathInternal(targetPath, sharedContext, false);
}

export async function analyzePathDetailed(
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
  const absoluteTarget = path.resolve(targetPath);
  const targetStats = await stat(absoluteTarget);
  const analysisRoot = targetStats.isDirectory() ? absoluteTarget : path.dirname(absoluteTarget);
  const files = targetStats.isDirectory()
    ? await collectSourceFiles(absoluteTarget)
    : [absoluteTarget];
  const context =
    sharedContext ??
    (targetStats.isDirectory()
      ? await createAnalysisContextFromFiles(analysisRoot, files, {})
      : await createAnalysisContext(analysisRoot));
  const findings: HookFinding[] = [];
  const practices: LegendPracticeFinding[] = [];
  const analysisFiles = files.map((file) => {
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
      functionEntries: includeDetails ? functionCoverageEntries(analysisFile, reportFileName) : [],
      reportFileName,
    };
  });
  const coverage = includeDetails
    ? new AnalysisCoverageLedger(
        analysisFiles.flatMap((entry) => [
          { file: entry.reportFileName, kind: "file" as const },
          ...entry.functionEntries.map((functionEntry) => functionEntry.target),
        ]),
      )
    : null;
  const diagnostics: AnalysisDiagnostic[] = [];
  const reactCompiler = new ReactCompilerResolver();
  for (const { analysisFile, file, functionEntries, reportFileName } of analysisFiles) {
    if (!analysisFile) {
      coverage?.record({
        stages: unsupportedFileCoverage(),
        target: { file: reportFileName, kind: "file" },
      });
      continue;
    }
    if (includeDetails) {
      diagnostics.push(
        ...analysisFile.parserDiagnostics.map((diagnostic) => ({
          ...diagnostic,
          file: reportFileName,
        })),
      );
    }
    const stateFlow = new StateFlowIndex();
    const hookImports = findingHookImports(analysisFile);
    const mayContainPractice = mayContainLegendPractice(analysisFile);
    const analyzeHooks = hookImports !== null || includeDetails;
    const analyzePractices = mayContainPractice || includeDetails;
    const childContracts =
      analyzeHooks || analyzePractices ? createChildContractResolver(context, file) : null;
    if (analyzeHooks) {
      findings.push(
        ...analyzeSourceFile(
          analysisFile,
          reportFileName,
          context.sourceIndex.componentsFor(file),
          stateFlow,
          childContracts,
          context.sourceIndex.legendValueBridgesFor(file),
          context.sourceIndex.deferredCallbackHooksFor(file),
          hookImports ?? undefined,
        ),
      );
    }
    if (analyzePractices) {
      const importedObservables = new Set([
        ...context.sourceIndex.observablesFor(file),
        ...context.sourceIndex.observablePathsFor(file),
      ]);
      const importedObservableFactories = context.sourceIndex.observableFactoriesFor(file);
      practices.push(
        ...analyzeLegendPracticesFile(
          analysisFile,
          reportFileName,
          importedObservables,
          importedObservableFactories,
          isLegendPracticeEligible(analysisFile, importedObservables, importedObservableFactories),
          context.installedLegendState,
          context.sourceIndex.observableKeysFor(file),
          childContracts,
          await reactCompiler.packageCompilesFile(file),
        ),
      );
    }
    if (coverage) {
      const stages = analyzedFileCoverage(analysisFile, context, functionEntries, stateFlow);
      coverage.record({
        stages,
        target: { file: reportFileName, kind: "file" },
      });
      for (const { node, target } of functionEntries) {
        coverage.record({
          stages: analyzedFunctionCoverage(analysisFile, context, target, node, stateFlow),
          target,
        });
      }
    }
  }

  const states = findings.filter((finding) => finding.hook === "useState").length;
  const effects = findings.filter((finding) => finding.hook === "useEffect").length;
  const report: AnalysisReport = {
    files: files.length,
    findings,
    hooks: { effects, states, total: states + effects },
    practices,
    schemaVersion: 1,
  };
  if (!coverage) {
    return report;
  }
  return {
    coverage: coverage.report(),
    diagnostics: {
      parser: diagnostics,
      semantic: displaySemanticDiagnostics(
        context.semanticDiagnostics,
        analysisFiles.flatMap((entry) => (entry.analysisFile ? [entry.analysisFile] : [])),
        analysisRoot,
      ),
    },
    report,
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
    /\.(?:get|set)\s*\(/.test(sourceText) ||
    /\b(?:useValue|useSelector|use\$)\s*\(/.test(sourceText)
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

function analyzedFileCoverage(
  file: AnalysisFile,
  context: AnalysisContext,
  functionEntries: readonly FunctionCoverageEntry[],
  stateFlow: StateFlowIndex,
): AnalysisCoverageStages {
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

function analyzedFunctionCoverage(
  file: AnalysisFile,
  context: AnalysisContext,
  target: Extract<AnalysisCoverageTarget, { kind: "function" }>,
  node: RuntimeFunctionLike,
  stateFlow: StateFlowIndex,
): AnalysisCoverageStages {
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

async function collectSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          await walk(entryPath);
        }
      } else if (entry.isFile() && isSupportedAnalysisFile(entry.name)) {
        files.push(entryPath);
      }
    }
  }
  await walk(root);
  return files;
}

function createChildContractResolver(
  context: AnalysisContext,
  importerFile: string,
): ChildContractResolver {
  const callbackContracts = new Map<string, boolean>();
  const arrayItemCallbackContracts = new Map<string, boolean>();
  const componentCallbackContracts = new Map<string, boolean>();
  const componentInvocationCallbackContracts = new Map<string, boolean>();
  const componentEffectCallbackContracts = new Map<string, boolean>();
  const componentSources = new Map<string, ChildComponentSource | null>();
  const keyedCursorContracts = new Map<string, boolean>();
  const hookSources = new Map<string, SourceHookDeclaration | null>();
  const hookResolver: SourceHookResolver = {
    resolveHook(file: string, name: string): SourceHookDeclaration | null {
      const key = `${file}\0${name}`;
      if (hookSources.has(key)) {
        return hookSources.get(key) ?? null;
      }
      const resolved = context.sourceIndex.hookDeclarationFor(file, name);
      if (!resolved) {
        hookSources.set(key, null);
        return null;
      }
      const analysisFile = context.project.getFile(resolved.file);
      if (!analysisFile) {
        hookSources.set(key, null);
        return null;
      }
      const owner = findHookDeclaration(analysisFile.sourceFile, resolved.localName),
        source = owner ? { file: resolved.file, owner, sourceFile: analysisFile.sourceFile } : null;
      hookSources.set(key, source);
      return source;
    },
  };
  const resolveComponent = (file: string, name: string): ChildComponentSource | null => {
    const key = `${file}\0${name}`;
    if (componentSources.has(key)) {
      return componentSources.get(key) ?? null;
    }
    const resolved = context.sourceIndex.componentDeclarationFor(file, name);
    if (!resolved) {
      componentSources.set(key, null);
      return null;
    }
    const analysisFile = context.project.getFile(resolved.file),
      source = analysisFile
        ? findComponentDeclaration(
            analysisFile.sourceFile,
            resolved.file,
            resolved.localName,
            context.sourceIndex.deferredCallbackHooksFor(resolved.file),
          )
        : null;
    componentSources.set(key, source);
    return source;
  };
  const callbackSourceResolver: CallbackContractSourceResolver = {
    contextReaderHooks(file, contextName) {
      return context.sourceIndex.contextReaderHooksFor(file, contextName);
    },
    deferredCallbackHooks(file) {
      return context.sourceIndex.deferredCallbackHooksFor(file);
    },
    frameworkEventComponent(file, name) {
      return context.sourceIndex.frameworkEventComponentFor(file, name);
    },
    hookCallbackIsDeferred(file, name, argumentIndex): boolean {
      const source = hookResolver.resolveHook(file, name);
      return source !== null && sourceHookDefersCallback(source, argumentIndex, null, hookResolver);
    },
    resolveComponent,
    resolveHook(file, name): ChildComponentSource | null {
      const source = hookResolver.resolveHook(file, name);
      if (!source?.owner.body) {
        return null;
      }
      return {
        ...source,
        body: source.owner.body,
        deferredCallbackHooks: context.sourceIndex.deferredCallbackHooksFor(source.file),
      };
    },
    sourceFile(file): ts.SourceFile | null {
      return context.project.getFile(file)?.sourceFile ?? null;
    },
  };
  const deferredRegistrations = context.sourceIndex.deferredCallbackRegistrationsFor(importerFile);
  return {
    callbackPropertyIsDeferred(hookName, argumentIndex, property): boolean {
      const key = `${hookName}\0${argumentIndex}\0${property}`;
      const cached = callbackContracts.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const source = hookResolver.resolveHook(importerFile, hookName);
      const deferred =
        source !== null && sourceHookDefersCallback(source, argumentIndex, property, hookResolver);
      callbackContracts.set(key, deferred);
      return deferred;
    },
    callbackRegistrationIsDeferred(ownerBinding, method, argumentIndex): boolean {
      return deferredRegistrations.get(ownerBinding)?.get(method)?.has(argumentIndex) ?? false;
    },
    componentArrayItemCallbackIsDeferred(componentName, propName, callbackProperty): boolean {
      const key = `${componentName}\0${propName}\0${callbackProperty}`;
      const cached = arrayItemCallbackContracts.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const source = resolveComponent(importerFile, componentName);
      const deferred =
        source !== null &&
        propDefersArrayItemCallback(source, propName, callbackProperty, callbackSourceResolver);
      arrayItemCallbackContracts.set(key, deferred);
      return deferred;
    },
    componentCallbackPropIsDeferred(componentName, propName): boolean {
      const key = `${componentName}\0${propName}\0`;
      const cached = componentCallbackContracts.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const source = resolveComponent(importerFile, componentName);
      const deferred =
        source !== null && propCallbackIsDeferred(source, propName, callbackSourceResolver);
      componentCallbackContracts.set(key, deferred);
      return deferred;
    },
    componentCallbackPropIsDeferredAtInvocation(componentName, propName, invocation): boolean {
      const key = `${componentName}\0${propName}\0${invocation.pos}`;
      const cached = componentInvocationCallbackContracts.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const source = resolveComponent(importerFile, componentName);
      const deferred =
        source !== null &&
        propCallbackIsDeferred({ ...source, invocation }, propName, callbackSourceResolver);
      componentInvocationCallbackContracts.set(key, deferred);
      return deferred;
    },
    componentCallbackPropRunsOnlyInReactEffect(componentName, propName): boolean {
      const key = `${componentName}\0${propName}`;
      const cached = componentEffectCallbackContracts.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const source = resolveComponent(importerFile, componentName);
      const effectOnly = source !== null && propCallbackRunsOnlyInReactEffect(source, propName);
      componentEffectCallbackContracts.set(key, effectOnly);
      return effectOnly;
    },
    componentPropCallbackIsDeferred(componentName, propName, callbackProperty): boolean {
      const key = `${componentName}\0${propName}\0${callbackProperty}`;
      const cached = componentCallbackContracts.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const source = resolveComponent(importerFile, componentName);
      const deferred =
        source !== null &&
        propObjectCallbackIsDeferred(source, propName, callbackProperty, callbackSourceResolver);
      componentCallbackContracts.set(key, deferred);
      return deferred;
    },
    frameworkEventComponent(componentName): boolean {
      return context.sourceIndex.frameworkEventComponentFor(importerFile, componentName);
    },
    hookStateHasKeyedRowConsumer(hookName, stateProperty, setterProperty): boolean {
      const key = `${hookName}\0${stateProperty}\0${setterProperty}`;
      const cached = keyedCursorContracts.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const declaration = context.sourceIndex.hookDeclarationFor(importerFile, hookName);
      if (!declaration) {
        keyedCursorContracts.set(key, false);
        return false;
      }
      let safeConsumers = 0;
      let unsafe = false;
      for (const file of context.project.files) {
        if (isNonProductionHarness(file.originalPath)) {
          continue;
        }
        for (const binding of importedHookBindings(file.sourceFile)) {
          const resolved = context.sourceIndex.hookDeclarationFor(file.identityPath, binding);
          if (
            !resolved ||
            pathIdentityKey(resolved.file) !== pathIdentityKey(declaration.file) ||
            resolved.localName !== declaration.localName
          ) {
            continue;
          }
          const result = keyedCursorConsumerResult(
            file.sourceFile,
            binding,
            stateProperty,
            setterProperty,
          );
          if (result === "safe") {
            safeConsumers += 1;
          }
          if (result === "unsafe") {
            unsafe = true;
          }
        }
      }
      const safe = !unsafe && safeConsumers === 1;
      keyedCursorContracts.set(key, safe);
      return safe;
    },
    pureProjectionBindings(): ReadonlySet<string> {
      return context.sourceIndex.pureProjectionsFor(importerFile);
    },
    resolveComponent(name: string): ChildComponentSource | null {
      return resolveComponent(importerFile, name);
    },
  };
}

function importedHookBindings(sourceFile: ts.SourceFile): readonly string[] {
  const bindings: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) {
      continue;
    }
    const clause = statement.importClause;
    if (clause?.name && /^use[A-Z0-9]/.test(clause.name.text)) {
      bindings.push(clause.name.text);
    }
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
      continue;
    }
    for (const element of clause.namedBindings.elements) {
      if (!element.isTypeOnly && /^use[A-Z0-9]/.test(element.name.text)) {
        bindings.push(element.name.text);
      }
    }
  }
  return bindings;
}

function findHookDeclaration(
  sourceFile: ts.SourceFile,
  localName: string,
): SourceHookDeclaration["owner"] | null {
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === localName &&
      statement.body
    ) {
      return statement;
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== localName ||
        !declaration.initializer
      ) {
        continue;
      }
      const initializer = unwrapTransparentExpression(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        return initializer;
      }
    }
  }
  return null;
}

function findComponentDeclaration(
  sourceFile: ts.SourceFile,
  file: string,
  localName: string,
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>,
): ChildComponentSource | null {
  const reactWrappers = collectReactComponentWrappers(sourceFile);
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === localName &&
      statement.body
    ) {
      return {
        body: statement.body,
        deferredCallbackHooks,
        file,
        owner: statement,
        reactWrapped: false,
      };
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== localName) {
        continue;
      }
      if (!declaration.initializer) {
        continue;
      }
      let initializer = unwrapTransparentExpression(declaration.initializer);
      const wrapped = wrapperRenderFunction(initializer, reactWrappers);
      if (wrapped) {
        initializer = wrapped;
      }
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        return {
          body: initializer.body,
          deferredCallbackHooks,
          file,
          owner: initializer,
          reactWrapped: wrapped !== null,
        };
      }
    }
  }
  return null;
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
