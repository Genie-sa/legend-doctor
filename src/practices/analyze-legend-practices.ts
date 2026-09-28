import {
  NO_OBSERVABLE_FIELD_FACTS,
  observableWriteGroups,
} from "../rules/observable-reads/field-writes.js";
import {
  dataFieldKeys,
  exactObjectLiteralKeys,
  unwrapTransparentExpression,
} from "../core/analysis-ast.js";
import { isNonProductionHarness, visit } from "../core/ast.js";
import type { AnalysisFile } from "../project/analysis-project.js";
import type { ChildContractResolver } from "../rules/child-contract/model.js";
import type { FileCapabilities } from "../project/capabilities.js";
import type { HookImports } from "../core/imports.js";
import type { InstalledLegendState } from "../project/legend-state-package.js";
import type { LegendPracticeFinding } from "../core/types.js";
import type { LegendPracticesRequest } from "./model.js";
import { NO_CAPABILITIES } from "../project/capabilities.js";
import type { ObservableContextReader } from "../project/source-components/observable-contexts.js";
import type { ObservableFieldFacts } from "../rules/observable-reads/field-writes.js";
import type { ObservableInPlaceWrites } from "../project/source-components/observable-in-place-writes.js";
import type { SubscriptionInventory } from "../core/subscriptions.js";
import { collectHookImports } from "../core/imports.js";
import { enabledPracticeRules } from "./practice-rules.js";
import { hasSoleSourceBinding } from "../rules/observable-reads/independent-subscription-bindings.js";
import { isObservableFactoryCall } from "./observable-paths.js";
import { localObservableContextReaders } from "../project/source-components/observable-contexts.js";
import { localObservableInPlaceWrites } from "../project/source-components/observable-in-place-writes.js";
import { moduleRecord } from "../project/source-components/module-record.js";
import { observableInitialValue } from "../core/observable-initial-value.js";
import { resolveObservableBindings } from "./observable-bindings.js";
import ts from "typescript";
import { withSoleBindingFacts } from "./sole-binding-facts.js";

export interface LegendPracticesSourceRequest {
  readonly fileName: string;
  readonly importedObservableArrayPaths?: ReadonlySet<string>;
  readonly importedObservableFactories?: ReadonlySet<string>;
  readonly importedObservableKeys?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly importedObservables?: ReadonlySet<string>;
  readonly installedLegendState?: InstalledLegendState | null;
  readonly sourceText: string;
}

const provesNoContextRead = (): boolean => false;

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
    observableContextReaders: localObservableContextReaders(moduleRecord(sourceFile)),
    observableInPlaceWrites: localObservableInPlaceWrites(sourceFile),
    sourceFile,
    stableContextRead: provesNoContextRead,
  });
}

export interface LegendPracticesFileRequest {
  readonly subscriptionInventory?: SubscriptionInventory[] | undefined;
  readonly importedObservablePrimitivePaths?: ReadonlySet<string>;
  readonly importedObservablePlainSeedPaths?: ReadonlySet<string>;
  readonly plainConstants?: ReadonlySet<string>;
  readonly capabilities?: FileCapabilities;
  readonly childContracts?: ChildContractResolver | null;
  readonly file: AnalysisFile;
  readonly importedObservableArrayPaths?: ReadonlySet<string>;
  readonly importedObservableDataKeys?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly importedObservableDeclarations?: ReadonlyMap<string, ts.VariableDeclaration>;
  readonly importedObservableFactories?: ReadonlySet<string>;
  readonly importedObservableKeys?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly importedObservables?: ReadonlySet<string>;
  readonly includeFindings?: boolean;
  readonly observableContextReaders?: ReadonlyMap<string, ObservableContextReader>;
  readonly observableInPlaceWrites?: ObservableInPlaceWrites;
  readonly reportFileName: string;
  readonly stableContextRead?: (localName: string) => boolean;
}

