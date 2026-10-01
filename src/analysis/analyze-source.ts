import { DEFAULT_MATERIALITY, EMPTY_BINDINGS } from "./constants.js";
import type { EffectCandidate, StateCandidate, StateUsage } from "./model.js";
import type { ParsedSourceAnalysisOptions, SourceAnalysis } from "./proofs/contracts.js";
import {
  SOURCE_FILE_OPTIONS,
  isNonProductionHarness,
  scriptKindForFile,
  visit,
} from "../core/ast.js";
import { collectHookImports, isReactHookCall } from "../core/imports.js";
import { collectLocalComponents, collectPureProjectionImports } from "./owner-scan.js";
import {
  collectModuleScopeBindings,
  collectObservableSubscriptionCounts,
  collectReactiveMutationBindings,
  collectStableUseObservableBindings,
  collectUseValueBindings,
} from "./owner-bindings.js";
import { effectCandidate, stateCandidate } from "./candidates.js";
import type { AnalysisFile } from "../project/analysis-project.js";
import type { ChildContractResolver } from "../rules/child-contract/model.js";
import type { ConfirmationSet } from "./assumptions/confirmations.js";
import type { HookFinding } from "../core/types.js";
import type { HookImports } from "../core/imports.js";
import type { MaterialityPolicy } from "./constants.js";
import type { ReactCommitContext } from "../rules/react-commit-sensitivity/react-commit-sensitivity.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import { StateFlowIndex } from "../project/state-flow/state-flow.js";
import type { StateUsageScope } from "./state-usage.js";
import { buildFindings } from "./findings.js";
import { collectClusterProofs } from "./proofs/cluster-proofs.js";
import { collectCommandProofs } from "./proofs/command-proofs.js";
import { collectEffectProofs } from "./proofs/effect-proofs.js";
import { collectLeafConsumerProofs } from "./proofs/leaf-consumer-proofs.js";
import { collectOwnerEventCallbacks } from "./proofs/event-callbacks.js";
import { collectOwnershipProofs } from "./proofs/ownership-proofs.js";
import { collectReactCommitContext } from "../rules/react-commit-sensitivity/react-commit-sensitivity.js";
import { collectStateUsage } from "./state-usage.js";
import { persistenceSinkEffects } from "../rules/effects/browser-storage-persistence.js";
import { subscriptionHookCallee } from "../core/use-value-import.js";
import ts from "typescript";

export function analyzeSource(
  sourceText: string,
  fileName: string,
  sourceComponents: ReadonlySet<string> = new Set(),
): HookFinding[] {
  return analyzeSourceWith(sourceText, fileName, { sourceComponents });
}

export interface SourceTextAnalysisOptions {
  readonly confirmations?: ConfirmationSet | null;
  readonly materiality?: MaterialityPolicy;
  readonly sourceComponents?: ReadonlySet<string>;
}

export function analyzeSourceWith(
  sourceText: string,
  fileName: string,
  {
    confirmations = null,
    materiality = DEFAULT_MATERIALITY,
    sourceComponents = new Set(),
  }: SourceTextAnalysisOptions,
): HookFinding[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    SOURCE_FILE_OPTIONS,
    true,
    scriptKindForFile(fileName),
  );
  return analyzeParsedSource(sourceFile, fileName, {
    childContracts: null,
    confirmations,
    deferredCallbackHooks: new Map(),
    legendValueBridges: new Map(),
    materiality,
    sourceComponents,
    stateFlow: new StateFlowIndex(),
  });
}

export interface SourceAnalysisRequest {
  readonly analysisRoot?: string | null;
  readonly childContracts?: ChildContractResolver | null;
  readonly confirmations?: ConfirmationSet | null;
  readonly deferredCallbackHooks?: ReadonlyMap<string, ReadonlySet<number>>;
  readonly file: AnalysisFile;
  readonly hookImports?: HookImports | null;
  readonly legendValueBridges?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly materiality?: MaterialityPolicy;
  readonly reportFileName: string;
  readonly sourceComponents?: ReadonlySet<string>;
  readonly stateFlow?: StateFlowIndex;
}

