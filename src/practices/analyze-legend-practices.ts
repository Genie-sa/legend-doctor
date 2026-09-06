import { exactObjectLiteralKeys, unwrapTransparentExpression } from "../core/analysis-ast.js";
import { isNonProductionHarness, visit } from "../core/ast.js";
import type { AnalysisFile } from "../project/analysis-project.js";
import type { ChildContractResolver } from "../rules/child-contract/model.js";
import type { FileCapabilities } from "../project/capabilities.js";
import type { HookImports } from "../core/imports.js";
import type { InstalledLegendState } from "../project/legend-state-package.js";
import type { LegendPracticeFinding } from "../core/types.js";
import type { LegendPracticesRequest } from "./model.js";
import { NO_CAPABILITIES } from "../project/capabilities.js";
import { collectHookImports } from "../core/imports.js";
import { enabledPracticeRules } from "./practice-rules.js";
import { isObservableFactoryCall } from "./observable-paths.js";
import { observableInitialValue } from "../core/observable-initial-value.js";
import { resolveObservableBindings } from "./observable-bindings.js";
import ts from "typescript";

export interface LegendPracticesSourceRequest {
  readonly fileName: string;
  readonly importedObservableArrayPaths?: ReadonlySet<string>;
  readonly importedObservableFactories?: ReadonlySet<string>;
  readonly importedObservableKeys?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly importedObservables?: ReadonlySet<string>;
  readonly installedLegendState?: InstalledLegendState | null;
  readonly sourceText: string;
}

export function analyzeLegendPractices({
  fileName,
  importedObservableArrayPaths = new Set(),
  importedObservableFactories = new Set(),
  importedObservableKeys = new Map(),
  importedObservables = new Set(),
  installedLegendState = null,
  sourceText,
}: LegendPracticesSourceRequest): LegendPracticeFinding[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") || fileName.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return analyzeParsedLegendPractices({
    capabilities: { ...NO_CAPABILITIES, legendState: installedLegendState },
    childContracts: null,
    fileName,
    importedObservableArrayPaths,
    importedObservableFactories,
    importedObservableKeys,
    importedObservables,
    sourceFile,
  });
}

export interface LegendPracticesFileRequest {
  readonly capabilities?: FileCapabilities;
  readonly childContracts?: ChildContractResolver | null;
  readonly file: AnalysisFile;
  readonly importedObservableArrayPaths?: ReadonlySet<string>;
  readonly importedObservableFactories?: ReadonlySet<string>;
  readonly importedObservableKeys?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly importedObservables?: ReadonlySet<string>;
  readonly includeFindings?: boolean;
  readonly reportFileName: string;
}

export function analyzeLegendPracticesFile({
  capabilities = NO_CAPABILITIES,
  childContracts = null,
  file,
  importedObservableArrayPaths = new Set(),
  importedObservableFactories = new Set(),
  importedObservableKeys = new Map(),
  importedObservables = new Set(),
  includeFindings = true,
  reportFileName,
}: LegendPracticesFileRequest): LegendPracticeFinding[] {
  const findings = analyzeParsedLegendPractices({
    capabilities,
    childContracts,
    fileName: reportFileName,
    importedObservableArrayPaths,
    importedObservableFactories,
    importedObservableKeys,
    importedObservables,
    sourceFile: file.sourceFile,
  });
  return includeFindings ? findings : [];
}

function analyzeParsedLegendPractices(request: LegendPracticesRequest): LegendPracticeFinding[] {
  const { fileName, sourceFile } = request;
  if (isNonProductionHarness(fileName)) {
    return [];
  }
  const imports = collectHookImports(sourceFile);
  const observableBindings = resolveObservableBindings(request, imports);
  const rules = enabledPracticeRules(request.capabilities).filter(
    (rule) => !rule.needsObservableBindings || observableBindings.size > 0,
  );
  const observableKeys = rules.some((rule) => rule.id === "observable-reads")
    ? collectObservableKeys(request, imports, observableBindings)
    : new Map<string, ReadonlySet<string>>();
  return rules
    .flatMap((rule) => rule.run({ imports, observableBindings, observableKeys, request }))
    .toSorted(compareFindingLocation);
}

function compareFindingLocation(left: LegendPracticeFinding, right: LegendPracticeFinding): number {
  return left.location.line - right.location.line || left.location.column - right.location.column;
}

function collectObservableKeys(
  request: LegendPracticesRequest,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const keys = new Map(request.importedObservableKeys);
  visit(request.sourceFile, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.initializer ||
      !observableBindings.has(node.name.text)
    ) {
      return;
    }
    const initializer = unwrapTransparentExpression(node.initializer);
    if (
      !ts.isCallExpression(initializer) ||
      !isObservableFactoryCall(initializer, imports, request.importedObservableFactories)
    ) {
      return;
    }
    const initial = observableInitialValue(initializer, imports);
    const objectKeys = initial ? exactObjectLiteralKeys(initial) : null;
    if (objectKeys) {
      keys.set(node.name.text, objectKeys);
    }
  });
  return keys;
}