export function analyzeLegendPracticesFile({
  subscriptionInventory,
  importedObservablePrimitivePaths = new Set(),
  importedObservablePlainSeedPaths = new Set(),
  plainConstants,
  capabilities = NO_CAPABILITIES,
  childContracts = null,
  file,
  importedObservableArrayPaths = new Set(),
  importedObservableDataKeys = new Map(),
  importedObservableDeclarations = new Map(),
  importedObservableFactories = new Set(),
  importedObservableKeys = new Map(),
  importedObservables = new Set(),
  includeFindings = true,
  observableContextReaders = localObservableContextReaders(moduleRecord(file.sourceFile)),
  observableInPlaceWrites = new Map(),
  reportFileName,
  stableContextRead = provesNoContextRead,
}: LegendPracticesFileRequest): LegendPracticeFinding[] {
  const findings = analyzeParsedLegendPractices({
    subscriptionInventory,
    importedObservablePrimitivePaths,
    importedObservablePlainSeedPaths,
    plainConstants,
    capabilities,
    childContracts,
    fileName: reportFileName,
    importedObservableArrayPaths,
    importedObservableDataKeys,
    importedObservableDeclarations,
    importedObservableFactories,
    importedObservableKeys,
    importedObservables,
    observableContextReaders,
    observableInPlaceWrites,
    sourceFile: file.sourceFile,
    stableContextRead,
  });
  return includeFindings ? findings : [];
}

function analyzeParsedLegendPractices(
  parsedRequest: LegendPracticesRequest,
): LegendPracticeFinding[] {
  const request = withSoleBindingFacts(parsedRequest);
  const { fileName, sourceFile } = request;
  if (isNonProductionHarness(fileName)) {
    return [];
  }
  const imports = collectHookImports(sourceFile);
  const observableBindings = resolveObservableBindings(request, imports);
  const rules = enabledPracticeRules(request.capabilities).filter(
    (rule) => !rule.needsObservableBindings || observableBindings.size > 0,
  );
  const observableFields = rules.some((rule) => rule.id === "observable-reads")
    ? collectObservableFieldFacts(request, imports, observableBindings)
    : NO_OBSERVABLE_FIELD_FACTS;
  return rules
    .flatMap((rule) => rule.run({ imports, observableBindings, observableFields, request }))
    .toSorted(compareFindingLocation);
}

function compareFindingLocation(left: LegendPracticeFinding, right: LegendPracticeFinding): number {
  return left.location.line - right.location.line || left.location.column - right.location.column;
}

function collectObservableFieldFacts(
  request: LegendPracticesRequest,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
): ObservableFieldFacts {
  const keys = new Map(request.importedObservableKeys);
  const dataKeys = new Map(request.importedObservableDataKeys);
  visit(request.sourceFile, (node) => {
    const local = ts.isVariableDeclaration(node)
      ? localObservableInitialValue(node, { imports, observableBindings, request })
      : null;
    const localKeys = local ? exactObjectLiteralKeys(local.initial) : null;
    const localDataKeys = local ? dataFieldKeys(local.initial) : null;
    if (local && localKeys && localDataKeys) {
      keys.set(local.name, localKeys);
      dataKeys.set(local.name, localDataKeys);
    }
  });
  return { dataKeys, keys, writes: observableWriteGroups(request.observableInPlaceWrites) };
}

interface LocalObservableScope {
  readonly imports: HookImports;
  readonly observableBindings: ReadonlySet<string>;
  readonly request: LegendPracticesRequest;
}

function localObservableInitialValue(
  node: ts.VariableDeclaration,
  { imports, observableBindings, request }: LocalObservableScope,
): { readonly initial: ts.Expression; readonly name: string } | null {
  if (
    !ts.isIdentifier(node.name) ||
    !node.initializer ||
    !observableBindings.has(node.name.text) ||
    !hasSoleSourceBinding(request.sourceFile, node.name.text)
  ) {
    return null;
  }
  const initializer = unwrapTransparentExpression(node.initializer);
  const initial =
    ts.isCallExpression(initializer) &&
    isObservableFactoryCall(initializer, imports, request.importedObservableFactories)
      ? observableInitialValue(initializer, imports)
      : null;
  return initial ? { initial, name: node.name.text } : null;
}