export function analyzeSourceFile({
  analysisRoot = null,
  childContracts = null,
  confirmations = null,
  deferredCallbackHooks = new Map(),
  file,
  hookImports,
  legendValueBridges = new Map(),
  materiality = DEFAULT_MATERIALITY,
  reportFileName,
  sourceComponents = new Set(),
  stateFlow = new StateFlowIndex(),
}: SourceAnalysisRequest): HookFinding[] {
  return analyzeParsedSource(file.sourceFile, reportFileName, {
    analysisRoot,
    childContracts,
    confirmations,
    deferredCallbackHooks,
    imports: hookImports ?? collectHookImports(file.sourceFile),
    legendValueBridges,
    materiality,
    sourceComponents,
    stateFlow,
  });
}

export function findingHookImports(file: AnalysisFile): HookImports | null {
  const imports = collectHookImports(file.sourceFile);
  return canCallFindingHook(imports) && containsFindingHookCall(file.sourceFile, imports)
    ? imports
    : null;
}

/** A finding hook call names a `useState`, `useEffect`, or `useLayoutEffect` import, or a member of a React namespace. */
function canCallFindingHook(imports: HookImports): boolean {
  return (
    imports.useState.size > 0 ||
    imports.useEffect.size > 0 ||
    imports.useLayoutEffect.size > 0 ||
    imports.reactNamespaces.size > 0
  );
}

function containsFindingHookCall(node: ts.Node, imports: HookImports): boolean {
  if (
    ts.isCallExpression(node) &&
    (isReactHookCall(node, "useState", imports) ||
      isReactHookCall(node, "useEffect", imports) ||
      isReactHookCall(node, "useLayoutEffect", imports))
  ) {
    return true;
  }
  return (
    node.forEachChild((child) => containsFindingHookCall(child, imports) || undefined) === true
  );
}

function sourceAnalysisBase(
  sourceFile: ts.SourceFile,
  fileName: string,
  options: ParsedSourceAnalysisOptions,
): SourceAnalysis {
  const {
    analysisRoot = null,
    childContracts,
    confirmations = null,
    deferredCallbackHooks,
    imports = collectHookImports(sourceFile),
    legendValueBridges,
    materiality = DEFAULT_MATERIALITY,
    sourceComponents,
    stateFlow,
  } = options;
  const { effects, localComponents, reactCommit, states, unmatchedStateCalls, usageByState } =
    hookInventory(sourceFile, imports);
  return {
    ...ownerBindingIndexes(sourceFile, imports),
    ...commitScopedIndexes(reactCommit, effects),
    analysisRoot,
    childContracts,
    confirmations,
    deferredCallbackHooks,
    effects,
    fileName,
    imports,
    knownComponents: new Set([...localComponents, ...sourceComponents]),
    legendValueBridges,
    localComponents,
    materiality,
    nonProductionHarness: isNonProductionHarness(fileName),
    pureProjectionImports: new Set([
      ...collectPureProjectionImports(sourceFile),
      ...(childContracts?.pureProjectionBindings() ?? EMPTY_BINDINGS),
    ]),
    reactCommit,
    sourceComponents,
    sourceFile,
    stateFlow,
    states,
    subscriptionHook: subscriptionHookCallee(sourceFile),
    unmatchedStateCalls,
    usageByState,
  };
}

interface HookInventory {
  readonly effects: readonly EffectCandidate[];
  readonly localComponents: ReadonlySet<string>;
  readonly reactCommit: ReactCommitContext;
  readonly states: readonly StateCandidate[];
  readonly unmatchedStateCalls: readonly ts.CallExpression[];
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

/** Every hook call in the file with its usage, the raw material every proof reads. */
function hookInventory(sourceFile: ts.SourceFile, imports: HookImports): HookInventory {
  const reactCommit = collectReactCommitContext(sourceFile, imports);
  const effects = reactCommit.effectCalls.map((call) => effectCandidate(call, imports));
  const { states, unmatchedStateCalls } = collectStateCandidates(sourceFile, imports);
  const usageScope: StateUsageScope = {
    effectNodes: reactCommit.lifecycleRegions,
    imports,
    persistenceSinks: persistenceSinkEffects(effects),
  };
  return {
    effects,
    localComponents: collectLocalComponents(sourceFile, imports),
    reactCommit,
    states,
    unmatchedStateCalls,
    usageByState: new Map(states.map((state) => [state, collectStateUsage(state, usageScope)])),
  };
}

interface CommitScopedIndexes {
  readonly commitSensitiveOwners: ReadonlySet<RuntimeFunctionLike>;
  readonly directEffectCallbacks: ReadonlySet<RuntimeFunctionLike>;
  readonly directEffectCalls: ReadonlySet<ts.CallExpression>;
  readonly lifecycleRegions: ReadonlySet<ts.Node>;
}

function commitScopedIndexes(
  reactCommit: ReactCommitContext,
  effects: readonly EffectCandidate[],
): CommitScopedIndexes {
  return {
    commitSensitiveOwners: reactCommit.sensitiveOwners,
    directEffectCallbacks: new Set<RuntimeFunctionLike>(
      effects.flatMap((effect) => (effect.callback ? [effect.callback] : [])),
    ),
    directEffectCalls: new Set(reactCommit.effectCalls),
    lifecycleRegions: reactCommit.lifecycleRegions,
  };
}

interface StateCandidateScan {
  readonly states: readonly StateCandidate[];
  readonly unmatchedStateCalls: readonly ts.CallExpression[];
}

function collectStateCandidates(
  sourceFile: ts.SourceFile,
  imports: HookImports,
): StateCandidateScan {
  const states: StateCandidate[] = [];
  const unmatchedStateCalls: ts.CallExpression[] = [];
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !isReactHookCall(node, "useState", imports)) {
      return;
    }
    const state = stateCandidate(node);
    if (state) {
      states.push(state);
    } else {
      unmatchedStateCalls.push(node);
    }
  });
  return { states, unmatchedStateCalls };
}

interface OwnerBindingIndexes {
  readonly moduleScopeBindings: ReadonlySet<string>;
  readonly observableSubscriptionsByOwner: ReadonlyMap<RuntimeFunctionLike, number>;
  readonly reactiveMutationsByOwner: ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>>;
  readonly useObservableBindingsByOwner: ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>>;
  readonly useValueBindingsByOwner: ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>>;
}

function ownerBindingIndexes(sourceFile: ts.SourceFile, imports: HookImports): OwnerBindingIndexes {
  return {
    moduleScopeBindings: collectModuleScopeBindings(sourceFile),
    observableSubscriptionsByOwner: collectObservableSubscriptionCounts(sourceFile, imports),
    reactiveMutationsByOwner: collectReactiveMutationBindings(sourceFile),
    useObservableBindingsByOwner: collectStableUseObservableBindings(sourceFile, imports),
    useValueBindingsByOwner: collectUseValueBindings(sourceFile, imports),
  };
}

function findingsForPolicy(
  sourceFile: ts.SourceFile,
  fileName: string,
  options: ParsedSourceAnalysisOptions,
): HookFinding[] {
  const analysis = sourceAnalysisBase(sourceFile, fileName, options);
  const callbacks = collectOwnerEventCallbacks(analysis);
  const commands = collectCommandProofs(analysis);
  const ownership = collectOwnershipProofs(analysis, callbacks, commands);
  const proofs = { ...commands, ...ownership };
  const leaves = collectLeafConsumerProofs(analysis, callbacks, proofs);
  const clusters = collectClusterProofs(analysis, proofs);
  const effectProofs = collectEffectProofs(analysis, ownership);
  return buildFindings({
    analysis,
    callbacks,
    clusters,
    commands,
    effectProofs,
    leaves,
    ownership,
  });
}

/** Compare final outcomes so consumer thresholds and alternative proofs are accounted for. */
function analyzeParsedSource(
  sourceFile: ts.SourceFile,
  fileName: string,
  options: ParsedSourceAnalysisOptions,
): HookFinding[] {
  const findings = findingsForPolicy(sourceFile, fileName, options);
  if (options.materiality?.tier !== "compact") {
    return findings;
  }
  const broad = findingsForPolicy(sourceFile, fileName, {
    ...options,
    materiality: DEFAULT_MATERIALITY,
    stateFlow: new StateFlowIndex(),
  });
  return findings.map((finding, index) => {
    const baseline = broad[index];
    return finding.disposition !== "keep" &&
      (finding.action !== baseline?.action ||
        finding.assumption?.ifConfirmed !== baseline?.assumption?.ifConfirmed)
      ? { ...finding, materiality: "compact" }
      : finding;
  });
}
