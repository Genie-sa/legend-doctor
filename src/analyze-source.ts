import type { EffectAction, HookFinding, StateAction } from "./types.js";
import type { EffectDraftAnalysis, EffectDraftProofs } from "./rules/effect-drafts.js";
import type { LazyCallbackLeaf, LazyCallbackLeafProofs } from "./rules/lazy-callback-leaf.js";
import {
  analyzeKeyedSelections,
  isSelectionStateName,
  isSetOrMapState,
} from "./rules/keyed-selection.js";
import {
  bindingDeclarationCount,
  collectBindingNames,
  containsCallExpression,
  isControlledInteractionProp,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isEvaluationInert,
  isInsideJsxAttribute,
  isNonValueIdentifier,
  isPureExpression,
  isValueTransitionProp,
  unwrapTransparentExpression,
} from "./analysis-ast.js";
import {
  boundedRenderProjectionReferences,
  callbackIsEventRooted,
  expressionDependsOnBinding,
  hasDirectPrimitiveInitializer,
  hasIndependentRenderCutWitness,
  hasOnlyEventCommandReads,
  hasRepeatedJsxRenderWorkOutside,
  hasUnstableSubtreeLifetime,
  isDirectPrimitiveExpression,
  isHookDependencyReference,
  isInsideJsxEventCallback,
  isJsxEventHandlerReference,
  isJsxNode,
  isSafeJsxProjectionReference,
  isSynchronousRenderCallback,
  isUniquelySelectedRepeatedProjection,
  isUnshadowedMathCall,
  jsxElementCount,
  jsxElementCountIn,
  lowestCommonJsxSubtree,
  nearestRepeatedRenderCall,
  oneHopRenderProjectionReferences,
  repeatedRenderHasStableItemKey,
  setterCallUsesPreviousValue,
  sourceHasRuntimeBinding,
  stateMayHoldCallable,
  uniqueVariableDeclaration,
} from "./rules/state-proofs.js";
import { callbackHasCleanup, classifyEffect } from "./rules/effects.js";
import {
  collectCommandOnlyCallableReads,
  functionalCounterUpdaterPreservesSnapshot,
  functionalUpdaterPrecedesSnapshotRead,
  refWouldChangeCommandSnapshot,
  stateFeedsReturnedSwitchCommand,
  statePublishesReadOnlyGetter,
  stateReadCallbackEscapesThroughUnknownHook,
} from "./rules/command-only-state.js";
import { collectHookImports, isImportedHookCall, isLocalHookCall } from "./imports.js";
import {
  commonRenderGateSubtree,
  findDeferredRevealStates,
  hasStateInitializer,
  isRenderGateReference,
  isSafeProjectionExpression,
  jsxSubtreeAncestors,
} from "./rules/deferred-reveal.js";
import {
  directReactHookFormEventCallbacks,
  findAsyncLeafStatuses,
} from "./rules/async-leaf-status.js";
import {
  findAncestor,
  findAncestorUntil,
  identifiersNamed,
  isNonProductionHarness,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  nodeWithin,
  scriptKindForFile,
  visit,
  visitSkippingNestedFunctions,
  visitSkippingNestedRuntimeFunctions,
} from "./ast.js";
import {
  findEffectSynchronizedDrafts,
  hasLazyStateInitializer,
  mutationRegionOnlyCallsStateSetters,
} from "./rules/effect-drafts.js";
import {
  isAdjacentEffectBooleanLeafState,
  isAdjacentEventBooleanLeafState,
  isLiteralBooleanLeafState,
  isMultiSurfaceLiteralBooleanState,
} from "./rules/literal-boolean-leaf.js";
import {
  isReactiveHostPropScalarState,
  isSourceEventScalarLeafState,
} from "./rules/event-scalar-leaf.js";
import type { AnalysisFile } from "./analysis-project.js";
import type { AsyncLeafStatusAnalysis } from "./rules/async-leaf-status.js";
import type { ChildContractResolver } from "./rules/child-contract.js";
import type { HookImports } from "./imports.js";
import type { JsxSubtreeNode } from "./rules/deferred-reveal.js";
import type { KeyedSelectionAnalysis } from "./rules/keyed-selection.js";
import type { ReactCommitContext } from "./rules/react-commit-sensitivity.js";
import type { RuntimeFunctionLike } from "./ast.js";
import { StateFlowIndex } from "./state-flow.js";
import { collectReactCommitContext } from "./rules/react-commit-sensitivity.js";
import { findLazyCallbackLeaf } from "./rules/lazy-callback-leaf.js";
import { findListenerRefStateClusters } from "./rules/listener-ref-state.js";
import { isPropertyLocalObjectDraftState } from "./rules/object-draft.js";
import path from "node:path";
import { propIsLeafRenderConsumer } from "./rules/child-contract.js";
import ts from "typescript";

const BROAD_OWNER_JSX_ELEMENTS = 12;
const COMPACT_OWNER_JSX_ELEMENTS = 8;
const DEFAULT_PRESENTATION_LEAF_COUNT = 2;
const HOOK_CALL_ARITY = 2;
const KEY_VALUE_TUPLE_LENGTH = 2;
const LARGE_OWNER_LINE_SPAN = 100;
const MAX_FEEDBACK_LEAF_ELEMENTS = 4;
const MAX_LEAF_ELEMENTS = 9;
const MAX_LEAF_SUBTREE_RATIO = 0.4;
const MAX_PROJECTION_HOPS = 3;
const MAX_REPEATED_PROJECTION_RATIO = 0.25;
const MAX_TERMINAL_LEAVES = 6;
const MIN_COLLECTION_RENDER_WORK = 2;
const MIN_DIRECT_RENDER_READS = 2;
const MIN_LEAF_SUBTREE_ELEMENTS = 2;
const MIN_OWNER_RENDER_CUT_ELEMENTS = 5;
const MIN_REPEATED_SETTER_CALLS = 2;
const MIN_TERMINAL_LEAVES = 2;
const PAIRED_CLUSTER_SIZE = 2;
const PAIRED_FINALIZER_STATEMENTS = 2;
const PAIRED_SETTER_CALLS = 2;
const PAIRED_TRANSPORT_OCCURRENCES = 2;
const SMALL_OWNER_JSX_ELEMENTS = 5;
const STABLE_CALL_SITE_PAIR = 2;
const WIDE_OWNER_LINE_SPAN = 150;

const localCallbacksByOwner = new WeakMap<
  RuntimeFunctionLike,
  ReadonlyMap<string, RuntimeFunctionLike>
>();

function calleeRootIdentifier(expression: ts.Expression): ts.Identifier | null {
  if (ts.isIdentifier(expression)) {
    return expression;
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression;
  }
  return null;
}

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
}

function declaredBindingName(node: ts.Node): string | null {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  return null;
}

function soleReturnedExpression(body: ts.ConciseBody): ts.Expression | null {
  if (!ts.isBlock(body)) {
    return body;
  }
  const [only] = body.statements;
  if (body.statements.length !== 1 || !only || !ts.isReturnStatement(only)) {
    return null;
  }
  return only.expression ?? null;
}

function soleStatementExpression(body: ts.ConciseBody): ts.Expression | null {
  if (!ts.isBlock(body)) {
    return body;
  }
  const [only] = body.statements;
  if (body.statements.length !== 1 || !only || !ts.isExpressionStatement(only)) {
    return null;
  }
  return only.expression;
}

function jsxSubtreeForOpening(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
): JsxSubtreeNode {
  return ts.isJsxOpeningElement(opening) ? opening.parent : opening;
}

function subtreeClusterOwnership(repeated: boolean, needsObservable: boolean): string {
  if (repeated) {
    return "replace them with one component-lifetime observable model and subscribe with per-item `useValue` selectors in the repeated row leaf";
  }
  if (needsObservable) {
    return "replace them with one component-lifetime observable model and subscribe in the extracted leaf with `useValue`";
  }
  return "move their ownership into the extracted leaf component";
}

function asyncStatusBoundaryLabel(callSiteCount: number, target: string | undefined): string {
  if (callSiteCount > 1) {
    const count = callSiteCount === STABLE_CALL_SITE_PAIR ? "two" : "three";
    return `${count} stable status call sites`;
  }
  return target ? `the stable \`${target}\` call site` : "the stable pending-control call site";
}

function renderCutSuffix(hasCompactBooleanCut: boolean, hasRepeatedOwnerCut: boolean): string {
  if (hasCompactBooleanCut) {
    return " The independent sibling render cut proves that these updates skip owner work.";
  }
  if (hasRepeatedOwnerCut) {
    return " The leaf subscription skips the owner's repeated render work.";
  }
  return "";
}

function competingSubscriptionsNote(subscriptions: number): string {
  if (subscriptions === 0) {
    return "";
  }
  if (subscriptions === 1) {
    return " The owner also re-renders through an existing observable subscription; isolate this state only if it updates less often than that subscription.";
  }
  return ` The owner also re-renders through ${subscriptions} existing observable subscriptions; isolate this state only if it updates less often than they do.`;
}

class DisjointSet {
  private readonly parents: number[];

  public constructor(size: number) {
    this.parents = Array.from({ length: size }, (_unused, index) => index);
  }

  public rootOf(index: number): number {
    const parent = this.parents[index];
    if (parent === undefined || parent === index) {
      return index;
    }
    const root = this.rootOf(parent);
    this.parents[index] = root;
    return root;
  }

  public join(left: number, right: number): void {
    const leftRoot = this.rootOf(left);
    const rightRoot = this.rootOf(right);
    if (leftRoot !== rightRoot) {
      this.parents[rightRoot] = leftRoot;
    }
  }
}

const EMPTY_BINDINGS: ReadonlySet<string> = new Set();
const SAFE_PROJECTION_CALLS: ReadonlySet<string> = new Set(["cn"]);
const MEMO_HOOK_NAMES: ReadonlySet<string> = new Set(["useMemo"]);
const CALLBACK_HOOK_NAMES: ReadonlySet<string> = new Set(["useCallback"]);
const MUTATION_PROPERTY_NAMES: ReadonlySet<string> = new Set(["mutate", "mutateAsync"]);
const EMPTY_NODES: ReadonlySet<ts.Node> = new Set();
const EMPTY_RUNTIME_FUNCTIONS: ReadonlySet<RuntimeFunctionLike> = new Set();
const EMPTY_STATE_CANDIDATES: ReadonlyMap<string, StateCandidate> = new Map();
const EMPTY_STATE_USAGES: ReadonlyMap<string, StateUsage> = new Map();

export interface StateCandidate {
  call: ts.CallExpression;
  owner: RuntimeFunctionLike;
  setterName: string | null;
  valueName: string;
}

export interface EffectCandidate {
  call: ts.CallExpression;
  callback: ts.ArrowFunction | ts.FunctionExpression | null;
  dependencies: ts.ArrayLiteralExpression | null;
  owner: RuntimeFunctionLike | null;
}

export interface StateUsage {
  directRenderNodes: ts.Node[];
  deferredReads: number;
  effectReads: number;
  effectWrites: number;
  escaped: boolean;
  eventReads: number;
  jsxTargets: Set<string>;
  localRenderReads: number;
  legendReactionWrites: number;
  repeatedTransport: boolean;
  repeatedValueTransport: boolean;
  setterTargets: Set<string>;
  setterCalls: number;
  setterCallNodes: ts.CallExpression[];
  setterReferences: number;
  setterTransportSites: Set<number>;
  setterUsesPreviousValue: boolean;
  shadowed: boolean;
  transportedOccurrences: number;
  unstableTransport: boolean;
  valueTransportSites: Set<number>;
  valueTargets: Set<string>;
  valueProps: Map<string, Set<string>>;
}

interface ClassifiedState {
  action: StateAction;
  confidence: "certain" | "probable";
  message: string;
}

interface ControlledFilterLeafCut {
  line: number;
  producer: string;
  target: string;
}

export interface ClassifiedEffect {
  action: EffectAction;
  confidence: "certain" | "probable";
  message: string;
  derivedState: StateCandidate | null;
}

interface EffectStateScope {
  bySetter: Map<string, StateCandidate>;
  byValue: Map<string, StateCandidate>;
  usageBySetter: Map<string, StateUsage>;
}

interface StateCluster {
  action: StateAction;
  id: string;
  members: readonly StateCandidate[];
  message: string;
  primary: StateCandidate;
}

interface SiblingRenderCut {
  consumerLabel: string;
  consumerLine: number;
}

interface ControlledProjectionCut {
  consumerLabel: string;
  consumerLine: number;
}

interface DialogPayloadCut {
  conditional: boolean;
  consumerLabel: string;
  consumerLine: number;
}

interface BranchUnmountMove {
  target: string;
}

const LAZY_CALLBACK_LEAF_PROOFS: LazyCallbackLeafProofs = {
  hasUnstableSubtreeLifetime,
  uniqueReturnedExpression,
};

function effectDraftProofs(stateFlow: StateFlowIndex): EffectDraftProofs {
  return {
    directUniqueReturnCallSite,
    hasIndependentRenderCutWitness,
    isCustomHookOwner,
    nearestMutationFunction,
    setterMutationsCanCooccur: (left, right, region) =>
      mutationsAreProvenCoexecuting(left, right, { region, stateFlow }),
    uniqueReturnedExpression,
  };
}

export function analyzeSource(
  sourceText: string,
  fileName: string,
  sourceComponents: ReadonlySet<string> = new Set(),
): HookFinding[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(fileName),
  );
  return analyzeParsedSource(sourceFile, fileName, {
    childContracts: null,
    deferredCallbackHooks: new Map(),
    legendValueBridges: new Map(),
    sourceComponents,
    stateFlow: new StateFlowIndex(),
  });
}

export function analyzeSourceFile(
  file: AnalysisFile,
  reportFileName: string,
  sourceComponents: ReadonlySet<string> = new Set(),
  stateFlow: StateFlowIndex = new StateFlowIndex(),
  childContracts: ChildContractResolver | null = null,
  legendValueBridges: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
  hookImports: HookImports = collectHookImports(file.sourceFile),
): HookFinding[] {
  return analyzeParsedSource(file.sourceFile, reportFileName, {
    childContracts,
    deferredCallbackHooks,
    imports: hookImports,
    legendValueBridges,
    sourceComponents,
    stateFlow,
  });
}

export function findingHookImports(file: AnalysisFile): HookImports | null {
  const imports = collectHookImports(file.sourceFile);
  return containsFindingHookCall(file.sourceFile, imports) ? imports : null;
}

function containsFindingHookCall(node: ts.Node, imports: HookImports): boolean {
  if (
    ts.isCallExpression(node) &&
    (isImportedHookCall(node, imports.useState, imports.reactNamespaces, "useState") ||
      isImportedHookCall(node, imports.useEffect, imports.reactNamespaces, "useEffect"))
  ) {
    return true;
  }
  return (
    node.forEachChild((child) => containsFindingHookCall(child, imports) || undefined) === true
  );
}

interface ParsedSourceAnalysisOptions {
  readonly childContracts: ChildContractResolver | null;
  readonly deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>;
  readonly imports?: HookImports;
  readonly legendValueBridges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly sourceComponents: ReadonlySet<string>;
  readonly stateFlow: StateFlowIndex;
}

interface SourceAnalysis {
  readonly childContracts: ChildContractResolver | null;
  readonly commitSensitiveOwners: ReadonlySet<RuntimeFunctionLike>;
  readonly deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>;
  readonly directEffectCallbacks: ReadonlySet<RuntimeFunctionLike>;
  readonly directEffectCalls: ReadonlySet<ts.CallExpression>;
  readonly effects: readonly EffectCandidate[];
  readonly fileName: string;
  readonly imports: HookImports;
  readonly knownComponents: ReadonlySet<string>;
  readonly legendValueBridges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly lifecycleRegions: ReadonlySet<ts.Node>;
  readonly localComponents: ReadonlySet<string>;
  readonly moduleScopeBindings: ReadonlySet<string>;
  readonly nonProductionHarness: boolean;
  readonly observableSubscriptionsByOwner: ReadonlyMap<RuntimeFunctionLike, number>;
  readonly pureProjectionImports: ReadonlySet<string>;
  readonly reactCommit: ReactCommitContext;
  readonly reactiveMutationsByOwner: ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>>;
  readonly sourceComponents: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
  readonly stateFlow: StateFlowIndex;
  readonly states: readonly StateCandidate[];
  readonly unmatchedStateCalls: readonly ts.CallExpression[];
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
  readonly useObservableBindingsByOwner: ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>>;
  readonly useValueBindingsByOwner: ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>>;
}

interface OwnerEventCallbacks {
  readonly eventCallbacksByOwner: ReadonlyMap<
    RuntimeFunctionLike,
    ReadonlySet<RuntimeFunctionLike>
  >;
  readonly sourceEventCallbacksByOwner: Map<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>;
}

interface CommandProofs {
  readonly memoizedOptionCommandStates: ReadonlySet<StateCandidate>;
  readonly reactiveMutationAffectedStates: ReadonlySet<StateCandidate>;
  readonly returnedKeyedCursorStates: ReadonlySet<StateCandidate>;
  readonly safeCommandStates: ReadonlySet<StateCandidate>;
  readonly selfRefreshingCommandStates: ReadonlySet<StateCandidate>;
  readonly subtreeByState: ReadonlyMap<StateCandidate, StateSubtree>;
}

interface OwnershipProofs {
  readonly companionWrites: StateCompanionWrites;
  readonly deferredRevealStates: ReadonlySet<StateCandidate>;
  readonly dialogPayloadCuts: ReadonlyMap<StateCandidate, DialogPayloadCut>;
  readonly effectStateScopes: ReadonlyMap<RuntimeFunctionLike, EffectStateScope>;
  readonly observableSelectionOwners: ReadonlySet<RuntimeFunctionLike>;
  readonly propertyLocalObjectDrafts: ReadonlySet<StateCandidate>;
  readonly statesWithCompanionWrites: ReadonlySet<StateCandidate>;
}

interface LeafConsumerProofs {
  readonly adjacentEffectBooleanStates: ReadonlySet<StateCandidate>;
  readonly adjacentEventBooleanStates: ReadonlySet<StateCandidate>;
  readonly asyncLeafStatuses: AsyncLeafStatusAnalysis;
  readonly branchUnmountMoves: ReadonlyMap<StateCandidate, BranchUnmountMove>;
  readonly independentStateWrites: IndependentStateWrites;
  readonly multiSurfaceBooleanStates: ReadonlySet<StateCandidate>;
  readonly reactiveHostPropScalarStates: ReadonlySet<StateCandidate>;
  readonly sourceEventScalarStates: ReadonlySet<StateCandidate>;
}

interface ClusterProofs {
  readonly effectDrafts: EffectDraftAnalysis;
  readonly keyedSelections: KeyedSelectionAnalysis;
  readonly listenerRefClusters: ReadonlyMap<StateCandidate, StateCluster>;
  readonly observableClusters: ReadonlyMap<StateCandidate, StateCluster>;
  readonly siblingRenderCuts: ReadonlyMap<StateCandidate, SiblingRenderCut>;
  readonly subtreeClusters: ReadonlyMap<StateCandidate, StateCluster>;
}

interface EffectProofs {
  readonly derivedStates: ReadonlySet<StateCandidate>;
  readonly effectClassifications: ReadonlyMap<EffectCandidate, ClassifiedEffect>;
  readonly legendValueMirrors: ReadonlyMap<StateCandidate, ClassifiedState>;
}

function sourceAnalysisBase(
  sourceFile: ts.SourceFile,
  fileName: string,
  options: ParsedSourceAnalysisOptions,
): SourceAnalysis {
  const {
    childContracts,
    deferredCallbackHooks,
    imports = collectHookImports(sourceFile),
    legendValueBridges,
    sourceComponents,
    stateFlow,
  } = options;
  const reactCommit = collectReactCommitContext(sourceFile, imports);
  const effects = reactCommit.effectCalls.map((call) => effectCandidate(call, imports));
  const { states, unmatchedStateCalls } = collectStateCandidates(sourceFile, imports);
  const localComponents = collectLocalComponents(sourceFile, imports);
  return {
    ...ownerBindingIndexes(sourceFile, imports),
    ...commitScopedIndexes(reactCommit, effects),
    childContracts,
    deferredCallbackHooks,
    effects,
    fileName,
    imports,
    knownComponents: new Set([...localComponents, ...sourceComponents]),
    legendValueBridges,
    localComponents,
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
    unmatchedStateCalls,
    usageByState: new Map(
      states.map((state) => [
        state,
        collectStateUsage(state, reactCommit.lifecycleRegions, imports),
      ]),
    ),
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
    if (
      !ts.isCallExpression(node) ||
      !isImportedHookCall(node, imports.useState, imports.reactNamespaces, "useState")
    ) {
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

function collectOwnerEventCallbacks(analysis: SourceAnalysis): OwnerEventCallbacks {
  const { states } = analysis;
  const eventCallbacksByOwner = new Map<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>();
  const sourceEventCallbacksByOwner = new Map<
    RuntimeFunctionLike,
    ReadonlySet<RuntimeFunctionLike>
  >();
  for (const [owner, ownedStates] of groupStatesByOwner(states)) {
    eventCallbacksByOwner.set(
      owner,
      ownerEventCallbacks(owner, ownedStates, {
        analysis,
        sourceEventCallbacksByOwner,
      }),
    );
  }
  return { eventCallbacksByOwner, sourceEventCallbacksByOwner };
}

interface EventCallbackScope {
  readonly analysis: SourceAnalysis;
  readonly sourceEventCallbacksByOwner: Map<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>;
}

function ownerEventCallbacks(
  owner: RuntimeFunctionLike,
  ownedStates: readonly StateCandidate[],
  { analysis, sourceEventCallbacksByOwner }: EventCallbackScope,
): ReadonlySet<RuntimeFunctionLike> {
  const { reactCommit, usageByState } = analysis;
  const callbacks = new Set<RuntimeFunctionLike>(
    reactCommit.eventTransitionCallbacks.get(owner) ?? EMPTY_RUNTIME_FUNCTIONS,
  );
  if (ownedStates.some((state) => (usageByState.get(state)?.deferredReads ?? 0) > 0)) {
    addFormEventCallbacks(owner, callbacks);
  }
  const needsProof = ownedStates.some((state) =>
    stateNeedsDeferredCallbackProof(state, usageByState.get(state), callbacks),
  );
  if (needsProof) {
    addSourceProvenEventCallbacks(owner, callbacks, { analysis, sourceEventCallbacksByOwner });
    addOptionEventCallbacks(owner, callbacks, analysis);
  }
  return callbacks;
}

function addOptionEventCallbacks(
  owner: RuntimeFunctionLike,
  callbacks: Set<RuntimeFunctionLike>,
  { childContracts, imports }: SourceAnalysis,
): void {
  if (!childContracts) {
    return;
  }
  for (const callback of sourceProvenOptionEventCallbacks(owner, imports, childContracts)) {
    addCallbackWithNestedFunctions(callback, callbacks);
  }
}

function stateNeedsDeferredCallbackProof(
  state: StateCandidate,
  usage: StateUsage | undefined,
  callbacks: ReadonlySet<RuntimeFunctionLike>,
): boolean {
  if (!usage) {
    return false;
  }
  const unprovenDeferredRead =
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.deferredReads > 0 &&
    usage.transportedOccurrences === 0 &&
    (usage.eventReads > 0 || usage.effectWrites > 0) &&
    !hasOnlyEventCommandReads(state, EMPTY_NODES, callbacks);
  const renderedBooleanCommand =
    hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.setterCallNodes.length >= MIN_REPEATED_SETTER_CALLS &&
    (usage.localRenderReads > 0 || usage.valueTransportSites.size > 0);
  return unprovenDeferredRead || renderedBooleanCommand;
}

function addFormEventCallbacks(
  owner: RuntimeFunctionLike,
  callbacks: Set<RuntimeFunctionLike>,
): void {
  for (const callback of directReactHookFormEventCallbacks(owner)) {
    callbacks.add(callback);
  }
}

function addSourceProvenEventCallbacks(
  owner: RuntimeFunctionLike,
  callbacks: Set<RuntimeFunctionLike>,
  { analysis, sourceEventCallbacksByOwner }: EventCallbackScope,
): void {
  const { childContracts, imports } = analysis;
  addFormEventCallbacks(owner, callbacks);
  const sourceCallbacks = sourceProvenDirectEventCallbacks(owner, imports, childContracts);
  sourceEventCallbacksByOwner.set(owner, sourceCallbacks);
  for (const callback of sourceCallbacks) {
    callbacks.add(callback);
  }
}

interface CommandProofSink {
  readonly memoizedOptionCommandStates: Set<StateCandidate>;
  readonly reactiveMutationAffectedStates: Set<StateCandidate>;
  readonly returnedKeyedCursorStates: Set<StateCandidate>;
  readonly safeCommandStates: Set<StateCandidate>;
  readonly selfRefreshingCommandStates: Set<StateCandidate>;
  readonly subtreeByState: Map<StateCandidate, StateSubtree>;
}

interface CommandProofScope {
  readonly analysis: SourceAnalysis;
  readonly sink: CommandProofSink;
}

function recordStateCommandProofs(
  state: StateCandidate,
  usage: StateUsage,
  { analysis, sink }: CommandProofScope,
): void {
  const reactiveMutationPaths = setterReactiveMutationPaths(
    state,
    usage,
    analysis.reactiveMutationsByOwner.get(state.owner) ?? EMPTY_BINDINGS,
  );
  if (reactiveMutationPaths.any) {
    sink.reactiveMutationAffectedStates.add(state);
  }
  const { effectOwnedMemoizedCommand, memoizedOptionCommand } = recordMemoizedCommandProofs(
    state,
    usage,
    { analysis, sink },
  );
  const projectionAllowed = stateProjectionIsSafe(state, usage, {
    memoizedCommand: effectOwnedMemoizedCommand || memoizedOptionCommand,
    reactiveMutationPaths,
  });
  if (projectionAllowed) {
    sink.safeCommandStates.add(state);
  }
  recordStateSubtreeProof(state, usage, {
    analysis,
    effectOwnedMemoizedCommand,
    projectionAllowed,
    sink,
  });
}

interface MemoizedCommandProofs {
  readonly effectOwnedMemoizedCommand: boolean;
  readonly memoizedOptionCommand: boolean;
}

function recordMemoizedCommandProofs(
  state: StateCandidate,
  usage: StateUsage,
  { analysis, sink }: CommandProofScope,
): MemoizedCommandProofs {
  const { childContracts, directEffectCalls, imports } = analysis;
  if (isEffectOwnedSelfRefreshingCommandState(state, usage, { directEffectCalls, imports })) {
    sink.selfRefreshingCommandStates.add(state);
  }
  const memoizedOptionCommand =
    childContracts !== null &&
    isSourceProvenMemoizedOptionCommand(state, usage, { childContracts, imports });
  if (memoizedOptionCommand) {
    sink.memoizedOptionCommandStates.add(state);
  }
  return {
    effectOwnedMemoizedCommand: isEffectOwnedMemoizedPresentationState(state, usage, {
      directEffectCalls,
      imports,
    }),
    memoizedOptionCommand,
  };
}

interface ProjectionSafetyEvidence {
  readonly memoizedCommand: boolean;
  readonly reactiveMutationPaths: ReactiveMutationPathCoverage;
}

function stateProjectionIsSafe(
  state: StateCandidate,
  usage: StateUsage,
  { memoizedCommand, reactiveMutationPaths }: ProjectionSafetyEvidence,
): boolean {
  return (
    !reactiveMutationPaths.all &&
    (!setterCallbackEscapesThroughUnknownHook(state, usage) || memoizedCommand) &&
    primitiveSetterUpdatersArePure(state, usage)
  );
}

interface SubtreeProofFlags {
  readonly effectOwnedMemoizedCommand: boolean;
  readonly projectionAllowed: boolean;
}

function recordStateSubtreeProof(
  state: StateCandidate,
  usage: StateUsage,
  {
    analysis,
    effectOwnedMemoizedCommand,
    projectionAllowed,
    sink,
  }: CommandProofScope & SubtreeProofFlags,
): void {
  const { childContracts, directEffectCalls, pureProjectionImports } = analysis;
  const subtree = analyzeStateSubtree(state, usage, {
    childContracts,
    directEffectCalls,
    effectOwnedMemoizedCommand,
    projectionAllowed,
    pureProjectionImports,
  });
  if (subtree) {
    sink.subtreeByState.set(state, subtree);
  }
  if (
    childContracts &&
    isEffectOwnedReturnedKeyedCursor(state, usage, { childContracts, directEffectCalls })
  ) {
    sink.returnedKeyedCursorStates.add(state);
  }
}

function collectCommandProofs(analysis: SourceAnalysis): CommandProofs {
  const { states, usageByState } = analysis;
  const sink: CommandProofSink = {
    memoizedOptionCommandStates: new Set<StateCandidate>(),
    reactiveMutationAffectedStates: new Set<StateCandidate>(),
    returnedKeyedCursorStates: new Set<StateCandidate>(),
    safeCommandStates: new Set<StateCandidate>(),
    selfRefreshingCommandStates: new Set<StateCandidate>(),
    subtreeByState: new Map<StateCandidate, StateSubtree>(),
  };
  for (const state of states) {
    const usage = usageByState.get(state);
    if (usage) {
      recordStateCommandProofs(state, usage, { analysis, sink });
    }
  }
  return sink;
}

function selectionStateOwners(
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
): ReadonlySet<RuntimeFunctionLike> {
  return new Set(
    states
      .filter((state) => {
        const usage = usageByState.get(state);
        return (
          isSetOrMapState(state.call) &&
          isCustomHookOwner(state.owner) &&
          isSelectionStateName(state.valueName) &&
          usage !== undefined &&
          usage.effectWrites === 0
        );
      })
      .map((state) => state.owner),
  );
}

interface DialogPayloadScope {
  readonly safeCommandStates: ReadonlySet<StateCandidate>;
  readonly statesWithCompanionWrites: ReadonlySet<StateCandidate>;
}

function collectDialogPayloadCuts(
  analysis: SourceAnalysis,
  { safeCommandStates, statesWithCompanionWrites }: DialogPayloadScope,
): ReadonlyMap<StateCandidate, DialogPayloadCut> {
  const { childContracts, imports, knownComponents, states, usageByState } = analysis;
  const dialogPayloadCuts = new Map<StateCandidate, DialogPayloadCut>();
  for (const state of states) {
    const usage = usageByState.get(state);
    if (!usage || statesWithCompanionWrites.has(state) || !safeCommandStates.has(state)) {
      continue;
    }
    const cut = nullableDialogPayloadCut(state, usage, {
      childContracts,
      imports,
      knownComponents,
    });
    if (cut) {
      dialogPayloadCuts.set(state, cut);
    }
  }
  return dialogPayloadCuts;
}

function objectDraftStates(
  analysis: SourceAnalysis,
  { eventCallbacksByOwner }: OwnerEventCallbacks,
  proofs: CommandProofs & { readonly statesWithCompanionWrites: ReadonlySet<StateCandidate> },
): ReadonlySet<StateCandidate> {
  const { childContracts, localComponents, sourceComponents, states, usageByState } = analysis;
  const { reactiveMutationAffectedStates, safeCommandStates, statesWithCompanionWrites } = proofs;
  return new Set(
    states.filter((state) => {
      const usage = usageByState.get(state);
      return (
        usage !== undefined &&
        isPropertyLocalObjectDraftState(state, usage, {
          childContracts,
          eventCallbacks: eventCallbacksByOwner.get(state.owner) ?? EMPTY_RUNTIME_FUNCTIONS,
          hasCompanionWrites: statesWithCompanionWrites.has(state),
          hasReactiveMutationPath: reactiveMutationAffectedStates.has(state),
          hasSafeCommands: safeCommandStates.has(state),
          localComponents,
          sourceComponents,
        })
      );
    }),
  );
}

function collectOwnershipProofs(
  analysis: SourceAnalysis,
  callbacks: OwnerEventCallbacks,
  commands: CommandProofs,
): OwnershipProofs {
  const { effects, stateFlow, states, usageByState } = analysis;
  const { safeCommandStates } = commands;
  const companionWrites = findStateCompanionWrites(states, stateFlow);
  const statesWithCompanionWrites = companionWrites.all;
  const propertyLocalObjectDrafts = objectDraftStates(analysis, callbacks, {
    ...commands,
    statesWithCompanionWrites,
  });
  const effectStateScopes = collectEffectStateScopes(states, usageByState);
  const observableSelectionOwners = selectionStateOwners(states, usageByState);
  const deferredRevealStates = findDeferredRevealStates(effects, states, usageByState);
  const dialogPayloadCuts = collectDialogPayloadCuts(analysis, {
    safeCommandStates,
    statesWithCompanionWrites,
  });
  return {
    companionWrites,
    deferredRevealStates,
    dialogPayloadCuts,
    effectStateScopes,
    observableSelectionOwners,
    propertyLocalObjectDrafts,
    statesWithCompanionWrites,
  };
}

function collectLeafConsumerProofs(
  analysis: SourceAnalysis,
  callbacks: OwnerEventCallbacks,
  proofs: CommandProofs & OwnershipProofs,
): LeafConsumerProofs {
  const { childContracts, localComponents, sourceComponents, stateFlow, states, usageByState } =
    analysis;
  const { eventCallbacksByOwner } = callbacks;
  const { reactiveMutationAffectedStates, safeCommandStates } = proofs;
  return {
    ...booleanLeafConsumerProofs(analysis, proofs),
    ...scalarLeafConsumerProofs(analysis, callbacks, proofs),
    asyncLeafStatuses: findAsyncLeafStatuses(
      states,
      usageByState,
      safeCommandStates,
      reactiveMutationAffectedStates,
      localComponents,
      sourceComponents,
      childContracts,
      eventCallbacksByOwner,
    ),
    branchUnmountMoves: findBranchUnmountMoves(states, {
      safeCommandStates,
      stateFlow,
      usageByState,
    }),
    independentStateWrites: findIndependentStateWrites(states),
  };
}

interface LiteralBooleanLeafEvidence {
  readonly hasCompanionWrites: boolean;
  readonly hasReactiveMutationPath: boolean;
  readonly hasSafeCommands: boolean;
  readonly isCustomHookOwner: boolean;
  readonly pureProjectionImports: ReadonlySet<string>;
}

interface ScalarLeafEvidence {
  readonly eventCallbacks: ReadonlySet<RuntimeFunctionLike>;
  readonly hasCompanionWrites: boolean;
  readonly hasReactiveMutationPath: boolean;
  readonly hasSafeCommands: boolean;
  readonly pureProjectionImports: ReadonlySet<string>;
  readonly useCallbackNames: ReadonlySet<string>;
}

interface BooleanLeafProofs {
  readonly adjacentEffectBooleanStates: ReadonlySet<StateCandidate>;
  readonly adjacentEventBooleanStates: ReadonlySet<StateCandidate>;
  readonly multiSurfaceBooleanStates: ReadonlySet<StateCandidate>;
}

function booleanLeafConsumerProofs(
  analysis: SourceAnalysis,
  proofs: CommandProofs & OwnershipProofs,
): BooleanLeafProofs {
  const { directEffectCallbacks, pureProjectionImports, states, usageByState } = analysis;
  const { reactiveMutationAffectedStates, safeCommandStates, statesWithCompanionWrites } = proofs;
  const evidenceFor = (state: StateCandidate): LiteralBooleanLeafEvidence => ({
    hasCompanionWrites: statesWithCompanionWrites.has(state),
    hasReactiveMutationPath: reactiveMutationAffectedStates.has(state),
    hasSafeCommands: safeCommandStates.has(state),
    isCustomHookOwner: isCustomHookOwner(state.owner),
    pureProjectionImports,
  });
  return {
    adjacentEffectBooleanStates: new Set(
      states.filter((state) => {
        const usage = usageByState.get(state);
        return (
          usage !== undefined &&
          isAdjacentEffectBooleanLeafState(state, usage, {
            ...evidenceFor(state),
            effectWritesAreDirect: usage.setterCallNodes.every((call) => {
              const callback = nearestNestedFunction(call, state.owner);
              return callback !== null && directEffectCallbacks.has(callback);
            }),
          })
        );
      }),
    ),
    adjacentEventBooleanStates: new Set(
      states.filter((state) => {
        const usage = usageByState.get(state);
        return (
          usage !== undefined && isAdjacentEventBooleanLeafState(state, usage, evidenceFor(state))
        );
      }),
    ),
    multiSurfaceBooleanStates: new Set(
      states.filter((state) => {
        const usage = usageByState.get(state);
        return (
          usage !== undefined && isMultiSurfaceLiteralBooleanState(state, usage, evidenceFor(state))
        );
      }),
    ),
  };
}

interface ScalarLeafProofs {
  readonly reactiveHostPropScalarStates: ReadonlySet<StateCandidate>;
  readonly sourceEventScalarStates: ReadonlySet<StateCandidate>;
}

function ownerSourceEventCallbacks(
  owner: RuntimeFunctionLike,
  imports: HookImports,
  { childContracts, sourceEventCallbacksByOwner }: SourceEventCallbackCache,
): ReadonlySet<RuntimeFunctionLike> {
  const cached = sourceEventCallbacksByOwner.get(owner);
  if (cached) {
    return cached;
  }
  const resolved = sourceProvenDirectEventCallbacks(owner, imports, childContracts);
  sourceEventCallbacksByOwner.set(owner, resolved);
  return resolved;
}

interface SourceEventCallbackCache {
  readonly childContracts: ChildContractResolver;
  readonly sourceEventCallbacksByOwner: Map<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>;
}

function scalarLeafConsumerProofs(
  analysis: SourceAnalysis,
  callbacks: OwnerEventCallbacks,
  proofs: CommandProofs & OwnershipProofs,
): ScalarLeafProofs {
  const { childContracts, imports, localComponents, pureProjectionImports, sourceComponents } =
    analysis;
  const { states, usageByState } = analysis;
  const { reactiveMutationAffectedStates, safeCommandStates, statesWithCompanionWrites } = proofs;
  if (!childContracts) {
    return { reactiveHostPropScalarStates: new Set(), sourceEventScalarStates: new Set() };
  }
  const cache: SourceEventCallbackCache = {
    childContracts,
    sourceEventCallbacksByOwner: callbacks.sourceEventCallbacksByOwner,
  };
  const scalarStates = states.filter(
    (state) => usageByState.get(state) !== undefined && !isCustomHookOwner(state.owner),
  );
  const evidenceFor = (state: StateCandidate): ScalarLeafEvidence => ({
    eventCallbacks: ownerSourceEventCallbacks(state.owner, imports, cache),
    hasCompanionWrites: statesWithCompanionWrites.has(state),
    hasReactiveMutationPath: reactiveMutationAffectedStates.has(state),
    hasSafeCommands: safeCommandStates.has(state),
    pureProjectionImports,
    useCallbackNames: imports.useCallback,
  });
  return {
    reactiveHostPropScalarStates: new Set(
      scalarStates.filter((state) =>
        isReactiveHostPropScalarState(state, usageByState.get(state)!, {
          ...evidenceFor(state),
          hostComponents: imports.hostComponents,
        }),
      ),
    ),
    sourceEventScalarStates: new Set(
      scalarStates.filter((state) =>
        isSourceEventScalarLeafState(state, usageByState.get(state)!, {
          ...evidenceFor(state),
          localComponents,
          sourceComponents,
        }),
      ),
    ),
  };
}

function collectClusterProofs(
  analysis: SourceAnalysis,
  proofs: CommandProofs & OwnershipProofs,
): ClusterProofs {
  const {
    childContracts,
    effects,
    imports,
    knownComponents,
    localComponents,
    sourceComponents,
    sourceFile,
    stateFlow,
    states,
    usageByState,
  } = analysis;
  const { effectStateScopes, safeCommandStates, statesWithCompanionWrites, subtreeByState } =
    proofs;
  const siblingRenderCuts = collectSiblingRenderCuts(analysis, proofs);
  return {
    effectDrafts: findEffectSynchronizedDrafts(
      effects,
      states,
      effectStateScopes,
      usageByState,
      siblingRenderCuts,
      localComponents,
      sourceComponents,
      effectDraftProofs(stateFlow),
    ),
    keyedSelections: analyzeKeyedSelections(
      states,
      usageByState,
      safeCommandStates,
      statesWithCompanionWrites,
      imports,
      childContracts,
    ),
    listenerRefClusters: findListenerRefStateClusters(states, usageByState, effects, imports),
    observableClusters: findObservableStateClusters(states, {
      childContracts,
      knownComponents,
      sourceFile,
      stateFlow,
      usageByState,
    }),
    siblingRenderCuts,
    subtreeClusters: findStateSubtreeClusters(subtreeByState, statesWithCompanionWrites),
  };
}

function collectSiblingRenderCuts(
  analysis: SourceAnalysis,
  proofs: CommandProofs & OwnershipProofs,
): ReadonlyMap<StateCandidate, SiblingRenderCut> {
  const { lifecycleRegions, states, usageByState } = analysis;
  const { safeCommandStates, statesWithCompanionWrites } = proofs;
  const siblingRenderCuts = new Map<StateCandidate, SiblingRenderCut>();
  for (const state of states) {
    const usage = usageByState.get(state);
    const cut =
      usage && safeCommandStates.has(state) && !statesWithCompanionWrites.has(state)
        ? siblingProducerConsumerCut(state, usage, lifecycleRegions)
        : null;
    if (cut) {
      siblingRenderCuts.set(state, cut);
    }
  }
  return siblingRenderCuts;
}

function collectEffectProofs(analysis: SourceAnalysis, ownership: OwnershipProofs): EffectProofs {
  const { effects, legendValueBridges, states, usageByState } = analysis;
  const { effectStateScopes } = ownership;
  const effectClassifications = new Map<EffectCandidate, ClassifiedEffect>();
  const derivedStates = new Set<StateCandidate>();
  for (const effect of effects) {
    const classification = classifyEffectFor(effect, analysis, effectStateScopes);
    effectClassifications.set(effect, classification);
    if (classification.derivedState) {
      derivedStates.add(classification.derivedState);
    }
  }
  return {
    derivedStates,
    effectClassifications,
    legendValueMirrors: findLegendValueMirrors(states, usageByState, legendValueBridges),
  };
}

function classifyEffectFor(
  effect: EffectCandidate,
  analysis: SourceAnalysis,
  effectStateScopes: ReadonlyMap<RuntimeFunctionLike, EffectStateScope>,
): ClassifiedEffect {
  const {
    childContracts,
    imports,
    moduleScopeBindings,
    nonProductionHarness,
    useObservableBindingsByOwner,
    useValueBindingsByOwner,
  } = analysis;
  const scope = effect.owner ? effectStateScopes.get(effect.owner) : undefined;
  return classifyEffect(
    effect,
    scope?.bySetter ?? EMPTY_STATE_CANDIDATES,
    scope?.byValue ?? EMPTY_STATE_CANDIDATES,
    scope?.usageBySetter ?? EMPTY_STATE_USAGES,
    effect.owner ? (useValueBindingsByOwner.get(effect.owner) ?? EMPTY_BINDINGS) : EMPTY_BINDINGS,
    effect.owner
      ? (useObservableBindingsByOwner.get(effect.owner) ?? EMPTY_BINDINGS)
      : EMPTY_BINDINGS,
    imports.useRef,
    imports.reactNamespaces,
    moduleScopeBindings,
    nonProductionHarness,
    childContracts,
  );
}

interface StateAnalysisResult {
  readonly analysis: SourceAnalysis;
  readonly callbacks: OwnerEventCallbacks;
  readonly clusters: ClusterProofs;
  readonly commands: CommandProofs;
  readonly effectProofs: EffectProofs;
  readonly leaves: LeafConsumerProofs;
  readonly ownership: OwnershipProofs;
}

function buildFindings(result: StateAnalysisResult): HookFinding[] {
  const { analysis } = result;
  const findings = [
    ...analysis.states.flatMap((state) => stateFindingFor(state, result) ?? []),
    ...analysis.unmatchedStateCalls.map((call) => unmatchedStateFinding(call, analysis)),
    ...analysis.effects.flatMap((effect) => effectFindingFor(effect, result) ?? []),
  ];
  return findings.toSorted(
    (left, right) =>
      left.location.line - right.location.line ||
      left.location.column - right.location.column ||
      left.hook.localeCompare(right.hook),
  );
}

function stateClusterFor(
  state: StateCandidate,
  { clusters }: StateAnalysisResult,
): StateCluster | undefined {
  return (
    clusters.effectDrafts.clusters.get(state) ??
    clusters.listenerRefClusters.get(state) ??
    clusters.observableClusters.get(state) ??
    clusters.subtreeClusters.get(state)
  );
}

function stateIsCommitSensitive(
  state: StateCandidate,
  usage: StateUsage,
  { commitSensitiveOwners, nonProductionHarness, reactCommit }: SourceAnalysis,
): boolean {
  const directTransitionCallbacks = reactCommit.directTransitionCallbacks.get(state.owner);
  const transitionTouchesState =
    directTransitionCallbacks?.some((callback) =>
      usage.setterCallNodes.some((call) => nodeWithin(call, callback)),
    ) ?? true;
  return (
    commitSensitiveOwners.has(state.owner) &&
    transitionTouchesState &&
    state.setterName !== null &&
    !nonProductionHarness
  );
}

function stateClassificationInputs(
  state: StateCandidate,
  usage: StateUsage,
  result: StateAnalysisResult,
): StateClassificationInputs {
  const { analysis, callbacks, clusters, commands, leaves, ownership } = result;
  return {
    belongsToObservableSelection: ownership.observableSelectionOwners.has(state.owner),
    branchUnmountMove: leaves.branchUnmountMoves.get(state) ?? null,
    childContracts: analysis.childContracts,
    deferredCallbackHooks: analysis.deferredCallbackHooks,
    dialogPayloadCut: ownership.dialogPayloadCuts.get(state) ?? null,
    eventTransitionCallbacks:
      callbacks.eventCallbacksByOwner.get(state.owner) ?? EMPTY_RUNTIME_FUNCTIONS,
    hasAdjacentEffectBooleanConsumers: leaves.adjacentEffectBooleanStates.has(state),
    hasAdjacentEventBooleanConsumers: leaves.adjacentEventBooleanStates.has(state),
    hasCompanionWrites: ownership.statesWithCompanionWrites.has(state),
    hasIndependentDirectEventWrite: leaves.independentStateWrites.directEventWrites.has(state),
    hasIndependentVisibilitySetterTransport:
      leaves.independentStateWrites.visibilitySetterTransports.has(state),
    hasMemoizedOptionCommand: commands.memoizedOptionCommandStates.has(state),
    hasMultiSurfaceBooleanConsumers: leaves.multiSurfaceBooleanStates.has(state),
    hasNonClosingCompanionWrites: ownership.companionWrites.nonClosing.has(state),
    hasReactiveHostPropScalarConsumer: leaves.reactiveHostPropScalarStates.has(state),
    hasReactiveMutationPath: commands.reactiveMutationAffectedStates.has(state),
    hasReturnedKeyedCursorConsumer: commands.returnedKeyedCursorStates.has(state),
    hasSafeCommands: commands.safeCommandStates.has(state),
    hasSourceEventScalarConsumers: leaves.sourceEventScalarStates.has(state),
    isAsyncLeafStatus: leaves.asyncLeafStatuses.isolated.has(state),
    isCohesiveAsyncStatus: leaves.asyncLeafStatuses.cohesive.has(state),
    isDeferredReveal: ownership.deferredRevealStates.has(state),
    isKeyedLeafCollection: clusters.keyedSelections.collectionStates.has(state),
    isKeyedLeafRecord: clusters.keyedSelections.recordStates.has(state),
    isKeyedLeafScalar: clusters.keyedSelections.scalarStates.has(state),
    isKeyedScalarWithSecondary: clusters.keyedSelections.secondaryLeafStates.has(state),
    isPropertyLocalObjectDraft: ownership.propertyLocalObjectDrafts.has(state),
    isSelfRefreshingCommand: commands.selfRefreshingCommandStates.has(state),
    isUnprovenAsyncStatus: leaves.asyncLeafStatuses.unproven.has(state),
    localComponents: analysis.localComponents,
    ownerObservableSubscriptions: analysis.observableSubscriptionsByOwner.get(state.owner) ?? 0,
    siblingRenderCut: clusters.siblingRenderCuts.get(state) ?? null,
    sourceComponents: analysis.sourceComponents,
    sourceFile: analysis.sourceFile,
    state,
    subtree: commands.subtreeByState.get(state) ?? null,
    usage,
  };
}

function baseStateClassification(
  state: StateCandidate,
  usage: StateUsage,
  result: StateAnalysisResult,
): ClassifiedState {
  const { analysis, clusters, effectProofs } = result;
  return (
    harnessStateClassification(state, analysis.nonProductionHarness) ??
    clusterStateClassification(stateClusterFor(state, result)) ??
    effectDraftStateClassification(
      state,
      clusters.effectDrafts.singletons.has(state),
      clusters.siblingRenderCuts.get(state),
    ) ??
    derivedStateClassification(state, effectProofs.derivedStates.has(state)) ??
    effectProofs.legendValueMirrors.get(state) ??
    classifyState(stateClassificationInputs(state, usage, result))
  );
}

function stateFindingFor(state: StateCandidate, result: StateAnalysisResult): HookFinding | null {
  const { analysis } = result;
  const usage = analysis.usageByState.get(state);
  if (!usage) {
    return null;
  }
  const baseClassification = baseStateClassification(state, usage, result);
  const commitSensitiveOverride =
    stateIsCommitSensitive(state, usage, analysis) &&
    baseClassification.action !== "review-state" &&
    baseClassification.action !== "keep-state";
  const finding = findingFor(
    state.call,
    commitSensitiveOverride ? commitSensitiveStateClassification(state) : baseClassification,
    {
      evidence: stateEvidence(state, usage, analysis.sourceFile),
      fileName: analysis.fileName,
      hook: "useState",
      name: state.valueName,
      sourceFile: analysis.sourceFile,
    },
  );
  attachClusterGroup(
    finding,
    state,
    commitSensitiveOverride ? undefined : stateClusterFor(state, result),
  );
  return finding;
}

function attachClusterGroup(
  finding: HookFinding,
  state: StateCandidate,
  cluster: StateCluster | undefined,
): void {
  if (!cluster) {
    return;
  }
  finding.group = {
    id: cluster.id,
    kind: "state-cluster",
    members: cluster.members.map((member) => member.valueName),
    primary: state === cluster.primary,
  };
}

function unmatchedStateFinding(call: ts.CallExpression, analysis: SourceAnalysis): HookFinding {
  return findingFor(
    call,
    {
      action: "review-state",
      confidence: "probable",
      message:
        "Review this React state; its binding shape is not a standard `[value, setter]` tuple.",
    },
    { fileName: analysis.fileName, hook: "useState", name: null, sourceFile: analysis.sourceFile },
  );
}

const PAIRED_DRAFT_EFFECT_CLASSIFICATION: ClassifiedEffect = {
  action: "review-effect",
  confidence: "probable",
  derivedState: null,
  message:
    "Preserve this React synchronization effect and its dependency timing; when migrating the paired draft, replace only its setter calls with one atomic observable assignment.",
};

function effectFindingFor(
  effect: EffectCandidate,
  { analysis, clusters, effectProofs, ownership }: StateAnalysisResult,
): HookFinding | null {
  const classification =
    !analysis.nonProductionHarness && clusters.effectDrafts.effects.has(effect)
      ? PAIRED_DRAFT_EFFECT_CLASSIFICATION
      : effectProofs.effectClassifications.get(effect);
  if (!classification) {
    return null;
  }
  const scope = effect.owner ? ownership.effectStateScopes.get(effect.owner) : undefined;
  return findingFor(effect.call, classification, {
    evidence: effectEvidence(
      effect,
      analysis.sourceFile,
      scope?.bySetter ?? EMPTY_STATE_CANDIDATES,
    ),
    fileName: analysis.fileName,
    hook: "useEffect",
    name: null,
    sourceFile: analysis.sourceFile,
  });
}

function analyzeParsedSource(
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

function harnessStateClassification(
  state: StateCandidate,
  nonProductionHarness: boolean,
): ClassifiedState | null {
  if (!nonProductionHarness) {
    return null;
  }
  return {
    action: "keep-state",
    confidence: "certain",
    message: `Keep \`${state.valueName}\` in this test, story, or demo harness; production render-boundary migrations do not apply here.`,
  };
}

function clusterStateClassification(cluster: StateCluster | undefined): ClassifiedState | null {
  if (!cluster) {
    return null;
  }
  return { action: cluster.action, confidence: "probable", message: cluster.message };
}

function effectDraftStateClassification(
  state: StateCandidate,
  isEffectSynchronizedDraft: boolean,
  siblingCut: SiblingRenderCut | undefined,
): ClassifiedState | null {
  if (!isEffectSynchronizedDraft) {
    return null;
  }
  const subscription = siblingCut
    ? `keep producer commands non-tracking, subscribe only in the sibling ${siblingCut.consumerLabel} boundary at line ${siblingCut.consumerLine}, and pass state-independent fallback inputs as ordinary snapshots.`
    : "mutate from edit commands, snapshot once at command entry before deferred work, and subscribe only in rendered leaves.";
  const lazyNote = hasLazyStateInitializer(state)
    ? " Preserve its lazy initializer as a once-only owner snapshot; do not pass it to Legend as a computed function."
    : "";
  return {
    action: "use-observable",
    confidence: "probable",
    message: `Replace effect-synchronized React draft \`${state.valueName}\` with one component-lifetime observable; preserve the React synchronization effect and its dependencies, ${subscription}${lazyNote}`,
  };
}

function derivedStateClassification(
  state: StateCandidate,
  isDerived: boolean,
): ClassifiedState | null {
  if (!isDerived) {
    return null;
  }
  return {
    action: "delete-derived-state",
    confidence: "certain",
    message: `Delete React state \`${state.valueName}\`; it is assigned only by a derivation effect and should be calculated directly.`,
  };
}

function commitSensitiveStateClassification(state: StateCandidate): ClassifiedState {
  return {
    action: "review-state",
    confidence: "probable",
    message: `Review React state \`${state.valueName}\`; updating it currently participates in a React transition, every-commit effect, or callback-ref lifecycle in this owner, so isolating the render could change priority or commit cadence.`,
  };
}

function stateCandidate(call: ts.CallExpression): StateCandidate | null {
  const declaration = call.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== call) {
    return null;
  }
  if (!ts.isArrayBindingPattern(declaration.name)) {
    return null;
  }
  const [value, setter] = declaration.name.elements;
  const owner = findAncestor(call, isRuntimeFunctionLike);
  if (
    !owner ||
    !value ||
    ts.isOmittedExpression(value) ||
    !ts.isIdentifier(value.name) ||
    (setter && !ts.isOmittedExpression(setter) && !ts.isIdentifier(setter.name))
  ) {
    return null;
  }
  return {
    call,
    owner,
    setterName: bindingElementName(setter),
    valueName: value.name.text,
  };
}

function bindingElementName(element: ts.ArrayBindingElement | undefined): string | null {
  if (!element || ts.isOmittedExpression(element) || !ts.isIdentifier(element.name)) {
    return null;
  }
  return element.name.text;
}

function effectCandidate(call: ts.CallExpression, imports: HookImports): EffectCandidate {
  const [callbackArg, dependenciesArg] = call.arguments;
  const owner = findAncestor(call, isRuntimeFunctionLike);
  return {
    call,
    callback: callbackArg ? resolveEffectCallback(callbackArg, owner, imports) : null,
    dependencies:
      dependenciesArg && ts.isArrayLiteralExpression(dependenciesArg) ? dependenciesArg : null,
    owner,
  };
}

function resolveEffectCallback(
  expression: ts.Expression,
  owner: RuntimeFunctionLike | null,
  imports: HookImports,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const callback = unwrapTransparentExpression(expression);
  if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
    return callback;
  }
  if (!owner?.body || !ts.isIdentifier(callback)) {
    return null;
  }

  const initializer = uniqueConstFunctionInitializer(owner, callback.text);
  if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
    return initializer;
  }
  return initializer ? unshadowedUseCallbackFactory(initializer, owner, imports) : null;
}

function uniqueConstFunctionInitializer(
  owner: RuntimeFunctionLike,
  binding: string,
): ts.Expression | null {
  const declaration = owner.body ? uniqueVariableDeclaration(owner.body, binding) : null;
  if (
    !declaration?.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, binding) !== 1
  ) {
    return null;
  }
  return unwrapTransparentExpression(declaration.initializer);
}

function unshadowedUseCallbackFactory(
  initializer: ts.Expression,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (
    !ts.isCallExpression(initializer) ||
    !isImportedHookCall(initializer, imports.useCallback, imports.reactNamespaces, "useCallback") ||
    initializer.arguments.length !== HOOK_CALL_ARITY
  ) {
    return null;
  }
  const hookRoot = calleeRootIdentifier(initializer.expression);
  if (!hookRoot || bindingDeclarationCount(owner, hookRoot.text) !== 0) {
    return null;
  }
  const [inner] = initializer.arguments;
  return inner && (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) ? inner : null;
}

const PURE_MATH_METHODS: ReadonlySet<string> = new Set(["abs", "max", "min"]);

function collectEffectStateScopes(
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
): ReadonlyMap<RuntimeFunctionLike, EffectStateScope> {
  const scopes = new Map<RuntimeFunctionLike, EffectStateScope>();
  for (const state of states) {
    let scope = scopes.get(state.owner);
    if (!scope) {
      scope = { bySetter: new Map(), byValue: new Map(), usageBySetter: new Map() };
      scopes.set(state.owner, scope);
    }
    registerStateInScope(scope, state, usageByState.get(state));
  }
  return scopes;
}

function registerStateInScope(
  scope: EffectStateScope,
  state: StateCandidate,
  usage: StateUsage | undefined,
): void {
  scope.byValue.set(state.valueName, state);
  if (!state.setterName) {
    return;
  }
  scope.bySetter.set(state.setterName, state);
  if (usage) {
    scope.usageBySetter.set(state.setterName, usage);
  }
}

function collectUseValueBindings(
  sourceFile: ts.SourceFile,
  imports: HookImports,
): ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>> {
  const bindings = new Map<RuntimeFunctionLike, Set<string>>();
  visit(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
      return;
    }
    if (
      !ts.isCallExpression(node.initializer) ||
      !isLocalHookCall(node.initializer, imports.useValue)
    ) {
      return;
    }
    const owner = findAncestor(node, isRuntimeFunctionLike);
    if (!owner || bindingDeclarationCount(owner, node.name.text) !== 1) {
      return;
    }
    const ownerBindings = bindings.get(owner) ?? new Set<string>();
    ownerBindings.add(node.name.text);
    bindings.set(owner, ownerBindings);
  });
  return bindings;
}

const OBSERVABLE_SUBSCRIPTION_HOOKS = new Set(["useValue", "useSelector", "use$"]);

function collectObservableSubscriptionCounts(
  sourceFile: ts.SourceFile,
  imports: HookImports,
): ReadonlyMap<RuntimeFunctionLike, number> {
  const counts = new Map<RuntimeFunctionLike, number>();
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !isObservableSubscriptionHookCall(node, imports)) {
      return;
    }
    const owner = findAncestor(node, isRuntimeFunctionLike);
    if (!owner) {
      return;
    }
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  });
  return counts;
}

function isObservableSubscriptionHookCall(call: ts.CallExpression, imports: HookImports): boolean {
  const { expression } = call;
  if (ts.isIdentifier(expression)) {
    return imports.useValue.has(expression.text) || imports.legacyUseValue.has(expression.text);
  }
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    imports.legendReactNamespaces.has(expression.expression.text) &&
    OBSERVABLE_SUBSCRIPTION_HOOKS.has(expression.name.text)
  );
}

function collectStableUseObservableBindings(
  sourceFile: ts.SourceFile,
  imports: HookImports,
): ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>> {
  const bindings = new Map<RuntimeFunctionLike, Set<string>>();
  visit(sourceFile, (node) => {
    const owner = stableObservableBindingOwner(node, imports);
    if (!owner || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) {
      return;
    }
    const ownerBindings = bindings.get(owner) ?? new Set<string>();
    ownerBindings.add(node.name.text);
    bindings.set(owner, ownerBindings);
  });
  return bindings;
}

function stableObservableBindingOwner(
  node: ts.Node,
  imports: HookImports,
): RuntimeFunctionLike | null {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
    return null;
  }
  if (
    !ts.isCallExpression(node.initializer) ||
    !isLocalHookCall(node.initializer, imports.useObservable) ||
    !ts.isVariableDeclarationList(node.parent) ||
    (node.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  const owner = findAncestor(node, isRuntimeFunctionLike);
  return owner && bindingDeclarationCount(owner, node.name.text) === 1 ? owner : null;
}

function collectModuleScopeBindings(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const bindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    addModuleScopeStatementBindings(statement, bindings);
  }
  return bindings;
}

function addModuleScopeStatementBindings(statement: ts.Statement, bindings: Set<string>): void {
  if (ts.isImportDeclaration(statement)) {
    addImportClauseBindings(statement.importClause, bindings);
    return;
  }
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
    bindings.add(statement.name.text);
    return;
  }
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      collectBindingNames(declaration.name, bindings);
    }
  }
}

function addImportClauseBindings(clause: ts.ImportClause | undefined, bindings: Set<string>): void {
  if (clause?.name) {
    bindings.add(clause.name.text);
  }
  const named = clause?.namedBindings;
  if (named && ts.isNamespaceImport(named)) {
    bindings.add(named.name.text);
  }
  if (named && ts.isNamedImports(named)) {
    for (const element of named.elements) {
      bindings.add(element.name.text);
    }
  }
}

function collectReactiveMutationBindings(
  sourceFile: ts.SourceFile,
): ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>> {
  const result = new Map<RuntimeFunctionLike, Set<string>>();
  visit(sourceFile, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !node.initializer ||
      !ts.isCallExpression(node.initializer) ||
      !ts.isIdentifier(node.initializer.expression) ||
      !/^use[A-Z0-9]/u.test(node.initializer.expression.text)
    ) {
      return;
    }
    const owner = findAncestor(node, isRuntimeFunctionLike);
    if (!owner) {
      return;
    }
    const bindings = result.get(owner) ?? new Set<string>();
    if (addMutationBindingNames(node.name, bindings)) {
      result.set(owner, bindings);
    }
  });
  return result;
}

function addMutationBindingNames(name: ts.BindingName, bindings: Set<string>): boolean {
  if (ts.isIdentifier(name)) {
    bindings.add(`${name.text}.mutate`);
    bindings.add(`${name.text}.mutateAsync`);
    return true;
  }
  const destructured = ts.isObjectBindingPattern(name)
    ? name.elements.filter(
        (element) =>
          ts.isIdentifier(element.name) &&
          MUTATION_PROPERTY_NAMES.has(element.propertyName?.getText() ?? element.name.text),
      )
    : [];
  for (const element of destructured) {
    bindings.add(element.name.getText());
  }
  return destructured.length > 0;
}

function collectStateUsage(
  state: StateCandidate,
  effectNodes: ReadonlySet<ts.Node>,
  imports: HookImports,
): StateUsage {
  const usage = emptyStateUsage();
  for (const node of stateBindingIdentifiers(state)) {
    recordStateBindingReference(node, state, { effectNodes, imports, usage });
  }
  mergeCommandOnlyCallableReads(usage, state, effectNodes);
  return usage;
}

function recordStateBindingReference(
  node: ts.Identifier,
  state: StateCandidate,
  context: StateReferenceContext,
): void {
  if (isNonValueIdentifier(node)) {
    return;
  }
  if (isDeclarationName(node)) {
    context.usage.shadowed ||= shadowsStateBinding(node, state);
    return;
  }
  if (state.setterName !== null && node.text === state.setterName) {
    classifySetterReference(node, state, context);
    return;
  }
  if (node.text === state.valueName) {
    classifyValueReference(node, state, context);
  }
}

function shadowsStateBinding(node: ts.Identifier, state: StateCandidate): boolean {
  return (
    (node.text === state.valueName ||
      (state.setterName !== null && node.text === state.setterName)) &&
    !isOriginalStateBinding(node, state.call)
  );
}

function emptyStateUsage(): StateUsage {
  return {
    deferredReads: 0,
    directRenderNodes: [],
    effectReads: 0,
    effectWrites: 0,
    escaped: false,
    eventReads: 0,
    jsxTargets: new Set<string>(),
    legendReactionWrites: 0,
    localRenderReads: 0,
    repeatedTransport: false,
    repeatedValueTransport: false,
    setterCallNodes: [],
    setterCalls: 0,
    setterReferences: 0,
    setterTargets: new Set<string>(),
    setterTransportSites: new Set<number>(),
    setterUsesPreviousValue: false,
    shadowed: false,
    transportedOccurrences: 0,
    unstableTransport: false,
    valueProps: new Map<string, Set<string>>(),
    valueTargets: new Set<string>(),
    valueTransportSites: new Set<number>(),
  };
}

function mergeCommandOnlyCallableReads(
  usage: StateUsage,
  state: StateCandidate,
  effectNodes: ReadonlySet<ts.Node>,
): void {
  const callableReads = collectCommandOnlyCallableReads(state, effectNodes);
  usage.localRenderReads += callableReads.renderSites.length;
  usage.directRenderNodes.push(...callableReads.renderSites);
  if (usage.effectReads === 0) {
    usage.effectReads += callableReads.effectSites.length;
  }
}

function stateBindingIdentifiers(state: StateCandidate): readonly ts.Identifier[] {
  const values = identifiersNamed(state.owner.body, state.valueName);
  if (!state.setterName || state.setterName === state.valueName) {
    return values;
  }
  const setters = identifiersNamed(state.owner.body, state.setterName);
  if (values.length === 0) {
    return setters;
  }
  if (setters.length === 0) {
    return values;
  }

  return mergeByPosition(values, setters);
}

function mergeByPosition(
  left: readonly ts.Identifier[],
  right: readonly ts.Identifier[],
): readonly ts.Identifier[] {
  const ordered: ts.Identifier[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const takeLeft = left[leftIndex]!.pos < right[rightIndex]!.pos;
    ordered.push(takeLeft ? left[leftIndex]! : right[rightIndex]!);
    leftIndex += takeLeft ? 1 : 0;
    rightIndex += takeLeft ? 0 : 1;
  }
  ordered.push(...left.slice(leftIndex), ...right.slice(rightIndex));
  return ordered;
}

function addMapSet<Key, Value>(map: Map<Key, Set<Value>>, key: Key, value: Value): void {
  const values = map.get(key) ?? new Set<Value>();
  values.add(value);
  map.set(key, values);
}

function hasLocalRenderConsumer(usage: StateUsage): boolean {
  return (
    usage.transportedOccurrences === 0 &&
    usage.localRenderReads > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length
  );
}

function hasPairedTransportConsumer(usage: StateUsage): boolean {
  return (
    usage.localRenderReads === 0 &&
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1 &&
    usage.setterTransportSites.size === 1 &&
    usage.setterTargets.size === 1 &&
    usage.setterCalls === 0 &&
    usage.setterReferences === 1 &&
    usage.transportedOccurrences === PAIRED_TRANSPORT_OCCURRENCES &&
    !usage.repeatedTransport &&
    !usage.unstableTransport
  );
}

function uniqueSetterProducer(
  state: StateCandidate,
  usage: StateUsage,
  effectNodes: ReadonlySet<ts.Node>,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const setterNames = new Set(state.setterName === null ? [] : [state.setterName]);
  const commandCalls = usage.setterCallNodes.filter((call) => !hasAncestorInSet(call, effectNodes));
  const commandProducers = commandCalls.map((call) => jsxProducerForSetterCall(call, state.owner));
  const producer =
    commandCalls.length > 0 ? commandProducers[0] : directTransportProducer(usage, state.owner);
  if (
    !producer ||
    commandProducers.some((candidate) => candidate !== producer) ||
    commandCalls.some(
      (call) =>
        !mutationRegionOnlyCallsStateSetters(
          nearestMutationFunction(call, state.owner),
          setterNames,
        ),
    )
  ) {
    return null;
  }
  return producer;
}

function subtreesAreStableSiblings(
  producerSubtree: JsxSubtreeNode,
  consumer: JsxSubtreeNode,
  owner: RuntimeFunctionLike,
): boolean {
  return (
    producerSubtree !== consumer &&
    !nodeWithin(producerSubtree, consumer) &&
    !nodeWithin(consumer, producerSubtree) &&
    !nearestRepeatedRenderCall(producerSubtree, owner) &&
    !hasUnstableSubtreeLifetime(producerSubtree, owner) &&
    !hasUnstableSubtreeLifetime(consumer, owner) &&
    shareUniqueOwnerReturn(producerSubtree, consumer, owner)
  );
}

function stateAllowsSiblingRenderCut(state: StateCandidate, usage: StateUsage): boolean {
  return (
    state.setterName !== null &&
    !isCustomHookOwner(state.owner) &&
    jsxElementCount(state.owner) >= SMALL_OWNER_JSX_ELEMENTS &&
    (hasLocalRenderConsumer(usage) || hasPairedTransportConsumer(usage)) &&
    usage.effectReads === 0 &&
    usage.deferredReads === 0 &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped &&
    !stateMayHoldCallable(state)
  );
}

function siblingProducerConsumerCut(
  state: StateCandidate,
  usage: StateUsage,
  effectNodes: ReadonlySet<ts.Node>,
): SiblingRenderCut | null {
  if (!stateAllowsSiblingRenderCut(state, usage)) {
    return null;
  }
  const consumer = siblingProjectionConsumer(state, usage);
  if (!consumer) {
    return null;
  }
  const producer = uniqueSetterProducer(state, usage, effectNodes);
  if (
    !producer ||
    !subtreesAreStableSiblings(jsxSubtreeForOpening(producer), consumer, state.owner)
  ) {
    return null;
  }
  return {
    consumerLabel: jsxSubtreeLabel(consumer),
    consumerLine:
      consumer.getSourceFile().getLineAndCharacterOfPosition(consumer.getStart()).line + 1,
  };
}

function siblingProjectionConsumer(
  state: StateCandidate,
  usage: StateUsage,
): JsxSubtreeNode | null {
  if (usage.localRenderReads === 0) {
    const opening = directUniqueReturnCallSite(usage, state.owner)?.opening;
    return opening ? jsxSubtreeForOpening(opening) : null;
  }
  const references = oneHopRenderProjectionReferences(state.owner, usage.directRenderNodes);
  if (
    !references ||
    references.some((reference) => !isSafeSiblingProjectionReference(reference, state.owner))
  ) {
    return null;
  }
  const consumer = sharedProjectionSubtree(references, state.owner);
  return consumer &&
    jsxElementCountIn(consumer) / jsxElementCount(state.owner) <= MAX_LEAF_SUBTREE_RATIO
    ? consumer
    : null;
}

function sharedProjectionSubtree(
  references: readonly ts.Identifier[],
  owner: RuntimeFunctionLike,
): JsxSubtreeNode | null {
  const repeated = references.map((reference) => nearestRepeatedRenderCall(reference, owner));
  const [repeatedCall] = repeated;
  if (repeated.some((call) => call !== repeatedCall)) {
    return null;
  }
  return repeatedCall
    ? (jsxSubtreeAncestors(repeatedCall, owner)[0] ?? null)
    : lowestCommonJsxSubtree(references, owner);
}

function isSafeSiblingProjectionReference(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
): boolean {
  if (
    isRenderGateReference(reference, owner) &&
    !findAncestorUntil(reference, ts.isJsxAttribute, owner)
  ) {
    return false;
  }
  if (!findAncestorUntil(reference, isJsxNode, owner)) {
    return false;
  }
  return (
    isSafeJsxProjectionReference(reference, owner, SAFE_PROJECTION_CALLS) ||
    isSnapshotFallbackReference(reference, owner)
  );
}

function isSnapshotFallbackReference(reference: ts.Identifier, boundary: ts.Node): boolean {
  const attribute = findAncestorUntil(reference, ts.isJsxAttribute, boundary);
  const initializer = attribute?.initializer;
  if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) {
    return false;
  }
  const expression = unwrapTransparentExpression(initializer.expression);
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
    unwrapTransparentExpression(expression.left) !== reference
  ) {
    return false;
  }
  let readsStateAgain = false;
  visit(expression.right, (node) => {
    if (ts.isIdentifier(node) && node.text === reference.text) {
      readsStateAgain = true;
    }
  });
  return !readsStateAgain;
}

function directTransportProducer(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const [site] = [...usage.setterTransportSites];
  const valueCallSite = directUniqueReturnCallSite(usage, owner);
  if (site === undefined || !valueCallSite) {
    return null;
  }
  const openings: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  visitSkippingNestedRuntimeFunctions(valueCallSite.returned, (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.getStart() === site
    ) {
      openings.push(node);
    }
  });
  return openings.length === 1 ? openings[0]! : null;
}

function uniqueLocalCallbackBinding(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): string | null {
  const callback = nearestMutationFunction(call, owner);
  if (
    callback === owner ||
    (!ts.isArrowFunction(callback) &&
      !ts.isFunctionDeclaration(callback) &&
      !ts.isFunctionExpression(callback))
  ) {
    return null;
  }
  const name = localCallbackBindingName(callback);
  return name && bindingDeclarationCount(owner, name) === 1 ? name : null;
}

function jsxProducerForSetterCall(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const directAttribute = findAncestorUntil(call, ts.isJsxAttribute, owner);
  if (directAttribute && /^on[A-Z]/u.test(directAttribute.name.getText())) {
    return jsxOpeningForAttribute(directAttribute);
  }

  const name = uniqueLocalCallbackBinding(call, owner);
  if (!name) {
    return null;
  }
  const openings = eventHandlerOpeningsForBinding(owner, name);
  return openings?.length === 1 ? openings[0]! : null;
}

function eventHandlerOpeningsForBinding(
  owner: RuntimeFunctionLike,
  name: string,
): (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] | null {
  const openings: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  let unsafeReference = false;
  visit(owner.body, (node) => {
    if (
      unsafeReference ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const opening = eventHandlerOpeningForReference(node, owner);
    if (opening) {
      openings.push(opening);
    } else {
      unsafeReference = true;
    }
  });
  return unsafeReference ? null : openings;
}

function eventHandlerOpeningForReference(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
  if (
    !attribute ||
    !/^on[A-Z]/u.test(attribute.name.getText()) ||
    !isDirectJsxAttributeExpression(attribute, node)
  ) {
    return null;
  }
  return jsxOpeningForAttribute(attribute);
}

function localCallbackBindingName(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
): string | null {
  if (ts.isFunctionDeclaration(callback)) {
    return callback.name?.text ?? null;
  }
  if (
    ts.isVariableDeclaration(callback.parent) &&
    callback.parent.initializer === callback &&
    ts.isIdentifier(callback.parent.name)
  ) {
    return callback.parent.name.text;
  }
  const call = callback.parent;
  return ts.isCallExpression(call) &&
    call.arguments[0] === callback &&
    ts.isVariableDeclaration(call.parent) &&
    call.parent.initializer === call &&
    ts.isIdentifier(call.parent.name)
    ? call.parent.name.text
    : null;
}

function sourceProvenDirectEventCallbacks(
  owner: RuntimeFunctionLike,
  imports: HookImports,
  childContracts: ChildContractResolver | null,
): ReadonlySet<RuntimeFunctionLike> {
  const callbacks = new Set<RuntimeFunctionLike>();
  if (!owner.body) {
    return callbacks;
  }
  visitDirectOwnerNodes(owner.body, (node) => {
    if (isInlineDeferredEventCallback(node, owner, childContracts)) {
      callbacks.add(node);
    }
    const callback = deferredPublishedCallback(node, owner, { childContracts, imports });
    if (callback) {
      callbacks.add(callback);
    }
  });
  return callbacks;
}

function isInlineDeferredEventCallback(
  node: ts.Node,
  owner: RuntimeFunctionLike,
  childContracts: ChildContractResolver | null,
): node is ts.ArrowFunction | ts.FunctionExpression {
  if (node === owner || (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node))) {
    return false;
  }
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
  return (
    attribute?.initializer !== undefined &&
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression !== undefined &&
    unwrapTransparentExpression(attribute.initializer.expression) === node &&
    jsxEventAttributeIsDeferred(attribute, childContracts)
  );
}

interface DeferredPublicationScope {
  readonly childContracts: ChildContractResolver | null;
  readonly imports: HookImports;
}

function deferredPublishedCallback(
  node: ts.Node,
  owner: RuntimeFunctionLike,
  { childContracts, imports }: DeferredPublicationScope,
): RuntimeFunctionLike | null {
  const binding = declaredBindingName(node);
  const callback = binding ? localCallbackByBinding(owner, binding, imports) : null;
  if (!binding || !callback) {
    return null;
  }
  const publications = jsxComponentPublications(owner, binding);
  return publications.length > 0 &&
    publications.every((publication) => publicationIsDeferred(publication, childContracts))
    ? callback
    : null;
}

function publicationIsDeferred(
  publication: ComponentPublication,
  childContracts: ChildContractResolver | null,
): boolean {
  if (
    /^on[A-Z]/u.test(publication.prop) &&
    (publication.intrinsic ||
      childContracts?.frameworkEventComponent(publication.component) === true)
  ) {
    return true;
  }
  return (
    childContracts?.componentCallbackPropIsDeferred(publication.component, publication.prop) ===
    true
  );
}

function sourceProvenOptionEventCallbacks(
  owner: RuntimeFunctionLike,
  imports: HookImports,
  childContracts: ChildContractResolver,
): ReadonlySet<RuntimeFunctionLike> {
  const callbacks = new Set<RuntimeFunctionLike>();
  if (!owner.body) {
    return callbacks;
  }
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    collectMemoizedOptionCallbacks(node, callbacks, { childContracts, imports, owner });
  });
  return callbacks;
}

interface MemoizedOptionScope {
  readonly childContracts: ChildContractResolver;
  readonly imports: HookImports;
  readonly owner: RuntimeFunctionLike;
}

interface MemoizedOptionPublication extends MemoizedOptionScope {
  readonly memo: MemoizedObjectLiteral;
  readonly publications: readonly ComponentPublication[];
}

function uniqueMemoizedOptionsBinding(
  node: ts.VariableDeclaration,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): MemoizedObjectLiteral | null {
  if (!node.initializer || bindingDeclarationCount(owner, node.name.getText()) !== 1) {
    return null;
  }
  const memo = memoizedObjectLiteral(node.initializer, imports);
  return memo && !memo.object.properties.some(ts.isSpreadAssignment) ? memo : null;
}

function collectMemoizedOptionCallbacks(
  node: ts.Node,
  callbacks: Set<RuntimeFunctionLike>,
  scope: MemoizedOptionScope,
): void {
  const published = publishedMemoizedOptions(node, scope);
  if (!published) {
    return;
  }
  for (const property of published.memo.object.properties) {
    const callback = deferredOptionCallback(property, { ...scope, ...published });
    if (callback) {
      callbacks.add(callback);
    }
  }
}

interface PublishedMemoizedOptions {
  readonly memo: MemoizedObjectLiteral;
  readonly publications: readonly ComponentPublication[];
}

function publishedMemoizedOptions(
  node: ts.Node,
  { imports, owner }: MemoizedOptionScope,
): PublishedMemoizedOptions | null {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) {
    return null;
  }
  const memo = uniqueMemoizedOptionsBinding(node, owner, imports);
  const publications = memo ? jsxComponentPublications(owner, node.name.text) : [];
  return memo && publications.length > 0 ? { memo, publications } : null;
}

function deferredOptionCallback(
  property: ts.ObjectLiteralElementLike,
  { childContracts, imports, memo, owner, publications }: MemoizedOptionPublication,
): RuntimeFunctionLike | null {
  if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
    return null;
  }
  const propertyName = staticPropertyName(property.name);
  const callbackName = ts.isShorthandPropertyAssignment(property)
    ? property.name
    : unwrapTransparentExpression(property.initializer);
  if (!propertyName || !ts.isIdentifier(callbackName)) {
    return null;
  }
  const callback = localCallbackByBinding(owner, callbackName.text, imports);
  if (
    !callback ||
    !memo.dependencies.elements.some(
      (element) => ts.isIdentifier(element) && element.text === callbackName.text,
    ) ||
    !callbackPublishedOnlyThroughMemo(owner, callbackName.text, {
      memoCall: memo.call,
      property,
    }) ||
    !publications.every((publication) =>
      childContracts.componentPropCallbackIsDeferred(
        publication.component,
        publication.prop,
        propertyName,
      ),
    )
  ) {
    return null;
  }
  return callback;
}

interface MemoizedObjectLiteral {
  call: ts.CallExpression;
  dependencies: ts.ArrayLiteralExpression;
  object: ts.ObjectLiteralExpression;
}

interface MemoHookCall {
  readonly call: ts.CallExpression;
  readonly dependencies: ts.ArrayLiteralExpression;
  readonly factory: ts.ArrowFunction | ts.FunctionExpression;
}

function memoHookCall(initializer: ts.Expression, imports: HookImports): MemoHookCall | null {
  const call = unwrapTransparentExpression(initializer);
  if (
    !ts.isCallExpression(call) ||
    !isImportedHookCall(call, imports.useMemo, imports.reactNamespaces, "useMemo") ||
    call.arguments.length !== HOOK_CALL_ARITY
  ) {
    return null;
  }
  const [factory, dependencies] = call.arguments;
  if (
    !factory ||
    (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) ||
    !dependencies ||
    !ts.isArrayLiteralExpression(dependencies)
  ) {
    return null;
  }
  return { call, dependencies, factory };
}

function memoizedObjectLiteral(
  initializer: ts.Expression,
  imports: HookImports,
): MemoizedObjectLiteral | null {
  const memo = memoHookCall(initializer, imports);
  const returned = memo ? soleReturnedExpression(memo.factory.body) : null;
  if (!memo || !returned) {
    return null;
  }
  const expression = unwrapTransparentExpression(returned);
  return ts.isObjectLiteralExpression(expression)
    ? { call: memo.call, dependencies: memo.dependencies, object: expression }
    : null;
}

interface ComponentPublication {
  component: string;
  intrinsic: boolean;
  prop: string;
}

function jsxComponentPublications(
  owner: RuntimeFunctionLike,
  binding: string,
): readonly ComponentPublication[] {
  const publications: ComponentPublication[] = [];
  for (const node of identifiersNamed(owner.body, binding)) {
    if (isDeclarationName(node) || isNonValueIdentifier(node)) {
      continue;
    }
    const publication = eventHandlerPublication(node, owner);
    if (!publication) {
      return [];
    }
    publications.push(publication);
  }
  return publications;
}

function eventHandlerPublication(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
): ComponentPublication | null {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
  const component = attribute ? jsxTargetName(attribute) : null;
  if (!attribute || !component || !isJsxEventHandlerReference(attribute, node)) {
    return null;
  }
  return {
    component,
    intrinsic: !isCustomJsxTarget(component),
    prop: attribute.name.getText(),
  };
}

interface MemoPublication {
  readonly memoCall: ts.CallExpression;
  readonly property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment;
}

function callbackPublishedOnlyThroughMemo(
  owner: RuntimeFunctionLike,
  binding: string,
  { memoCall, property }: MemoPublication,
): boolean {
  let propertyReferences = 0;
  for (const node of identifiersNamed(owner.body, binding)) {
    if (isDeclarationName(node) || isNonValueIdentifier(node)) {
      continue;
    }
    if (nodeWithin(node, property)) {
      propertyReferences += 1;
      continue;
    }
    if (!isOwnMemoDependencyReference(node, owner, memoCall)) {
      return false;
    }
  }
  return propertyReferences === 1;
}

function isOwnMemoDependencyReference(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
  memoCall: ts.CallExpression,
): boolean {
  if (!isHookDependencyReference(node, MEMO_HOOK_NAMES)) {
    return false;
  }
  return findAncestorUntil(node, ts.isCallExpression, owner) === memoCall;
}

function collectLocalCallbackDeclaration(
  node: ts.Node,
  collected: Map<string, RuntimeFunctionLike>,
  imports: HookImports,
): void {
  if (ts.isFunctionDeclaration(node) && node.name) {
    collected.set(node.name.text, node);
    return;
  }
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
    return;
  }
  const callback = declaredCallbackInitializer(node.initializer, imports);
  if (callback) {
    collected.set(node.name.text, callback);
  }
}

function declaredCallbackInitializer(
  initializer: ts.Expression,
  imports: HookImports,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const expression = unwrapTransparentExpression(initializer);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return expression;
  }
  return useCallbackFactory(expression, imports);
}

function useCallbackFactory(
  initializer: ts.Expression,
  imports: HookImports,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (
    !ts.isCallExpression(initializer) ||
    !isImportedHookCall(initializer, imports.useCallback, imports.reactNamespaces, "useCallback")
  ) {
    return null;
  }
  const [callback] = initializer.arguments;
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return null;
  }
  return callback;
}

function localCallbackByBinding(
  owner: RuntimeFunctionLike,
  binding: string,
  imports: HookImports,
): RuntimeFunctionLike | null {
  if (!owner.body || bindingDeclarationCount(owner, binding) !== 1) {
    return null;
  }
  let callbacks = localCallbacksByOwner.get(owner);
  if (!callbacks) {
    const collected = new Map<string, RuntimeFunctionLike>();
    visitDirectOwnerNodes(owner.body, (node) => {
      collectLocalCallbackDeclaration(node, collected, imports);
    });
    callbacks = collected;
    localCallbacksByOwner.set(owner, callbacks);
  }
  return callbacks.get(binding) ?? null;
}

function addCallbackWithNestedFunctions(
  callback: RuntimeFunctionLike,
  callbacks: Set<RuntimeFunctionLike>,
): void {
  callbacks.add(callback);
  if (!callback.body) {
    return;
  }
  visit(callback.body, (node) => {
    if (isRuntimeFunctionLike(node)) {
      callbacks.add(node);
    }
  });
}

function visitDirectOwnerNodes(node: ts.Node, onNode: (node: ts.Node) => void): void {
  node.forEachChild((child) => {
    onNode(child);
    if (!isRuntimeFunctionLike(child)) {
      visitDirectOwnerNodes(child, onNode);
    }
  });
}

function jsxOpeningForAttribute(
  attribute: ts.JsxAttribute,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const opening = attribute.parent.parent;
  return ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening) ? opening : null;
}

function shareUniqueOwnerReturn(
  left: ts.Node,
  right: ts.Node,
  owner: RuntimeFunctionLike,
): boolean {
  const returned = uniqueReturnedExpression(owner);
  return returned !== null && nodeWithin(left, returned) && nodeWithin(right, returned);
}

type ObservableClusterKind =
  | "dialog"
  | "gated-feedback"
  | "persistent-dialog"
  | "selection"
  | "text-draft";

interface ObservableClusterMembers {
  readonly gatedFeedbackMembers: readonly StateCandidate[] | null;
  readonly hasBoundedDialogGate: boolean;
  readonly selectionMembers: readonly StateCandidate[] | null;
  readonly textDraftMembers: readonly StateCandidate[] | null;
}

function observableClusterKind(members: ObservableClusterMembers): ObservableClusterKind {
  if (members.selectionMembers) {
    return "selection";
  }
  if (members.gatedFeedbackMembers) {
    return "gated-feedback";
  }
  if (members.textDraftMembers) {
    return "text-draft";
  }
  return members.hasBoundedDialogGate ? "persistent-dialog" : "dialog";
}

function stateClusterMessage(
  kind: ObservableClusterKind,
  names: readonly string[],
  targets: ReadonlySet<string>,
): string {
  const quoted = names.map((name) => `\`${name}\``).join(", ");
  const targetList = [...targets].toSorted().join(", ");
  if (kind === "selection") {
    return `Replace the co-written selection mode (${quoted}) with one component-lifetime observable object; preserve mode-and-clear transitions with atomic \`assign\` calls, keep independent collection edits as leaf writes, snapshot command reads with \`peek\`, and subscribe with \`useValue\` only at header, control, and keyed-row leaves.`;
  }
  if (kind === "gated-feedback") {
    return `Replace the payload and timed feedback state (${quoted}) with one component-lifetime observable model; preserve the timer and command timing, batch the paired reset, read the payload command with \`peek\`, subscribe to the payload-gated content at its stable call site, and subscribe to feedback again only in its nested feedback leaf.`;
  }
  return dialogClusterMessage(kind, quoted, targetList);
}

function dialogClusterMessage(
  kind: ObservableClusterKind,
  quoted: string,
  targetList: string,
): string {
  if (kind === "text-draft") {
    return `Replace the co-written editable draft (${quoted}) with one component-lifetime observable object; preserve cursor-and-name transitions with atomic \`assign\` calls, keep controlled name edits as leaf writes, snapshot command reads with \`peek\`, and subscribe with \`useValue\` only at the rendered row or control leaves.`;
  }
  if (kind === "persistent-dialog") {
    return `Replace the persistent dialog state (${quoted}) with one component-lifetime observable model; atomically assign the payload and open flag, keep close transitions as leaf writes, and move the complete payload gate plus ${targetList} into one always-mounted stable leaf wrapper. Subscribe there with \`useValue\` so the existing payload gate and dialog mount behavior stay unchanged.`;
  }
  return `Replace the co-written React state cluster (${quoted}) with one component-lifetime observable dialog model; preserve paired payload/open transitions with atomic \`assign\` calls, keep independent close updates as leaf writes, and subscribe with \`useValue\` only inside ${targetList}.`;
}

interface ClusterAnalysisContext {
  readonly childContracts: ChildContractResolver | null;
  readonly knownComponents: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
  readonly stateFlow: StateFlowIndex;
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

interface ClusterMemberContext extends ClusterAnalysisContext {
  readonly mutations: readonly SetterMutation[];
}

function groupStatesByOwner(
  states: readonly StateCandidate[],
): ReadonlyMap<RuntimeFunctionLike, StateCandidate[]> {
  const byOwner = new Map<RuntimeFunctionLike, StateCandidate[]>();
  for (const state of states) {
    const ownerStates = byOwner.get(state.owner) ?? [];
    ownerStates.push(state);
    byOwner.set(state.owner, ownerStates);
  }
  return byOwner;
}

function coexecutingStateComponents(
  mutableStates: readonly StateCandidate[],
  calls: readonly SetterMutation[],
  stateFlow: StateFlowIndex,
): readonly StateCandidate[][] {
  const union = new DisjointSet(mutableStates.length);
  for (const pair of provenCoexecutingMutationPairs(calls, stateFlow)) {
    joinStateIndexes(union, mutableStates, pair);
  }
  const components = new Map<number, StateCandidate[]>();
  for (const [index, state] of mutableStates.entries()) {
    const root = union.rootOf(index);
    const members = components.get(root) ?? [];
    members.push(state);
    components.set(root, members);
  }
  return [...components.values()];
}

function joinStateIndexes(
  union: DisjointSet,
  mutableStates: readonly StateCandidate[],
  [left, right]: readonly [SetterMutation, SetterMutation],
): void {
  const leftIndex = mutableStates.indexOf(left.state);
  const rightIndex = mutableStates.indexOf(right.state);
  if (leftIndex !== -1 && rightIndex !== -1) {
    union.join(leftIndex, rightIndex);
  }
}

function provenCoexecutingMutationPairs(
  calls: readonly SetterMutation[],
  stateFlow: StateFlowIndex,
): readonly (readonly [SetterMutation, SetterMutation])[] {
  const pairs: (readonly [SetterMutation, SetterMutation])[] = [];
  for (const [leftIndex, left] of calls.entries()) {
    for (const right of calls.slice(leftIndex + 1)) {
      if (
        left.state !== right.state &&
        left.region === right.region &&
        mutationsAreProvenCoexecuting(left.call, right.call, { region: left.region, stateFlow })
      ) {
        pairs.push([left, right]);
      }
    }
  }
  return pairs;
}

function registerObservableCluster(
  members: readonly StateCandidate[],
  clusterContext: OwnerClusterContext,
  result: Map<StateCandidate, StateCluster>,
): void {
  const cluster = observableCluster(members, clusterContext);
  for (const member of cluster?.members ?? []) {
    if (cluster) {
      result.set(member, cluster);
    }
  }
}

function findObservableStateClusters(
  states: readonly StateCandidate[],
  context: ClusterAnalysisContext,
): ReadonlyMap<StateCandidate, StateCluster> {
  const result = new Map<StateCandidate, StateCluster>();
  for (const ownerEntry of groupStatesByOwner(states)) {
    registerOwnerClusters(ownerEntry, context, result);
  }
  return result;
}

function registerOwnerClusters(
  [owner, ownerStates]: readonly [RuntimeFunctionLike, readonly StateCandidate[]],
  context: ClusterAnalysisContext,
  result: Map<StateCandidate, StateCluster>,
): void {
  const scale = ownerClusterScale(owner, context.sourceFile);
  if (!scale) {
    return;
  }
  const mutableStates = ownerStates.filter((state) => state.setterName !== null);
  const calls = collectSetterMutations(owner, mutableStates);
  const clusterContext: OwnerClusterContext = { ...context, mutations: calls, owner, scale };
  for (const members of coexecutingStateComponents(mutableStates, calls, context.stateFlow)) {
    registerObservableCluster(members, clusterContext, result);
  }
}

interface OwnerClusterScale {
  readonly broadOwner: boolean;
  readonly hasLargeSourceOwner: boolean;
}

function ownerClusterScale(
  owner: RuntimeFunctionLike,
  sourceFile: ts.SourceFile,
): OwnerClusterScale | null {
  const ownerElements = jsxElementCount(owner);
  if (ownerElements < COMPACT_OWNER_JSX_ELEMENTS) {
    return null;
  }
  return {
    broadOwner: ownerElements >= BROAD_OWNER_JSX_ELEMENTS,
    hasLargeSourceOwner: ownerLineSpan(owner, sourceFile) >= LARGE_OWNER_LINE_SPAN,
  };
}

interface NormalizedClusterMembers extends ObservableClusterMembers {
  readonly dialogMembers: readonly StateCandidate[] | null;
}

function normalizeClusterMembers(
  members: readonly StateCandidate[],
  context: ClusterMemberContext,
  { broadOwner, hasLargeSourceOwner }: OwnerClusterScale,
): NormalizedClusterMembers {
  const dialogMembers =
    broadOwner && hasLargeSourceOwner
      ? (normalizeObservableDialogClusterMembers(members, context) ??
        normalizePersistentScalarDialogClusterMembers(members, context))
      : null;
  const gatedFeedbackMembers =
    broadOwner && !dialogMembers ? normalizeGatedFeedbackClusterMembers(members, context) : null;
  const textDraftMembers =
    broadOwner && hasLargeSourceOwner && !dialogMembers && !gatedFeedbackMembers
      ? normalizeObservableTextDraftClusterMembers(members, context)
      : null;
  const selectionMembers =
    hasLargeSourceOwner && !dialogMembers && !gatedFeedbackMembers && !textDraftMembers
      ? normalizeObservableSelectionClusterMembers(members, context)
      : null;
  return {
    dialogMembers,
    gatedFeedbackMembers,
    hasBoundedDialogGate:
      dialogMembers?.some((state) => stateHasBoundedDialogGate(state, dialogMembers, context)) ??
      false,
    selectionMembers,
    textDraftMembers,
  };
}

function ownerOnlyRenderReadRemains(
  clusterMembers: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
): boolean {
  return clusterMembers.some((member) => {
    const usage = usageByState.get(member);
    return usage !== undefined && usage.localRenderReads > 0 && usage.jsxTargets.size === 0;
  });
}

interface OwnerClusterContext extends ClusterMemberContext {
  readonly owner: RuntimeFunctionLike;
  readonly scale: OwnerClusterScale;
}

function observableCluster(
  members: readonly StateCandidate[],
  clusterContext: OwnerClusterContext,
): StateCluster | null {
  const { owner, scale, ...context } = clusterContext;
  const normalized = normalizeClusterMembers(members, context, scale);
  const clusterMembers =
    normalized.dialogMembers ??
    normalized.gatedFeedbackMembers ??
    normalized.textDraftMembers ??
    normalized.selectionMembers;
  if (
    !clusterMembers ||
    (normalized.dialogMembers &&
      !normalized.hasBoundedDialogGate &&
      ownerOnlyRenderReadRemains(clusterMembers, context.usageByState))
  ) {
    return null;
  }
  const sortedMembers = clusterMembers.toSorted(
    (left, right) => left.call.getStart() - right.call.getStart(),
  );
  const [primary] = sortedMembers;
  return primary
    ? observableClusterFor(sortedMembers, primary, { normalized, owner, ...context })
    : null;
}

interface ObservableClusterScope extends ClusterMemberContext {
  readonly normalized: NormalizedClusterMembers;
  readonly owner: RuntimeFunctionLike;
}

function observableClusterFor(
  sortedMembers: readonly StateCandidate[],
  primary: StateCandidate,
  { normalized, owner, sourceFile, usageByState }: ObservableClusterScope,
): StateCluster {
  const names = sortedMembers.map((state) => state.valueName);
  return {
    action: "use-observable",
    id: `state-cluster:${owner.getStart(sourceFile)}:${names.join(",")}`,
    members: sortedMembers,
    message: stateClusterMessage(
      observableClusterKind(normalized),
      names,
      transportTargetsOf(sortedMembers, usageByState),
    ),
    primary,
  };
}

function transportTargetsOf(
  members: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
): ReadonlySet<string> {
  return new Set(members.flatMap((state) => [...(usageByState.get(state)?.jsxTargets ?? [])]));
}

interface ClusterPairUsage {
  readonly firstUsage: StateUsage | undefined;
  readonly secondUsage: StateUsage | undefined;
}

function selectionModeUsageIsIsolated(
  mode: StateCandidate,
  selection: StateCandidate,
  { firstUsage: modeUsage, secondUsage: selectionUsage }: ClusterPairUsage,
): boolean {
  if (!modeUsage || !selectionUsage) {
    return false;
  }
  return (
    ![modeUsage, selectionUsage].some(
      (usage) => usage.shadowed || usage.escaped || usage.effectReads > 0 || usage.effectWrites > 0,
    ) &&
    !modeUsage.setterUsesPreviousValue &&
    !stateMayHoldCallable(mode) &&
    !stateMayHoldCallable(selection) &&
    modeUsage.setterReferences === modeUsage.setterCalls &&
    selectionUsage.setterReferences === selectionUsage.setterCalls &&
    renderReadsStayInJsxAttributes(mode, modeUsage) &&
    renderReadsStayInJsxAttributes(selection, selectionUsage)
  );
}

function selectionMutationsToggleAndReset(
  modeMutations: readonly SetterMutation[],
  selectionMutations: readonly SetterMutation[],
  resets: readonly SetterMutation[],
): boolean {
  const edits = selectionMutations.filter((mutation) => !callSetsEmptyArray(mutation));
  return (
    modeMutations.length >= MIN_REPEATED_SETTER_CALLS &&
    resets.length > 0 &&
    edits.length > 0 &&
    modeMutations.some((mutation) => callSetsLiteral(mutation, ts.SyntaxKind.TrueKeyword)) &&
    modeMutations.some((mutation) => callSetsLiteral(mutation, ts.SyntaxKind.FalseKeyword)) &&
    edits.every((mutation) => setterCallUsesPreviousValue(mutation.call))
  );
}

interface ClusterPair {
  readonly first: StateCandidate;
  readonly second: StateCandidate;
}

function distinctClusterPair(
  members: readonly StateCandidate[],
  isFirst: (state: StateCandidate) => boolean,
  isSecond: (state: StateCandidate) => boolean,
): ClusterPair | null {
  if (members.length !== PAIRED_CLUSTER_SIZE) {
    return null;
  }
  const first = members.find((state) => isFirst(state));
  const second = members.find((state) => isSecond(state));
  return first && second && first !== second ? { first, second } : null;
}

function normalizeObservableSelectionClusterMembers(
  members: readonly StateCandidate[],
  { mutations, stateFlow, usageByState }: ClusterMemberContext,
): readonly StateCandidate[] | null {
  const pair = distinctClusterPair(
    members,
    (state) => hasStateInitializer(state, ts.SyntaxKind.FalseKeyword),
    (state) => hasEmptyArrayStateInitializer(state),
  );
  if (!pair) {
    return null;
  }
  const { first: mode, second: selection } = pair;
  if (
    !selectionModeUsageIsIsolated(mode, selection, {
      firstUsage: usageByState.get(mode),
      secondUsage: usageByState.get(selection),
    })
  ) {
    return null;
  }
  const modeMutations = mutations.filter((mutation) => mutation.state === mode);
  const selectionMutations = mutations.filter((mutation) => mutation.state === selection);
  return selectionModeWritesPairWithResets(modeMutations, selectionMutations, stateFlow)
    ? [mode, selection]
    : null;
}

function selectionModeWritesPairWithResets(
  modeMutations: readonly SetterMutation[],
  selectionMutations: readonly SetterMutation[],
  stateFlow: StateFlowIndex,
): boolean {
  const resets = selectionMutations.filter((mutation) => callSetsEmptyArray(mutation));
  if (!selectionMutationsToggleAndReset(modeMutations, selectionMutations, resets)) {
    return false;
  }
  return modeMutations.every((modeMutation) =>
    resets.some((reset) => mutationsWriteTogether(modeMutation, reset, stateFlow)),
  );
}

function mutationsWriteTogether(
  left: SetterMutation,
  right: SetterMutation,
  stateFlow: StateFlowIndex,
): boolean {
  return (
    left.region === right.region &&
    (callsAreAdjacentDraftWrites(left.call, right.call) ||
      mutationsAreProvenCoexecuting(left.call, right.call, { region: left.region, stateFlow }))
  );
}

function hasEmptyArrayStateInitializer(state: StateCandidate): boolean {
  const [initializer] = state.call.arguments;
  if (!initializer) {
    return false;
  }
  const value = unwrapTransparentExpression(initializer);
  return ts.isArrayLiteralExpression(value) && value.elements.length === 0;
}

function callSetsEmptyArray(mutation: SetterMutation): boolean {
  const [argument] = mutation.call.arguments;
  if (!argument) {
    return false;
  }
  const value = unwrapTransparentExpression(argument);
  return ts.isArrayLiteralExpression(value) && value.elements.length === 0;
}

function renderReadsStayInJsxAttributes(state: StateCandidate, usage: StateUsage): boolean {
  return (
    usage.localRenderReads + usage.transportedOccurrences > 0 &&
    usage.directRenderNodes.every(
      (node) => findAncestorUntil(node, ts.isJsxAttribute, state.owner) !== null,
    )
  );
}

function textDraftUsageIsIsolated(
  cursor: StateCandidate,
  draft: StateCandidate,
  { firstUsage: cursorUsage, secondUsage: draftUsage }: ClusterPairUsage,
): boolean {
  if (!cursorUsage || !draftUsage) {
    return false;
  }
  return (
    ![cursorUsage, draftUsage].some(
      (usage) =>
        usage.shadowed ||
        usage.escaped ||
        usage.effectReads > 0 ||
        usage.effectWrites > 0 ||
        usage.setterUsesPreviousValue,
    ) &&
    !stateMayHoldCallable(cursor) &&
    !stateMayHoldCallable(draft) &&
    cursorUsage.localRenderReads + cursorUsage.transportedOccurrences > 0 &&
    draftUsage.localRenderReads + draftUsage.transportedOccurrences > 0 &&
    cursorUsage.setterReferences === cursorUsage.setterCalls &&
    setterReferencesAreCallsOrControlledValueWrites(draft)
  );
}

function normalizeObservableTextDraftClusterMembers(
  members: readonly StateCandidate[],
  { mutations, stateFlow, usageByState }: ClusterMemberContext,
): readonly StateCandidate[] | null {
  const pair = distinctClusterPair(
    members,
    (state) => hasStateInitializer(state, ts.SyntaxKind.NullKeyword),
    (state) => hasEmptyStringStateInitializer(state),
  );
  if (!pair) {
    return null;
  }
  const { first: cursor, second: draft } = pair;
  if (
    !textDraftUsageIsIsolated(cursor, draft, {
      firstUsage: usageByState.get(cursor),
      secondUsage: usageByState.get(draft),
    })
  ) {
    return null;
  }
  const cursorMutations = mutations.filter((mutation) => mutation.state === cursor);
  const draftMutations = mutations.filter((mutation) => mutation.state === draft);
  return textDraftMutationsPairCursorWithDraft(cursorMutations, draftMutations, {
    cursor,
    draft,
    stateFlow,
  })
    ? [cursor, draft]
    : null;
}

interface TextDraftPairScope {
  readonly cursor: StateCandidate;
  readonly draft: StateCandidate;
  readonly stateFlow: StateFlowIndex;
}

function textDraftMutationsPairCursorWithDraft(
  cursorMutations: readonly SetterMutation[],
  draftMutations: readonly SetterMutation[],
  { cursor, draft, stateFlow }: TextDraftPairScope,
): boolean {
  const cursorClears = cursorMutations.filter((mutation) =>
    callSetsLiteral(mutation, ts.SyntaxKind.NullKeyword),
  );
  const cursorOpens = cursorMutations.filter(
    (mutation) => !callSetsLiteral(mutation, ts.SyntaxKind.NullKeyword),
  );
  if (
    cursorMutations.length < MIN_REPEATED_SETTER_CALLS ||
    draftMutations.length === 0 ||
    cursorClears.length === 0 ||
    cursorOpens.length === 0
  ) {
    return false;
  }
  const coexecutes = (left: SetterMutation, right: SetterMutation): boolean =>
    mutationsWriteTogether(left, right, stateFlow);
  if (
    cursorOpens.some(
      (cursorMutation) =>
        !draftMutations.some((draftMutation) => coexecutes(cursorMutation, draftMutation)),
    ) ||
    cursorClears.some((mutation) => !mutationIsEventRooted(mutation, cursor)) ||
    cursorMutations.some((cursorMutation) =>
      draftMutations.some(
        (draftMutation) =>
          cursorMutation.region === draftMutation.region &&
          mutationsMayCoexecute(cursorMutation.call, draftMutation.call, {
            region: cursorMutation.region,
            stateFlow,
          }) &&
          !coexecutes(cursorMutation, draftMutation),
      ),
    )
  ) {
    return false;
  }
  return draftMutations.every(
    (draftMutation) =>
      cursorMutations.some((cursorMutation) => coexecutes(draftMutation, cursorMutation)) ||
      controlledValueSetterCall(draftMutation.call, draft) ||
      mutationIsEventRooted(draftMutation, draft),
  );
}

function callsAreAdjacentDraftWrites(left: ts.CallExpression, right: ts.CallExpression): boolean {
  const leftStatement = left.parent;
  const rightStatement = right.parent;
  if (
    !ts.isExpressionStatement(leftStatement) ||
    leftStatement.expression !== left ||
    !ts.isExpressionStatement(rightStatement) ||
    rightStatement.expression !== right ||
    leftStatement.parent !== rightStatement.parent
  ) {
    return false;
  }
  const { parent } = leftStatement;
  const statements =
    ts.isBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)
      ? parent.statements
      : null;
  if (statements === null) {
    return false;
  }
  return Math.abs(statements.indexOf(leftStatement) - statements.indexOf(rightStatement)) === 1;
}

function hasEmptyStringStateInitializer(state: StateCandidate): boolean {
  const [initializer] = state.call.arguments;
  if (!initializer) {
    return false;
  }
  const value = unwrapTransparentExpression(initializer);
  return ts.isStringLiteral(value) && value.text === "";
}

function setterReferencesAreCallsOrControlledValueWrites(state: StateCandidate): boolean {
  if (!state.setterName) {
    return false;
  }
  let controlledWrites = 0;
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.setterName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const classification = classifyControlledSetterReference(node, state);
    if (classification === "unsafe") {
      safe = false;
      return;
    }
    if (classification === "controlled-write") {
      controlledWrites += 1;
    }
  });
  return safe && controlledWrites > 0;
}

type ControlledSetterReference = "controlled-write" | "ignored" | "unsafe";

function classifyControlledSetterReference(
  node: ts.Identifier,
  state: StateCandidate,
): ControlledSetterReference {
  const attribute = controlledValueWriteAttribute(node, state);
  if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
    return attribute ? "controlled-write" : "ignored";
  }
  if (!attribute || !isDirectJsxAttributeExpression(attribute, node)) {
    return "unsafe";
  }
  return "controlled-write";
}

function controlledValueWriteAttribute(
  node: ts.Identifier,
  state: StateCandidate,
): ts.JsxAttribute | null {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
  if (!attribute || !isControlledInteractionProp(attribute.name.getText())) {
    return null;
  }
  const opening = jsxOpeningForAttribute(attribute);
  const hasValue = opening?.attributes.properties.some((property) => {
    if (
      !ts.isJsxAttribute(property) ||
      property.name.getText() !== "value" ||
      !property.initializer ||
      !ts.isJsxExpression(property.initializer) ||
      !property.initializer.expression
    ) {
      return false;
    }
    const value = unwrapTransparentExpression(property.initializer.expression);
    return ts.isIdentifier(value) && value.text === state.valueName;
  });
  return hasValue ? attribute : null;
}

function controlledValueSetterCall(call: ts.CallExpression, state: StateCandidate): boolean {
  return (
    ts.isIdentifier(call.expression) &&
    controlledValueWriteAttribute(call.expression, state) !== null
  );
}

function mutationIsEventRooted(mutation: SetterMutation, state: StateCandidate): boolean {
  const { region } = mutation;
  return (
    region !== state.owner &&
    (ts.isArrowFunction(region) ||
      ts.isFunctionDeclaration(region) ||
      ts.isFunctionExpression(region)) &&
    callbackIsEventRooted(region, state.owner, "", new Set())
  );
}

interface StateCompanionWrites {
  readonly all: ReadonlySet<StateCandidate>;
  readonly nonClosing: ReadonlySet<StateCandidate>;
}

function groupSettableStatesByOwner(
  states: readonly StateCandidate[],
): ReadonlyMap<RuntimeFunctionLike, StateCandidate[]> {
  const byOwner = new Map<RuntimeFunctionLike, StateCandidate[]>();
  for (const state of states) {
    if (!state.setterName) {
      continue;
    }
    const ownerStates = byOwner.get(state.owner) ?? [];
    ownerStates.push(state);
    byOwner.set(state.owner, ownerStates);
  }
  return byOwner;
}

function recordCompanionPair(
  [left, right]: readonly [SetterMutation, SetterMutation],
  all: Set<StateCandidate>,
  nonClosing: Set<StateCandidate>,
): void {
  all.add(left.state);
  all.add(right.state);
  if (!mutationIsProvenCloseDuringCompanion(left, right)) {
    nonClosing.add(left.state);
  }
  if (!mutationIsProvenCloseDuringCompanion(right, left)) {
    nonClosing.add(right.state);
  }
}

function findStateCompanionWrites(
  states: readonly StateCandidate[],
  stateFlow: StateFlowIndex,
): StateCompanionWrites {
  const all = new Set<StateCandidate>();
  const nonClosing = new Set<StateCandidate>();
  for (const [owner, ownerStates] of groupSettableStatesByOwner(states)) {
    const mutations = collectSetterMutations(owner, ownerStates);
    for (const pair of coexecutingMutationPairs(mutations, stateFlow)) {
      recordCompanionPair(pair, all, nonClosing);
    }
  }
  return { all, nonClosing };
}

function collectSetterMutations(
  owner: RuntimeFunctionLike,
  ownerStates: readonly StateCandidate[],
): readonly SetterMutation[] {
  const stateBySetter = new Map(
    ownerStates.flatMap((state) => (state.setterName ? [[state.setterName, state] as const] : [])),
  );
  const mutations: SetterMutation[] = [];
  visit(owner.body, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
      return;
    }
    const state = stateBySetter.get(node.expression.text);
    if (state) {
      mutations.push({ call: node, region: nearestMutationFunction(node, owner), state });
    }
  });
  return mutations;
}

function coexecutingMutationPairs(
  mutations: readonly SetterMutation[],
  stateFlow: StateFlowIndex,
): readonly (readonly [SetterMutation, SetterMutation])[] {
  const pairs: (readonly [SetterMutation, SetterMutation])[] = [];
  for (const [leftIndex, left] of mutations.entries()) {
    for (const right of mutations.slice(leftIndex + 1)) {
      if (
        left.state !== right.state &&
        left.region === right.region &&
        mutationsMayCoexecute(left.call, right.call, { region: left.region, stateFlow })
      ) {
        pairs.push([left, right]);
      }
    }
  }
  return pairs;
}

function mutationIsProvenCloseDuringCompanion(
  mutation: SetterMutation,
  companion: SetterMutation,
): boolean {
  if (callSetsLiteral(mutation, ts.SyntaxKind.FalseKeyword)) {
    return true;
  }
  const [argument] = mutation.call.arguments;
  if (
    mutation.call.arguments.length !== 1 ||
    !argument ||
    !ts.isIdentifier(argument) ||
    !isRuntimeFunctionLike(mutation.region) ||
    bindingDeclarationCount(mutation.region, argument.text) !== 1 ||
    !parameterIsBooleanVisibilityTransition(mutation.region, mutation.state, argument.text) ||
    runtimeParameterIsReassigned(mutation.region, argument.text)
  ) {
    return false;
  }
  for (
    let current: ts.Node | undefined = companion.call;
    current && current !== mutation.region;
    current = current.parent
  ) {
    if (
      ts.isIfStatement(current) &&
      nodeWithin(companion.call, current.thenStatement) &&
      isNegatedIdentifier(current.expression, argument.text)
    ) {
      return true;
    }
  }
  return false;
}

function parameterIsBooleanVisibilityTransition(
  owner: RuntimeFunctionLike,
  state: StateCandidate,
  name: string,
): boolean {
  const parameter = owner.parameters.find(
    (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
  );
  if (!parameter) {
    return false;
  }
  if (parameter.type?.kind === ts.SyntaxKind.BooleanKeyword) {
    return true;
  }
  const attribute = findAncestorUntil(owner, ts.isJsxAttribute, state.owner);
  if (
    !attribute?.initializer ||
    !ts.isJsxExpression(attribute.initializer) ||
    attribute.initializer.expression !== owner
  ) {
    return false;
  }
  const opening = attribute.parent.parent;
  return (
    (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) &&
    isVisibilityTransitionAttribute(opening, attribute.name.getText(), state.valueName)
  );
}

function runtimeParameterIsReassigned(owner: RuntimeFunctionLike, name: string): boolean {
  if (!owner.body) {
    return true;
  }
  let reassigned = false;
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (!ts.isBinaryExpression(node)) {
      return;
    }
    const left = unwrapTransparentExpression(node.left);
    if (
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(left) &&
      left.text === name
    ) {
      reassigned = true;
    }
  });
  return reassigned;
}

function isNegatedIdentifier(expression: ts.Expression, name: string): boolean {
  const value = unwrapTransparentExpression(expression);
  if (!ts.isPrefixUnaryExpression(value) || value.operator !== ts.SyntaxKind.ExclamationToken) {
    return false;
  }
  const operand = unwrapTransparentExpression(value.operand);
  return ts.isIdentifier(operand) && operand.text === name;
}

interface BranchUnmountScanContext {
  readonly safeCommandStates: ReadonlySet<StateCandidate>;
  readonly stateFlow: StateFlowIndex;
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

function findBranchUnmountMoves(
  states: readonly StateCandidate[],
  { safeCommandStates, stateFlow, usageByState }: BranchUnmountScanContext,
): ReadonlyMap<StateCandidate, BranchUnmountMove> {
  const result = new Map<StateCandidate, BranchUnmountMove>();
  for (const state of states) {
    const usage = usageByState.get(state);
    if (!usage || !stateIsBranchLocalFlag(state, usage, safeCommandStates)) {
      continue;
    }
    const move = branchUnmountMoveFor(state, usage, { stateFlow, states, usageByState });
    if (move) {
      result.set(state, move);
    }
  }
  return result;
}

function stateIsBranchLocalFlag(
  state: StateCandidate,
  usage: StateUsage,
  safeCommandStates: ReadonlySet<StateCandidate>,
): boolean {
  return (
    state.setterName !== null &&
    safeCommandStates.has(state) &&
    hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) &&
    usage.localRenderReads === 0 &&
    stateHasNoEffectOrDeferredUse(usage) &&
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1 &&
    !usage.repeatedTransport &&
    usage.setterReferences === usage.setterCalls &&
    usage.setterCallNodes.length >= MIN_REPEATED_SETTER_CALLS &&
    !usage.shadowed &&
    !usage.escaped
  );
}

interface BranchUnmountMoveScope {
  readonly stateFlow: StateFlowIndex;
  readonly states: readonly StateCandidate[];
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

function branchUnmountMoveFor(
  state: StateCandidate,
  usage: StateUsage,
  { stateFlow, states, usageByState }: BranchUnmountMoveScope,
): BranchUnmountMove | null {
  const callSite = directBranchReturnCallSite(usage, state.owner);
  const [target] = [...usage.valueTargets];
  const gate = callSite
    ? exactDiscriminatedBranchGate(callSite.opening, state.owner, states)
    : null;
  const controllerUsage = gate ? usageByState.get(gate.controller) : undefined;
  if (
    !callSite ||
    !target ||
    !gate ||
    !gate.controller.setterName ||
    !controllerUsage ||
    controllerUsage.shadowed ||
    controllerUsage.escaped
  ) {
    return null;
  }
  const writesSplitAcrossBranch = branchWritesAreUnmountScoped(state, usage, {
    callSite,
    controllerUsage,
    gate,
    stateFlow,
  });
  return writesSplitAcrossBranch ? { target } : null;
}

interface BranchUnmountWriteScope {
  readonly callSite: DirectReturnCallSite;
  readonly controllerUsage: StateUsage;
  readonly gate: DiscriminatedBranchGate;
  readonly stateFlow: StateFlowIndex;
}

function branchWritesAreUnmountScoped(
  state: StateCandidate,
  usage: StateUsage,
  { callSite, controllerUsage, gate, stateFlow }: BranchUnmountWriteScope,
): boolean {
  const subtree = jsxSubtreeForOpening(callSite.opening);
  const branchCalls = usage.setterCallNodes.filter((call) => nodeWithin(call, subtree));
  const outsideCalls = usage.setterCallNodes.filter((call) => !nodeWithin(call, subtree));
  return (
    branchCalls.length > 0 &&
    outsideCalls.length > 0 &&
    branchCalls.every((call) => isDirectBranchInteractionWrite(call, callSite.opening, state)) &&
    outsideCalls.every((call) =>
      isBranchUnmountReset(call, state, { controllerUsage, gate, stateFlow }),
    )
  );
}

interface DiscriminatedBranchGate {
  controller: StateCandidate;
  property: string;
  value: string;
}

function exactDiscriminatedBranchGate(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  owner: RuntimeFunctionLike,
  states: readonly StateCandidate[],
): DiscriminatedBranchGate | null {
  const conditional = nullFallbackGateFor(opening, owner);
  const condition = conditional ? unwrapTransparentExpression(conditional.condition) : null;
  if (
    !condition ||
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return null;
  }
  const left = unwrapTransparentExpression(condition.left);
  const right = unwrapTransparentExpression(condition.right);
  if (
    !ts.isPropertyAccessExpression(left) ||
    !ts.isIdentifier(left.expression) ||
    !ts.isStringLiteral(right)
  ) {
    return null;
  }
  const controller = uniqueOwnedState(states, owner, left.expression.text);
  return controller ? { controller, property: left.name.text, value: right.text } : null;
}

function nullFallbackGateFor(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  owner: RuntimeFunctionLike,
): ts.ConditionalExpression | null {
  for (
    let current: ts.Node | undefined = opening.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (
      ts.isConditionalExpression(current) &&
      nodeWithin(opening, current.whenTrue) &&
      unwrapTransparentExpression(current.whenFalse).kind === ts.SyntaxKind.NullKeyword
    ) {
      return current;
    }
  }
  return null;
}

function uniqueOwnedState(
  states: readonly StateCandidate[],
  owner: RuntimeFunctionLike,
  valueName: string,
): StateCandidate | null {
  const matches = states.filter((state) => state.owner === owner && state.valueName === valueName);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function isDirectBranchInteractionWrite(
  call: ts.CallExpression,
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  state: StateCandidate,
): boolean {
  const attribute = findAncestorUntil(call, ts.isJsxAttribute, state.owner);
  const callback = nearestMutationFunction(call, state.owner);
  if (attribute === null || state.setterName === null) {
    return false;
  }
  return (
    /^on[A-Z]/u.test(attribute.name.getText()) &&
    attribute.parent.parent === opening &&
    callback !== state.owner &&
    mutationRegionOnlyCallsStateSetters(callback, new Set([state.setterName]))
  );
}

interface BranchUnmountResetContext {
  readonly controllerUsage: StateUsage;
  readonly gate: DiscriminatedBranchGate;
  readonly stateFlow: StateFlowIndex;
}

function isBranchUnmountReset(
  reset: ts.CallExpression,
  state: StateCandidate,
  { controllerUsage, gate, stateFlow }: BranchUnmountResetContext,
): boolean {
  if (reset.arguments.length !== 1 || reset.arguments[0]?.kind !== ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  const region = nearestMutationFunction(reset, state.owner);
  if (
    region === state.owner ||
    (!ts.isArrowFunction(region) &&
      !ts.isFunctionDeclaration(region) &&
      !ts.isFunctionExpression(region)) ||
    !callbackIsEventRooted(region, state.owner, "", new Set())
  ) {
    return false;
  }
  const closeCalls = controllerUsage.setterCallNodes.filter(
    (call) =>
      callsAreAdjacentStatements(reset, call) &&
      callSetsDifferentDiscriminant(call, gate.property, gate.value),
  );
  const close = closeCalls.length === 1 ? closeCalls[0] : null;
  if (!close) {
    return false;
  }
  return !controllerUsage.setterCallNodes.some((call) => {
    if (
      call === close ||
      nearestMutationFunction(call, state.owner) !== region ||
      !mutationsMayCoexecute(close, call, { region, stateFlow })
    ) {
      return false;
    }
    const value = callDiscriminantValue(call, gate.property);
    return value === null || value === gate.value;
  });
}

function callsAreAdjacentStatements(left: ts.CallExpression, right: ts.CallExpression): boolean {
  const leftStatement = left.parent;
  const rightStatement = right.parent;
  if (
    !ts.isExpressionStatement(leftStatement) ||
    leftStatement.expression !== left ||
    !ts.isExpressionStatement(rightStatement) ||
    rightStatement.expression !== right ||
    leftStatement.parent !== rightStatement.parent ||
    !ts.isBlock(leftStatement.parent)
  ) {
    return false;
  }
  const { statements } = leftStatement.parent;
  return Math.abs(statements.indexOf(leftStatement) - statements.indexOf(rightStatement)) === 1;
}

function callSetsDifferentDiscriminant(
  call: ts.CallExpression,
  property: string,
  activeValue: string,
): boolean {
  const value = callDiscriminantValue(call, property);
  return value !== null && value !== activeValue;
}

function callDiscriminantValue(call: ts.CallExpression, property: string): string | null {
  if (call.arguments.length !== 1 || !call.arguments[0]) {
    return null;
  }
  const value = unwrapTransparentExpression(call.arguments[0]);
  if (
    !ts.isObjectLiteralExpression(value) ||
    value.properties.some(
      (candidate) =>
        (ts.isShorthandPropertyAssignment(candidate) && candidate.name.text === property) ||
        (!ts.isShorthandPropertyAssignment(candidate) &&
          (!ts.isPropertyAssignment(candidate) ||
            (!ts.isIdentifier(candidate.name) && !ts.isStringLiteral(candidate.name)))),
    )
  ) {
    return null;
  }
  const matches = value.properties.filter((candidate) => {
    if (!ts.isPropertyAssignment(candidate)) {
      return false;
    }
    const name =
      ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)
        ? candidate.name.text
        : null;
    return name === property;
  });
  const assignment =
    matches.length === 1 && ts.isPropertyAssignment(matches[0]!) ? matches[0]! : null;
  const discriminator = assignment ? unwrapTransparentExpression(assignment.initializer) : null;
  return discriminator && ts.isStringLiteral(discriminator) ? discriminator.text : null;
}

interface IndependentStateWrites {
  readonly directEventWrites: ReadonlySet<StateCandidate>;
  readonly visibilitySetterTransports: ReadonlySet<StateCandidate>;
}

function findIndependentStateWrites(states: readonly StateCandidate[]): IndependentStateWrites {
  const directEventWrites = new Set<StateCandidate>();
  const visibilitySetterTransports = new Set<StateCandidate>();
  for (const [owner, ownerStates] of groupSettableStatesByOwner(states)) {
    const bySetter = new Map(
      ownerStates.flatMap((state) =>
        state.setterName ? [[state.setterName, state] as const] : [],
      ),
    );
    const returned = owner.body ? uniqueReturnedExpression(owner) : null;
    if (!returned) {
      continue;
    }
    visitSkippingNestedRuntimeFunctions(returned, (node) => {
      if (!ts.isJsxAttribute(node)) {
        return;
      }
      const transported = visibilitySetterTransport(node, bySetter);
      if (transported) {
        visibilitySetterTransports.add(transported);
        return;
      }
      const written = directEventWriteTarget(node, bySetter);
      if (written) {
        directEventWrites.add(written);
      }
    });
  }
  return { directEventWrites, visibilitySetterTransports };
}

function jsxAttributeExpression(attribute: ts.JsxAttribute): ts.Expression | null {
  if (!attribute.initializer || !ts.isJsxExpression(attribute.initializer)) {
    return null;
  }
  return attribute.initializer.expression ?? null;
}

function visibilitySetterTransport(
  attribute: ts.JsxAttribute,
  bySetter: ReadonlyMap<string, StateCandidate>,
): StateCandidate | null {
  const expression = jsxAttributeExpression(attribute);
  if (!expression || !ts.isIdentifier(expression)) {
    return null;
  }
  const state = bySetter.get(expression.text);
  const opening = attribute.parent.parent;
  if (
    !state ||
    !hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) ||
    (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) ||
    !isVisibilityTransitionAttribute(opening, attribute.name.getText(), state.valueName)
  ) {
    return null;
  }
  return state;
}

function directEventWriteTarget(
  attribute: ts.JsxAttribute,
  bySetter: ReadonlyMap<string, StateCandidate>,
): StateCandidate | null {
  const expression = jsxAttributeExpression(attribute);
  const propName = attribute.name.getText();
  if (
    !expression ||
    ts.isIdentifier(expression) ||
    !/^on[A-Z]/u.test(propName) ||
    (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression))
  ) {
    return null;
  }
  const call = soleStatementExpression(expression.body);
  if (!call || !isSoleLiteralSetterCall(call, isControlledInteractionProp(propName))) {
    return null;
  }
  return ts.isCallExpression(call) && ts.isIdentifier(call.expression)
    ? (bySetter.get(call.expression.text) ?? null)
    : null;
}

function isSoleLiteralSetterCall(call: ts.Expression, controlledInteraction: boolean): boolean {
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.arguments.length !== 1
  ) {
    return false;
  }
  return (
    isDirectPrimitiveExpression(call.arguments[0]!) ||
    (controlledInteraction && !call.arguments.some((argument) => containsCallExpression(argument)))
  );
}

interface SubtreeCandidate {
  readonly state: StateCandidate;
  readonly subtree: StateSubtree;
}

function groupCandidatesBySubtree(
  subtreeByState: ReadonlyMap<StateCandidate, StateSubtree>,
  statesWithCompanionWrites: ReadonlySet<StateCandidate>,
): ReadonlyMap<JsxSubtreeNode, SubtreeCandidate[]> {
  const bySubtree = new Map<JsxSubtreeNode, SubtreeCandidate[]>();
  for (const [state, subtree] of subtreeByState) {
    if (statesWithCompanionWrites.has(state)) {
      continue;
    }
    const members = bySubtree.get(subtree.node) ?? [];
    members.push({ state, subtree });
    bySubtree.set(subtree.node, members);
  }
  return bySubtree;
}

function findStateSubtreeClusters(
  subtreeByState: ReadonlyMap<StateCandidate, StateSubtree>,
  statesWithCompanionWrites: ReadonlySet<StateCandidate>,
): ReadonlyMap<StateCandidate, StateCluster> {
  const bySubtree = groupCandidatesBySubtree(subtreeByState, statesWithCompanionWrites);
  const result = new Map<StateCandidate, StateCluster>();
  for (const candidates of bySubtree.values()) {
    if (candidates.length < PAIRED_CLUSTER_SIZE) {
      continue;
    }
    const cluster = subtreeCluster(candidates);
    for (const member of cluster.members) {
      result.set(member, cluster);
    }
  }
  return result;
}

function subtreeCluster(candidates: readonly SubtreeCandidate[]): StateCluster {
  const first = candidates[0]!;
  const members = candidates.map((candidate) => candidate.state);
  const names = members.map((member) => member.valueName);
  const repeated = candidates.some((candidate) => candidate.subtree.repeated);
  const needsObservable =
    repeated ||
    candidates.some(
      (candidate) => candidate.subtree.unstable || candidate.subtree.kind !== "direct",
    );
  const ownership = subtreeClusterOwnership(repeated, needsObservable);
  return {
    action: needsObservable ? "use-observable" : "move-state-down",
    id: `state-cluster:subtree:${first.state.owner.getStart()}:${first.subtree.node.getStart()}:${names.join(",")}`,
    members,
    message: `Extract the ${first.subtree.label} subtree at line ${first.subtree.line}; ${ownership} for the confined state cluster (${names.map((name) => `\`${name}\``).join(", ")}).`,
    primary: members[0]!,
  };
}

interface SetterMutation {
  call: ts.CallExpression;
  region: RuntimeFunctionLike;
  state: StateCandidate;
}

interface DialogPayloadCutContext {
  readonly childContracts: ChildContractResolver | null;
  readonly imports: HookImports;
  readonly knownComponents: ReadonlySet<string>;
}

function stateIsNullablePayload(state: StateCandidate, usage: StateUsage): boolean {
  return (
    state.setterName !== null &&
    !isCustomHookOwner(state.owner) &&
    hasStateInitializer(state, ts.SyntaxKind.NullKeyword) &&
    !stateMayHoldCallable(state) &&
    usage.localRenderReads > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.transportedOccurrences === 0 &&
    usage.setterCallNodes.length >= MIN_REPEATED_SETTER_CALLS &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped &&
    payloadWritesAlternateNullAndValue(usage)
  );
}

function payloadWritesAlternateNullAndValue(usage: StateUsage): boolean {
  return (
    usage.setterCallNodes.some((call) => setterCallSetsLiteral(call, ts.SyntaxKind.NullKeyword)) &&
    usage.setterCallNodes.some((call) => !setterCallSetsLiteral(call, ts.SyntaxKind.NullKeyword)) &&
    usage.setterCallNodes.every((call) => {
      const [argument] = call.arguments;
      return (
        call.arguments.length === 1 &&
        argument !== undefined &&
        !ts.isArrowFunction(argument) &&
        !ts.isFunctionExpression(argument)
      );
    })
  );
}

interface DialogBoundaryScope {
  readonly conditionalBoundary: NullablePayloadBoundary | null;
  readonly usage: StateUsage;
}

function dialogSubtreeIsBounded(
  dialog: JsxSubtreeNode,
  state: StateCandidate,
  { conditionalBoundary, usage }: DialogBoundaryScope,
): boolean {
  const ownerJsx = jsxElementCount(state.owner);
  const dialogJsx = jsxElementCountIn(dialog);
  return (
    !ts.isJsxFragment(dialog) &&
    ownerJsx >= BROAD_OWNER_JSX_ELEMENTS &&
    !nearestRepeatedRenderCall(dialog, state.owner) &&
    (conditionalBoundary !== null || !hasUnstableSubtreeLifetime(dialog, state.owner)) &&
    usage.directRenderNodes.every((read) =>
      nodeWithin(read, conditionalBoundary?.gate ?? dialog),
    ) &&
    dialogJsx <= BROAD_OWNER_JSX_ELEMENTS &&
    dialogJsx / ownerJsx <= MAX_LEAF_SUBTREE_RATIO
  );
}

interface DialogMountScope {
  readonly conditionalBoundary: NullablePayloadBoundary | null;
  readonly knownComponents: ReadonlySet<string>;
}

function dialogMountIsProven(
  dialog: JsxSubtreeNode,
  state: StateCandidate,
  { conditionalBoundary, knownComponents }: DialogMountScope,
): boolean {
  const returned = uniqueReturnedExpression(state.owner);
  const opening = ts.isJsxElement(dialog) ? dialog.openingElement : dialog;
  if (returned === null || ts.isJsxFragment(opening)) {
    return false;
  }
  const target = opening.tagName.getText();
  return (
    nodeWithin(conditionalBoundary?.gate ?? dialog, returned) &&
    (!isCustomJsxTarget(target) || knownComponents.has(target)) &&
    (conditionalBoundary !== null || openingBindsNullablePayloadOpen(opening, state.valueName))
  );
}

function openingBindsNullablePayloadOpen(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  valueName: string,
): boolean {
  return opening.attributes.properties.some(
    (attribute) =>
      ts.isJsxAttribute(attribute) &&
      attribute.name.getText() === "open" &&
      attribute.initializer !== undefined &&
      ts.isJsxExpression(attribute.initializer) &&
      attribute.initializer.expression !== undefined &&
      isNullablePayloadOpenExpression(attribute.initializer.expression, valueName),
  );
}

function payloadWritesAreEventRooted(
  state: StateCandidate,
  usage: StateUsage,
  { childContracts, imports }: Omit<DialogPayloadCutContext, "knownComponents">,
): boolean {
  const provenEventRoots = childContracts
    ? new Set(sourceProvenDirectEventCallbacks(state.owner, imports, childContracts))
    : new Set<RuntimeFunctionLike>();
  const eventScope: DeferredEventScope = { childContracts, eventRoots: provenEventRoots };
  return (
    stateReadsOutsideRenderAreEventRooted(state, usage, eventScope) &&
    usage.setterCallNodes.every(
      (call) =>
        setterCallSetsLiteral(call, ts.SyntaxKind.NullKeyword) ||
        nodeIsDirectDeferredEvent(call, state, eventScope),
    )
  );
}

function nullableDialogPayloadCut(
  state: StateCandidate,
  usage: StateUsage,
  { childContracts, imports, knownComponents }: DialogPayloadCutContext,
): DialogPayloadCut | null {
  if (!stateIsNullablePayload(state, usage)) {
    return null;
  }
  const conditionalBoundary = conditionalNullablePayloadBoundary(state, usage, knownComponents);
  const dialog =
    conditionalBoundary?.dialog ?? lowestCommonJsxSubtree(usage.directRenderNodes, state.owner);
  if (
    !dialog ||
    !dialogSubtreeIsBounded(dialog, state, { conditionalBoundary, usage }) ||
    !dialogMountIsProven(dialog, state, { conditionalBoundary, knownComponents })
  ) {
    return null;
  }
  if (!payloadWritesAreEventRooted(state, usage, { childContracts, imports })) {
    return null;
  }
  return {
    conditional: conditionalBoundary !== null,
    consumerLabel: jsxSubtreeLabel(dialog),
    consumerLine:
      dialog
        .getSourceFile()
        .getLineAndCharacterOfPosition((conditionalBoundary?.gate ?? dialog).getStart()).line + 1,
  };
}

function conditionalNullablePayloadBoundary(
  state: StateCandidate,
  usage: StateUsage,
  knownComponents: ReadonlySet<string>,
): NullablePayloadBoundary | null {
  if (usage.directRenderNodes.length < MIN_DIRECT_RENDER_READS) {
    return null;
  }

  for (const read of usage.directRenderNodes) {
    const boundary = payloadGateBoundaryForRead(read, state, usage);
    if (
      boundary &&
      dialogTargetIsKnownAndSafe(boundary.dialog, knownComponents, { state, usage })
    ) {
      return boundary;
    }
  }
  return null;
}

interface NullablePayloadBoundary {
  readonly dialog: ts.JsxElement | ts.JsxSelfClosingElement;
  readonly gate: ts.JsxExpression;
}

function payloadGateBoundaryForRead(
  read: ts.Node,
  state: StateCandidate,
  usage: StateUsage,
): NullablePayloadBoundary | null {
  const gate = findAncestorUntil(read, ts.isJsxExpression, state.owner);
  const expression = gate?.expression && unwrapTransparentExpression(gate.expression);
  const dialog = expression ? directDialogPayloadGateBranch(expression, state.valueName) : null;
  if (
    !gate ||
    !expression ||
    !dialog ||
    (!ts.isJsxElement(dialog) && !ts.isJsxSelfClosingElement(dialog)) ||
    !nodeWithin(read, dialogGateCondition(expression)) ||
    nearestRepeatedRenderCall(gate, state.owner) ||
    !usage.directRenderNodes.every((node) => nodeWithin(node, gate))
  ) {
    return null;
  }
  return { dialog, gate };
}

interface StateRenderScope {
  readonly state: StateCandidate;
  readonly usage: StateUsage;
}

function dialogTargetIsKnownAndSafe(
  dialog: ts.JsxElement | ts.JsxSelfClosingElement,
  knownComponents: ReadonlySet<string>,
  { state, usage }: StateRenderScope,
): boolean {
  const opening = ts.isJsxElement(dialog) ? dialog.openingElement : dialog;
  const target = opening.tagName.getText();
  if (isCustomJsxTarget(target) && !knownComponents.has(target)) {
    return false;
  }
  return usage.directRenderNodes.every(
    (node) => !nodeWithin(node, dialog) || isSafeJsxProjectionReference(node, state.owner),
  );
}

function dialogGateCondition(expression: ts.Expression): ts.Expression {
  const value = unwrapTransparentExpression(expression);
  if (ts.isConditionalExpression(value)) {
    return value.condition;
  }
  return ts.isBinaryExpression(value) ? value.left : value;
}

function isNullablePayloadOpenExpression(expression: ts.Expression, stateName: string): boolean {
  const value = unwrapTransparentExpression(expression);
  if (isDirectTruthyStateCondition(value, stateName)) {
    return true;
  }
  if (
    !ts.isBinaryExpression(value) ||
    (value.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsToken &&
      value.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken)
  ) {
    return false;
  }
  const left = unwrapTransparentExpression(value.left);
  const right = unwrapTransparentExpression(value.right);
  return (
    (ts.isIdentifier(left) &&
      left.text === stateName &&
      right.kind === ts.SyntaxKind.NullKeyword) ||
    (left.kind === ts.SyntaxKind.NullKeyword && ts.isIdentifier(right) && right.text === stateName)
  );
}

function setterCallSetsLiteral(call: ts.CallExpression, kind: ts.SyntaxKind): boolean {
  return call.arguments.length === 1 && call.arguments[0]?.kind === kind;
}

interface DeferredEventScope {
  readonly childContracts: ChildContractResolver | null;
  readonly eventRoots: ReadonlySet<RuntimeFunctionLike>;
}

interface DeferredEventResolution extends DeferredEventScope {
  readonly seen: ReadonlySet<string>;
}

function stateReadsOutsideRenderAreEventRooted(
  state: StateCandidate,
  usage: StateUsage,
  scope: DeferredEventScope,
): boolean {
  const renderReads = new Set(usage.directRenderNodes);
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      renderReads.has(node)
    ) {
      return;
    }
    safe = nodeIsDirectDeferredEvent(node, state, scope);
  });
  return safe;
}

function nodeIsDirectDeferredEvent(
  node: ts.Node,
  state: StateCandidate,
  scope: DeferredEventScope,
): boolean {
  const callback = nearestNestedFunction(node, state.owner);
  return (
    callback !== null &&
    callbackResolvesToDeferredEvent(callback, state.owner, { ...scope, seen: new Set() })
  );
}

function callbackResolvesToDeferredEvent(
  callback: RuntimeFunctionLike,
  owner: RuntimeFunctionLike,
  resolution: DeferredEventResolution,
): boolean {
  const { childContracts, eventRoots, seen } = resolution;
  if (
    !ts.isArrowFunction(callback) &&
    !ts.isFunctionDeclaration(callback) &&
    !ts.isFunctionExpression(callback)
  ) {
    return false;
  }
  if (eventRoots.has(callback) || callbackHasDirectJsxEventRoot(callback, owner, childContracts)) {
    return true;
  }
  const name = localCallbackBindingName(callback);
  if (!name || seen.has(name) || bindingDeclarationCount(owner, name) !== 1) {
    return false;
  }

  const nextSeen = new Set(seen).add(name);
  return everyValueReferenceSatisfies(owner, name, (node) => {
    if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) {
      return false;
    }
    const caller = nearestNestedFunction(node, owner);
    return (
      caller !== null &&
      caller !== callback &&
      callbackResolvesToDeferredEvent(caller, owner, { ...resolution, seen: nextSeen })
    );
  });
}

function everyValueReferenceSatisfies(
  owner: RuntimeFunctionLike,
  name: string,
  predicate: (node: ts.Identifier) => boolean,
): boolean {
  let referenced = false;
  for (const node of identifiersNamed(owner.body, name)) {
    if (isDeclarationName(node) || isNonValueIdentifier(node)) {
      continue;
    }
    referenced = true;
    if (!predicate(node)) {
      return false;
    }
  }
  return referenced;
}

function callbackHasDirectJsxEventRoot(
  callback: RuntimeFunctionLike,
  owner: RuntimeFunctionLike,
  childContracts: ChildContractResolver | null,
): boolean {
  if (
    !ts.isArrowFunction(callback) &&
    !ts.isFunctionDeclaration(callback) &&
    !ts.isFunctionExpression(callback)
  ) {
    return false;
  }
  if (isInlineDeferredEventCallback(callback, owner, childContracts)) {
    return true;
  }
  const name = localCallbackBindingName(callback);
  if (!name || bindingDeclarationCount(owner, name) !== 1) {
    return false;
  }
  return everyValueReferenceSatisfies(owner, name, (node) => {
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    return (
      attribute !== null &&
      isDirectJsxAttributeExpression(attribute, node) &&
      jsxEventAttributeIsDeferred(attribute, childContracts)
    );
  });
}

function jsxEventAttributeIsDeferred(
  attribute: ts.JsxAttribute,
  childContracts: ChildContractResolver | null,
): boolean {
  const prop = attribute.name.getText();
  const target = jsxTargetName(attribute);
  if (!target || !/^on[A-Z]/u.test(prop)) {
    return false;
  }
  return (
    !isCustomJsxTarget(target) ||
    childContracts?.frameworkEventComponent(target) === true ||
    childContracts?.componentCallbackPropIsDeferred(target, prop) === true
  );
}

interface DialogFlagProofContext {
  readonly mutations: readonly SetterMutation[];
  readonly stateFlow: StateFlowIndex;
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

function flagOpensWithPayload(
  flag: StateCandidate,
  payloadOpenMutations: readonly SetterMutation[],
  { mutations, stateFlow, usageByState }: DialogFlagProofContext,
): boolean {
  const flagMutations = mutations.filter((mutation) => mutation.state === flag);
  const openMutations = flagMutations.filter((mutation) =>
    callSetsLiteral(mutation, ts.SyntaxKind.TrueKeyword),
  );
  const canClose =
    flagMutations.some((mutation) => callSetsLiteral(mutation, ts.SyntaxKind.FalseKeyword)) ||
    flagMutations.some((mutation) => isControlledBooleanTransition(mutation)) ||
    (usageByState.get(flag)?.setterTargets.size ?? 0) > 0;
  if (openMutations.length === 0 || !canClose) {
    return false;
  }
  return openMutations.some((flagMutation) =>
    payloadOpenMutations.some(
      (payloadMutation) =>
        flagMutation.region === payloadMutation.region &&
        mutationsAreProvenCoexecuting(flagMutation.call, payloadMutation.call, {
          region: flagMutation.region,
          stateFlow,
        }),
    ),
  );
}

function normalizeObservableDialogClusterMembers(
  members: readonly StateCandidate[],
  context: ClusterMemberContext,
): readonly StateCandidate[] | null {
  const { mutations, stateFlow, usageByState } = context;
  const roles = dialogClusterRoles(members, context);
  if (!roles) {
    return null;
  }
  const { latch, payload, payloadOpenMutations } = roles;
  const targetSets = dialogMemberTargetSets(members, { latch, payload }, context);
  if (!targetSets || !targetSets.some((targets) => targets.size > 0)) {
    return null;
  }
  const flagsPairWithPayload = roles.flags.every(
    (flag) =>
      flag === latch ||
      flagOpensWithPayload(flag, payloadOpenMutations, { mutations, stateFlow, usageByState }),
  );
  return flagsPairWithPayload && dialogGatesAreBounded(members, roles, context) ? members : null;
}

interface DialogClusterMembership extends DialogClusterRoles {
  readonly flags: readonly StateCandidate[];
  readonly payloadOpenMutations: readonly SetterMutation[];
}

function dialogClusterRoles(
  members: readonly StateCandidate[],
  context: ClusterMemberContext,
): DialogClusterMembership | null {
  const payloads = members.filter((member) => hasDialogPayloadInitializer(member));
  const flags = members.filter((state) => hasStateInitializer(state, ts.SyntaxKind.FalseKeyword));
  const [payload] = payloads;
  if (
    members.length < PAIRED_CLUSTER_SIZE ||
    payloads.length !== 1 ||
    !payload ||
    flags.length === 0 ||
    payloads.length + flags.length !== members.length
  ) {
    return null;
  }
  const payloadOpenMutations = context.mutations.filter(
    (mutation) =>
      mutation.state === payload && !callSetsLiteral(mutation, ts.SyntaxKind.NullKeyword),
  );
  const latches = flags.filter((flag) =>
    isMonotonicDialogLatch(flag, payloadOpenMutations, context),
  );
  if (payloadOpenMutations.length === 0 || latches.length > 1) {
    return null;
  }
  return { flags, latch: latches[0] ?? null, payload, payloadOpenMutations };
}

function dialogGatesAreBounded(
  members: readonly StateCandidate[],
  { latch, payload }: DialogClusterRoles,
  context: ClusterMemberContext,
): boolean {
  if (
    payloadControlsOwnerJsx(payload, context.knownComponents) &&
    !stateHasBoundedDialogGate(payload, members, context)
  ) {
    return false;
  }
  return !latch || stateHasBoundedDialogGate(latch, members, context);
}

interface DialogClusterRoles {
  readonly latch: StateCandidate | null;
  readonly payload: StateCandidate;
}

function dialogMemberTargetSets(
  members: readonly StateCandidate[],
  roles: DialogClusterRoles,
  { knownComponents, usageByState }: ClusterMemberContext,
): readonly ReadonlySet<string>[] | null {
  const targetSets: ReadonlySet<string>[] = [];
  for (const member of members) {
    const usage = usageByState.get(member);
    if (!usage || !dialogMemberUsageIsIsolated(member, usage)) {
      return null;
    }
    const targets = new Set([...usage.jsxTargets].filter((target) => knownComponents.has(target)));
    if (!dialogMemberTargetsAreSufficient({ state: member, usage }, targets, roles)) {
      return null;
    }
    targetSets.push(targets);
  }
  return targetSets;
}

function dialogMemberUsageIsIsolated(member: StateCandidate, usage: StateUsage): boolean {
  return (
    !usage.shadowed &&
    !usage.escaped &&
    !stateMayHoldCallable(member) &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    !usage.setterUsesPreviousValue
  );
}

function dialogMemberTargetsAreSufficient(
  { state: member, usage }: StateRenderScope,
  targets: ReadonlySet<string>,
  { latch, payload }: DialogClusterRoles,
): boolean {
  if (targets.size > 0) {
    return true;
  }
  if (member !== payload && member !== latch) {
    return false;
  }
  return member !== payload || usage.localRenderReads > 0 || usage.deferredReads > 0;
}

interface ScalarDialogContractScope {
  readonly childContracts: ChildContractResolver;
  readonly knownComponents: ReadonlySet<string>;
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

function scalarDialogSharesDeferredCallSite(
  payload: StateCandidate,
  flag: StateCandidate,
  { childContracts, knownComponents, usageByState }: ScalarDialogContractScope,
): boolean {
  const usages: ClusterPairUsage = {
    firstUsage: usageByState.get(payload),
    secondUsage: usageByState.get(flag),
  };
  const [target] = [...(usages.firstUsage?.valueTargets ?? [])];
  return (
    scalarDialogUsageSharesCallSite(payload, flag, usages) &&
    target !== undefined &&
    knownComponents.has(target) &&
    scalarDialogCallSiteIsDeferred(payload, flag, {
      childContracts,
      knownComponents,
      target,
      usages,
    })
  );
}

function normalizePersistentScalarDialogClusterMembers(
  members: readonly StateCandidate[],
  context: ClusterMemberContext,
): readonly StateCandidate[] | null {
  const { childContracts, knownComponents, mutations, stateFlow, usageByState } = context;
  const pair = childContracts
    ? distinctClusterPair(
        members,
        (state) => hasLiteralScalarDialogPayloadInitializer(state),
        (state) => hasStateInitializer(state, ts.SyntaxKind.FalseKeyword),
      )
    : null;
  if (!childContracts || !pair) {
    return null;
  }
  const { first: payload, second: flag } = pair;
  if (
    !scalarDialogSharesDeferredCallSite(payload, flag, {
      childContracts,
      knownComponents,
      usageByState,
    })
  ) {
    return null;
  }
  const payloadMutations = mutations.filter((mutation) => mutation.state === payload);
  const flagMutations = mutations.filter((mutation) => mutation.state === flag);
  return scalarDialogMutationsArePaired(payloadMutations, flagMutations, {
    flag,
    payload,
    stateFlow,
  })
    ? members
    : null;
}

function scalarDialogUsageSharesCallSite(
  payload: StateCandidate,
  flag: StateCandidate,
  { firstUsage: payloadUsage, secondUsage: flagUsage }: ClusterPairUsage,
): boolean {
  if (!payloadUsage || !flagUsage) {
    return false;
  }
  return (
    ![payloadUsage, flagUsage].some(
      (usage) =>
        usage.localRenderReads !== 0 ||
        usage.effectReads !== 0 ||
        usage.effectWrites !== 0 ||
        usage.deferredReads !== 0 ||
        usage.repeatedTransport ||
        usage.unstableTransport ||
        usage.setterUsesPreviousValue ||
        usage.shadowed ||
        usage.escaped,
    ) &&
    !stateMayHoldCallable(payload) &&
    !stateMayHoldCallable(flag) &&
    payloadUsage.valueTransportSites.size === 1 &&
    flagUsage.valueTransportSites.size === 1 &&
    [...payloadUsage.valueTransportSites][0] === [...flagUsage.valueTransportSites][0] &&
    payloadUsage.valueTargets.size === 1 &&
    flagUsage.valueTargets.size === 1 &&
    [...payloadUsage.valueTargets][0] === [...flagUsage.valueTargets][0] &&
    payloadUsage.setterTransportSites.size === 0 &&
    payloadUsage.setterReferences === payloadUsage.setterCalls &&
    flagUsage.setterTransportSites.size === 1 &&
    flagUsage.setterReferences === flagUsage.setterCalls + 1
  );
}

interface ScalarDialogCallSiteScope {
  readonly childContracts: ChildContractResolver;
  readonly knownComponents: ReadonlySet<string>;
  readonly target: string;
  readonly usages: ClusterPairUsage;
}

function scalarDialogCallSiteIsDeferred(
  payload: StateCandidate,
  flag: StateCandidate,
  { childContracts, target, usages }: ScalarDialogCallSiteScope,
): boolean {
  const { firstUsage: payloadUsage, secondUsage: flagUsage } = usages;
  if (!payloadUsage || !flagUsage) {
    return false;
  }
  const payloadCallSite = directUniqueReturnCallSite(payloadUsage, payload.owner)?.opening;
  const flagCallSite = directUniqueReturnCallSite(flagUsage, flag.owner)?.opening;
  const closeTransport = directSetterTransport(flag);
  return (
    payloadCallSite !== undefined &&
    payloadCallSite === flagCallSite &&
    !callSiteIsKeyed(payloadCallSite) &&
    closeTransport !== null &&
    closeTransport.target === target &&
    closeTransport.attribute.parent.parent === payloadCallSite &&
    childContracts.componentCallbackPropIsDeferred(target, closeTransport.attribute.name.getText())
  );
}

interface ScalarDialogPairScope {
  readonly flag: StateCandidate;
  readonly payload: StateCandidate;
  readonly stateFlow: StateFlowIndex;
}

function scalarDialogMutationsArePaired(
  payloadMutations: readonly SetterMutation[],
  flagMutations: readonly SetterMutation[],
  { flag, payload, stateFlow }: ScalarDialogPairScope,
): boolean {
  const opens = flagMutations.filter((mutation) =>
    callSetsLiteral(mutation, ts.SyntaxKind.TrueKeyword),
  );
  const closes = flagMutations.filter((mutation) =>
    callSetsLiteral(mutation, ts.SyntaxKind.FalseKeyword),
  );
  const paired = (left: SetterMutation, right: SetterMutation): boolean =>
    left.region === right.region &&
    mutationsAreProvenCoexecuting(left.call, right.call, { region: left.region, stateFlow });
  return (
    payloadMutations.length > 0 &&
    opens.length > 0 &&
    flagMutations.length === opens.length + closes.length &&
    payloadMutations.every(
      (mutation) =>
        mutationIsEventRooted(mutation, payload) && mutationWritesTypedPrimitive(mutation),
    ) &&
    flagMutations.every((mutation) => mutationIsEventRooted(mutation, flag)) &&
    payloadMutations.every((payloadMutation) =>
      opens.some((open) => paired(payloadMutation, open)),
    ) &&
    opens.every((open) => payloadMutations.some((payloadMutation) => paired(open, payloadMutation)))
  );
}

function hasLiteralScalarDialogPayloadInitializer(state: StateCandidate): boolean {
  const [initializer] = state.call.arguments;
  if (!initializer) {
    return false;
  }
  const value = unwrapTransparentExpression(initializer);
  return ts.isStringLiteralLike(value) || ts.isNumericLiteral(value);
}

function mutationWritesTypedPrimitive(mutation: SetterMutation): boolean {
  const [argument] = mutation.call.arguments;
  if (!argument || mutation.call.arguments.length !== 1) {
    return false;
  }
  const value = unwrapTransparentExpression(argument);
  if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)) {
    return true;
  }
  if (!ts.isIdentifier(value) || !isRuntimeFunctionLike(mutation.region)) {
    return false;
  }
  return mutation.region.parameters.some(
    (parameter) =>
      ts.isIdentifier(parameter.name) &&
      parameter.name.text === value.text &&
      parameter.type !== undefined &&
      primitiveDialogPayloadType(parameter.type),
  );
}

function primitiveDialogPayloadType(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type)) {
    return primitiveDialogPayloadType(type.type);
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.length > 0 && type.types.every(primitiveDialogPayloadType);
  }
  if (ts.isLiteralTypeNode(type)) {
    return ts.isStringLiteralLike(type.literal) || ts.isNumericLiteral(type.literal);
  }
  return type.kind === ts.SyntaxKind.StringKeyword || type.kind === ts.SyntaxKind.NumberKeyword;
}

function isMonotonicDialogLatch(
  flag: StateCandidate,
  payloadOpenMutations: readonly SetterMutation[],
  { mutations, stateFlow, usageByState }: ClusterMemberContext,
): boolean {
  const usage = usageByState.get(flag);
  const flagMutations = mutations.filter((mutation) => mutation.state === flag);
  return (
    usage !== undefined &&
    usage.localRenderReads > 0 &&
    usage.transportedOccurrences === 0 &&
    usage.deferredReads === 0 &&
    usage.setterReferences === usage.setterCalls &&
    flagMutations.length > 0 &&
    flagMutations.every((mutation) => callSetsLiteral(mutation, ts.SyntaxKind.TrueKeyword)) &&
    flagMutations.every((flagMutation) =>
      payloadOpenMutations.some(
        (payloadMutation) =>
          flagMutation.region === payloadMutation.region &&
          mutationsAreProvenCoexecuting(flagMutation.call, payloadMutation.call, {
            region: flagMutation.region,
            stateFlow,
          }),
      ),
    )
  );
}

function hasDialogPayloadInitializer(state: StateCandidate): boolean {
  return state.call.arguments.length === 0 || hasStateInitializer(state, ts.SyntaxKind.NullKeyword);
}

function gatedFeedbackUsageIsIsolated(
  payload: StateCandidate,
  feedback: StateCandidate,
  { firstUsage: payloadUsage, secondUsage: feedbackUsage }: ClusterPairUsage,
): boolean {
  if (!payloadUsage || !feedbackUsage) {
    return false;
  }
  return (
    ![payloadUsage, feedbackUsage].some(
      (usage) =>
        usage.shadowed ||
        usage.escaped ||
        usage.effectReads > 0 ||
        usage.effectWrites > 0 ||
        usage.setterUsesPreviousValue ||
        usage.transportedOccurrences > 0,
    ) &&
    !stateMayHoldCallable(payload) &&
    !stateMayHoldCallable(feedback) &&
    payloadUsage.localRenderReads > 0 &&
    feedbackUsage.localRenderReads > 0 &&
    payloadUsage.setterReferences === payloadUsage.setterCalls &&
    feedbackUsage.setterReferences === feedbackUsage.setterCalls
  );
}

interface GatedFeedbackTimingScope extends CoexecutionScope {
  readonly payloadResets: readonly SetterMutation[];
}

function gatedFeedbackMutationsAreTimed(
  payloadMutations: readonly SetterMutation[],
  feedbackMutations: readonly SetterMutation[],
  { payloadResets, region, stateFlow }: GatedFeedbackTimingScope,
): boolean {
  const feedbackResets = feedbackMutations.filter((mutation) =>
    callSetsLiteral(mutation, ts.SyntaxKind.FalseKeyword),
  );
  const feedbackStarts = feedbackMutations.filter((mutation) =>
    callSetsLiteral(mutation, ts.SyntaxKind.TrueKeyword),
  );
  return (
    payloadMutations.length >= MIN_REPEATED_SETTER_CALLS &&
    payloadResets.length > 0 &&
    payloadMutations.some((mutation) => !callSetsLiteral(mutation, ts.SyntaxKind.NullKeyword)) &&
    feedbackStarts.length > 0 &&
    feedbackResets.length >= MIN_REPEATED_SETTER_CALLS &&
    feedbackHasTimedReset(feedbackStarts, feedbackResets, { region, stateFlow })
  );
}

function feedbackIsGatedByPayload(
  payload: StateCandidate,
  feedback: StateCandidate,
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
): boolean {
  const payloadUsage = usageByState.get(payload);
  const feedbackUsage = usageByState.get(feedback);
  return (
    payloadUsage !== undefined &&
    feedbackUsage !== undefined &&
    gatedFeedbackUsageIsIsolated(payload, feedback, {
      firstUsage: payloadUsage,
      secondUsage: feedbackUsage,
    }) &&
    feedbackRenderIsConfinedToPayloadGate(payload, payloadUsage, feedbackUsage)
  );
}

function normalizeGatedFeedbackClusterMembers(
  members: readonly StateCandidate[],
  { mutations, stateFlow, usageByState }: ClusterMemberContext,
): readonly StateCandidate[] | null {
  const pair = distinctClusterPair(
    members,
    (state) => hasStateInitializer(state, ts.SyntaxKind.NullKeyword),
    (state) => hasStateInitializer(state, ts.SyntaxKind.FalseKeyword),
  );
  if (!pair) {
    return null;
  }
  const { first: payload, second: feedback } = pair;
  if (!feedbackIsGatedByPayload(payload, feedback, usageByState)) {
    return null;
  }
  const payloadMutations = mutations.filter((mutation) => mutation.state === payload);
  const feedbackMutations = mutations.filter((mutation) => mutation.state === feedback);
  return gatedFeedbackResetsArePaired(payloadMutations, feedbackMutations, {
    region: feedback.owner,
    stateFlow,
  })
    ? [payload, feedback]
    : null;
}

function gatedFeedbackResetsArePaired(
  payloadMutations: readonly SetterMutation[],
  feedbackMutations: readonly SetterMutation[],
  { region, stateFlow }: CoexecutionScope,
): boolean {
  const payloadResets = payloadMutations.filter((mutation) =>
    callSetsLiteral(mutation, ts.SyntaxKind.NullKeyword),
  );
  if (
    !gatedFeedbackMutationsAreTimed(payloadMutations, feedbackMutations, {
      payloadResets,
      region,
      stateFlow,
    })
  ) {
    return false;
  }
  const feedbackResets = feedbackMutations.filter((mutation) =>
    callSetsLiteral(mutation, ts.SyntaxKind.FalseKeyword),
  );
  return payloadResets.some((payloadReset) =>
    feedbackResets.some((feedbackReset) =>
      mutationsWriteTogether(payloadReset, feedbackReset, stateFlow),
    ),
  );
}

function feedbackRenderIsConfinedToPayloadGate(
  payload: StateCandidate,
  payloadUsage: StateUsage,
  feedbackUsage: StateUsage,
): boolean {
  if (
    payloadUsage.directRenderNodes.length === 0 ||
    payloadUsage.localRenderReads !== payloadUsage.directRenderNodes.length ||
    feedbackUsage.directRenderNodes.length === 0 ||
    feedbackUsage.localRenderReads !== feedbackUsage.directRenderNodes.length
  ) {
    return false;
  }
  const feedbackLeaf = lowestCommonJsxSubtree(feedbackUsage.directRenderNodes, payload.owner);
  const returned =
    uniqueReturnedExpression(payload.owner) ?? uniqueJsxReturnAllowingNullGuard(payload.owner);
  if (!feedbackLeaf || jsxElementCountIn(feedbackLeaf) > MAX_FEEDBACK_LEAF_ELEMENTS || !returned) {
    return false;
  }
  let confined = false;
  visit(returned, (node) => {
    if (!confined) {
      confined = payloadGateConfinesFeedback(node, feedbackLeaf, {
        feedbackUsage,
        payload,
        payloadUsage,
      });
    }
  });
  return confined;
}

interface GatedFeedbackScope {
  readonly feedbackUsage: StateUsage;
  readonly payload: StateCandidate;
  readonly payloadUsage: StateUsage;
}

function payloadGateConfinesFeedback(
  node: ts.Node,
  feedbackLeaf: JsxSubtreeNode,
  { feedbackUsage, payload, payloadUsage }: GatedFeedbackScope,
): boolean {
  if (
    !ts.isConditionalExpression(node) ||
    !isDirectTruthyStateCondition(node.condition, payload.valueName)
  ) {
    return false;
  }
  return (
    payloadUsage.directRenderNodes.every((read) => nodeWithin(read, node)) &&
    feedbackUsage.directRenderNodes.every((read) => nodeWithin(read, node.whenTrue)) &&
    nodeWithin(feedbackLeaf, node.whenTrue)
  );
}

function uniqueJsxReturnAllowingNullGuard(owner: RuntimeFunctionLike): ts.Expression | null {
  if (!owner.body) {
    return null;
  }
  const returned: ts.Expression[] = [];
  let unsafe = false;
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (!unsafe) {
      unsafe = !collectJsxOrNullReturn(node, returned);
    }
  });
  return !unsafe && returned.length === 1 ? returned[0]! : null;
}

function collectJsxOrNullReturn(node: ts.Node, returned: ts.Expression[]): boolean {
  if (!ts.isReturnStatement(node)) {
    return true;
  }
  const expression = node.expression && unwrapTransparentExpression(node.expression);
  if (expression?.kind === ts.SyntaxKind.NullKeyword) {
    return true;
  }
  if (!expression || !isJsxRootExpression(expression)) {
    return false;
  }
  returned.push(expression);
  return true;
}

function isJsxRootExpression(expression: ts.Expression): boolean {
  return (
    ts.isJsxElement(expression) ||
    ts.isJsxSelfClosingElement(expression) ||
    ts.isJsxFragment(expression)
  );
}

function isDirectTruthyStateCondition(expression: ts.Expression, stateName: string): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return value.text === stateName;
  }
  return (
    ts.isPrefixUnaryExpression(value) &&
    value.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isPrefixUnaryExpression(value.operand) &&
    value.operand.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isIdentifier(value.operand.operand) &&
    value.operand.operand.text === stateName
  );
}

function feedbackHasTimedReset(
  starts: readonly SetterMutation[],
  resets: readonly SetterMutation[],
  { region: owner, stateFlow }: CoexecutionScope,
): boolean {
  if (bindingDeclarationCount(owner, "setTimeout") > 0) {
    return false;
  }
  return resets.some((reset) => {
    const timer = findAncestorUntil(
      reset.call,
      (node): node is ts.CallExpression => {
        if (
          !ts.isCallExpression(node) ||
          !ts.isIdentifier(node.expression) ||
          node.expression.text !== "setTimeout"
        ) {
          return false;
        }
        const [callback] = node.arguments;
        return callback !== undefined && nodeWithin(reset.call, callback);
      },
      owner,
    );
    if (!timer) {
      return false;
    }
    const command = nearestMutationFunction(timer, owner);
    return starts.some(
      (start) =>
        start.region === command &&
        start.call.getStart() < timer.getStart() &&
        (callsAreAdjacentDraftWrites(start.call, timer) ||
          mutationsAreProvenCoexecuting(start.call, timer, { region: command, stateFlow })),
    );
  });
}

function payloadControlsOwnerJsx(
  payload: StateCandidate,
  knownComponents: ReadonlySet<string>,
): boolean {
  let controls = false;
  visit(payload.owner.body, (node) => {
    controls ||= readControlsOwnerJsx(node, payload, knownComponents);
  });
  return controls;
}

function readControlsOwnerJsx(
  node: ts.Node,
  payload: StateCandidate,
  knownComponents: ReadonlySet<string>,
): boolean {
  if (!ts.isIdentifier(node) || node.text !== payload.valueName || isNonValueIdentifier(node)) {
    return false;
  }
  if (!findAncestorUntil(node, isJsxNode, payload.owner)) {
    return false;
  }
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, payload.owner);
  const target = attribute ? jsxTargetName(attribute) : null;
  return !target || !knownComponents.has(target);
}

function stateHasBoundedDialogGate(
  state: StateCandidate,
  members: readonly StateCandidate[],
  { knownComponents, usageByState }: ClusterAnalysisContext,
): boolean {
  const stateUsage = usageByState.get(state);
  if (
    !stateUsage ||
    stateUsage.localRenderReads === 0 ||
    stateUsage.localRenderReads !== stateUsage.directRenderNodes.length
  ) {
    return false;
  }

  const gate = boundedDialogGate(state, stateUsage);
  if (!gate) {
    return false;
  }
  const targetSites = knownComponentCallSites(gate.trueBranch, knownComponents);
  if (targetSites.size === 0) {
    return false;
  }
  return members.every((member) =>
    memberIsConfinedToDialogGate(usageByState.get(member), gate.expression, {
      knownComponents,
      targetSites,
    }),
  );
}

interface DialogGateTargets {
  readonly knownComponents: ReadonlySet<string>;
  readonly targetSites: ReadonlySet<number>;
}

function memberIsConfinedToDialogGate(
  usage: StateUsage | undefined,
  gate: ts.JsxExpression,
  { knownComponents, targetSites }: DialogGateTargets,
): boolean {
  return (
    usage !== undefined &&
    [...usage.jsxTargets].every((target) => knownComponents.has(target)) &&
    [...usage.valueTransportSites, ...usage.setterTransportSites].every((site) =>
      targetSites.has(site),
    ) &&
    usage.directRenderNodes.every((read) => nodeWithin(read, gate))
  );
}

interface BoundedDialogGate {
  readonly expression: ts.JsxExpression;
  readonly trueBranch: ts.Node;
}

function boundedDialogGate(
  state: StateCandidate,
  stateUsage: StateUsage,
): BoundedDialogGate | null {
  const [firstRead] = stateUsage.directRenderNodes;
  const gate = firstRead ? findAncestorUntil(firstRead, ts.isJsxExpression, state.owner) : null;
  const expression = gate?.expression && unwrapTransparentExpression(gate.expression);
  const trueBranch = expression ? directDialogPayloadGateBranch(expression, state.valueName) : null;
  if (
    !gate ||
    !trueBranch ||
    (!ts.isJsxElement(trueBranch) &&
      !ts.isJsxSelfClosingElement(trueBranch) &&
      !ts.isJsxFragment(trueBranch)) ||
    nearestRepeatedRenderCall(gate, state.owner) ||
    jsxElementCountIn(trueBranch) > BROAD_OWNER_JSX_ELEMENTS ||
    jsxElementCountIn(trueBranch) / jsxElementCount(state.owner) > MAX_LEAF_SUBTREE_RATIO ||
    !stateUsage.directRenderNodes.every((read) => nodeWithin(read, gate))
  ) {
    return null;
  }
  return { expression: gate, trueBranch };
}

function knownComponentCallSites(
  root: ts.Node,
  knownComponents: ReadonlySet<string>,
): ReadonlySet<number> {
  const sites = new Set<number>();
  visit(root, (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      knownComponents.has(node.tagName.getText())
    ) {
      sites.add(node.getStart());
    }
  });
  return sites;
}

function directDialogPayloadGateBranch(
  expression: ts.Expression,
  payloadName: string,
): ts.Expression | null {
  const value = unwrapTransparentExpression(expression);
  if (
    ts.isConditionalExpression(value) &&
    isDirectTruthyStateCondition(value.condition, payloadName) &&
    unwrapTransparentExpression(value.whenFalse).kind === ts.SyntaxKind.NullKeyword
  ) {
    return unwrapTransparentExpression(value.whenTrue);
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    isDirectTruthyStateCondition(value.left, payloadName)
  ) {
    return unwrapTransparentExpression(value.right);
  }
  return null;
}

function isControlledBooleanTransition(mutation: SetterMutation): boolean {
  const [argument] = mutation.call.arguments;
  if (!argument || !ts.isIdentifier(argument)) {
    return false;
  }
  const callback = isInlineRuntimeCallback(mutation.region) ? mutation.region : null;
  const parameter = callback?.parameters[0];
  if (!parameter || !ts.isIdentifier(parameter.name) || parameter.name.text !== argument.text) {
    return false;
  }
  const attribute = callback ? findAncestor(callback, ts.isJsxAttribute) : null;
  return (
    attribute !== null &&
    /^(?:onOpen|onVisible|onExpanded)Change(?:Complete)?$/u.test(attribute.name.getText())
  );
}

function isInlineRuntimeCallback(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function callSetsLiteral(mutation: SetterMutation, kind: ts.SyntaxKind): boolean {
  return mutation.call.arguments.length === 1 && mutation.call.arguments[0]?.kind === kind;
}

function primitiveSetterUpdatersArePure(state: StateCandidate, usage: StateUsage): boolean {
  if (!hasDirectPrimitiveInitializer(state)) {
    return true;
  }
  return usage.setterCallNodes.every((call) => {
    const [argument] = call.arguments;
    return (
      !argument ||
      (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) ||
      isPureExpression(argument, (mathCall) =>
        isUnshadowedMathCall(state.owner, mathCall, PURE_MATH_METHODS),
      )
    );
  });
}

function nearestMutationFunction(node: ts.Node, owner: RuntimeFunctionLike): RuntimeFunctionLike {
  return findAncestorUntil(node, isRuntimeFunctionLike, owner) ?? owner;
}

interface CoexecutionScope {
  readonly region: RuntimeFunctionLike;
  readonly stateFlow: StateFlowIndex;
}

function mutationsAreProvenCoexecuting(
  left: ts.CallExpression,
  right: ts.CallExpression,
  { region, stateFlow }: CoexecutionScope,
): boolean {
  return stateFlow.proveSynchronousCoexecution(region, left, right) === "proven";
}

function mutationsMayCoexecute(
  left: ts.CallExpression,
  right: ts.CallExpression,
  { region, stateFlow }: CoexecutionScope,
): boolean {
  return stateFlow.proveSynchronousCoexecution(region, left, right) !== "disproven";
}

interface StateReferenceContext {
  readonly effectNodes: ReadonlySet<ts.Node>;
  readonly imports: HookImports;
  readonly usage: StateUsage;
}

function classifySetterReference(
  node: ts.Identifier,
  state: StateCandidate,
  context: StateReferenceContext,
): void {
  if (node.parent === state.call.parent) {
    return;
  }
  context.usage.setterReferences += 1;
  if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
    recordSetterCall(node.parent, node, context);
    return;
  }
  recordSetterTransportOrEscape(node, state, context);
}

function recordSetterTransportOrEscape(
  node: ts.Identifier,
  state: StateCandidate,
  context: StateReferenceContext,
): void {
  const jsxAttribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
  if (!jsxAttribute) {
    context.usage.escaped = true;
    return;
  }
  recordSetterJsxReference({ jsxAttribute, node }, state, context);
}

function recordSetterCall(
  call: ts.CallExpression,
  node: ts.Identifier,
  { effectNodes, imports, usage }: StateReferenceContext,
): void {
  usage.setterCalls += 1;
  usage.setterCallNodes.push(call);
  usage.setterUsesPreviousValue ||= setterCallUsesPreviousValue(call);
  if (hasAncestorInSet(node, effectNodes)) {
    usage.effectWrites += 1;
  }
  if (isInsideImportedCallback(node, imports.useObserveEffect)) {
    usage.legendReactionWrites += 1;
  }
}

interface JsxTransportRecord {
  readonly jsxAttribute: ts.JsxAttribute;
  readonly node: ts.Identifier;
}

type JsxTransportRole = "escaped" | "local-render" | "transport";

function jsxTransportRole(
  { jsxAttribute, node }: JsxTransportRecord,
  target: string | null,
  imports: HookImports,
): JsxTransportRole {
  if (!target || !isCustomJsxTarget(target) || imports.hostComponents.has(target)) {
    return "local-render";
  }
  if (target.endsWith(".Provider")) {
    return "escaped";
  }
  return isDirectJsxAttributeExpression(jsxAttribute, node) ? "transport" : "local-render";
}

function transportTargetOrRecordFallback(
  record: JsxTransportRecord,
  { imports, usage }: StateReferenceContext,
  onLocalRender: () => void,
): string | null {
  const target = jsxTargetName(record.jsxAttribute);
  const role = jsxTransportRole(record, target, imports);
  if (role === "escaped") {
    usage.escaped = true;
    return null;
  }
  if (role === "local-render" || !target) {
    onLocalRender();
    return null;
  }
  return target;
}

function recordSetterJsxReference(
  record: JsxTransportRecord,
  state: StateCandidate,
  context: StateReferenceContext,
): void {
  const { usage } = context;
  const { jsxAttribute } = record;
  const target = transportTargetOrRecordFallback(record, context, () => {
    usage.localRenderReads += 1;
  });
  if (!target) {
    return;
  }
  usage.setterTargets.add(target);
  usage.setterTransportSites.add(jsxTransportSite(jsxAttribute));
  recordJsxTransportSite(jsxAttribute, target, { owner: state.owner, usage });
}

interface TransportBookkeeping {
  readonly owner: RuntimeFunctionLike;
  readonly usage: StateUsage;
}

function recordJsxTransportSite(
  jsxAttribute: ts.JsxAttribute,
  target: string,
  { owner, usage }: TransportBookkeeping,
): boolean {
  usage.jsxTargets.add(target);
  usage.transportedOccurrences += 1;
  const repeatedRender = nearestRepeatedRenderCall(jsxAttribute, owner) !== null;
  usage.repeatedTransport ||= repeatedRender;
  usage.unstableTransport ||= hasUnstableJsxLifetime(jsxAttribute, owner);
  return repeatedRender;
}

function recordLifecycleValueRead(
  node: ts.Identifier,
  state: StateCandidate,
  { effectNodes, usage }: StateReferenceContext,
): boolean {
  if (isHookDependencyReference(node, CALLBACK_HOOK_NAMES)) {
    usage.deferredReads += 1;
    return true;
  }
  if (hasAncestorInSet(node, effectNodes)) {
    usage.effectReads += 1;
    return true;
  }
  return recordEventCallbackRead(node, state, usage);
}

function recordEventCallbackRead(
  node: ts.Identifier,
  state: StateCandidate,
  usage: StateUsage,
): boolean {
  if (!isInsideJsxEventCallback(node, state.owner)) {
    return false;
  }
  usage.deferredReads += 1;
  usage.eventReads += 1;
  return true;
}

function classifyValueReference(
  node: ts.Identifier,
  state: StateCandidate,
  { effectNodes, imports, usage }: StateReferenceContext,
): void {
  if (node.parent === state.call.parent) {
    return;
  }
  if (recordLifecycleValueRead(node, state, { effectNodes, imports, usage })) {
    return;
  }
  const jsxAttribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
  if (jsxAttribute) {
    recordValueJsxReference({ jsxAttribute, node }, state, { effectNodes, imports, usage });
    return;
  }
  recordNonAttributeValueRead(node, state, usage);
}

function recordNonAttributeValueRead(
  node: ts.Identifier,
  state: StateCandidate,
  usage: StateUsage,
): void {
  if (findAncestorUntil(node, isJsxNode, state.owner)) {
    recordDirectRenderRead(node, usage);
    return;
  }
  recordOutsideRenderValueRead(node, state, usage);
}

function recordOutsideRenderValueRead(
  node: ts.Identifier,
  state: StateCandidate,
  usage: StateUsage,
): void {
  const nestedFunction = nearestNestedFunction(node, state.owner);
  if (nestedFunction && !isSynchronousRenderCallback(nestedFunction)) {
    usage.deferredReads += 1;
    return;
  }
  if (isDirectArgumentToUnknownCall(node)) {
    usage.escaped = true;
    return;
  }
  recordDirectRenderRead(node, usage);
}

function recordDirectRenderRead(node: ts.Identifier, usage: StateUsage): void {
  usage.localRenderReads += 1;
  usage.directRenderNodes.push(node);
}

function recordValueJsxReference(
  record: JsxTransportRecord,
  state: StateCandidate,
  context: StateReferenceContext,
): void {
  const { usage } = context;
  const { jsxAttribute, node } = record;
  const target = transportTargetOrRecordFallback(record, context, () => {
    recordDirectRenderRead(node, usage);
  });
  if (!target) {
    return;
  }
  usage.valueTargets.add(target);
  addMapSet(usage.valueProps, target, jsxAttribute.name.getText());
  usage.valueTransportSites.add(jsxTransportSite(jsxAttribute));
  const repeatedRender = recordJsxTransportSite(jsxAttribute, target, {
    owner: state.owner,
    usage,
  });
  usage.repeatedValueTransport ||= repeatedRender || isInsideJsxCallback(jsxAttribute, state.owner);
}

function findLegendValueMirrors(
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  bridges: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<StateCandidate, ClassifiedState> {
  const mirrors = new Map<StateCandidate, ClassifiedState>();
  if (bridges.size === 0) {
    return mirrors;
  }
  for (const state of states) {
    const usage = usageByState.get(state);
    const mirror = usage ? legendValueMirror(state, usage, bridges) : null;
    if (mirror) {
      mirrors.set(state, mirror);
    }
  }
  return mirrors;
}

function stateOnlyMirrorsSeedBinding(state: StateCandidate, usage: StateUsage): boolean {
  return (
    state.setterName !== null &&
    usage.setterCalls > 0 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    usage.eventReads === 0 &&
    !usage.shadowed &&
    !usage.escaped
  );
}

function nullaryHookCallInitializer(source: ts.VariableDeclaration): ts.CallExpression | null {
  const hookCall = source.initializer ? unwrapTransparentExpression(source.initializer) : null;
  if (
    !hookCall ||
    !ts.isCallExpression(hookCall) ||
    hookCall.arguments.length > 0 ||
    !ts.isIdentifier(hookCall.expression)
  ) {
    return null;
  }
  return hookCall;
}

function legendValueMirror(
  state: StateCandidate,
  usage: StateUsage,
  bridges: ReadonlyMap<string, ReadonlySet<string>>,
): ClassifiedState | null {
  const [initial] = state.call.arguments;
  if (!initial || !ts.isIdentifier(initial) || !stateOnlyMirrorsSeedBinding(state, usage)) {
    return null;
  }
  const source = uniqueVariableDeclaration(state.owner, initial.text);
  const hookCall = source ? nullaryHookCallInitializer(source) : null;
  const writers = hookCall ? bridges.get(hookCall.expression.getText()) : undefined;
  if (
    !source ||
    !hookCall ||
    !writers ||
    !sourceBindingOnlySeedsState(source, state) ||
    !usage.setterCallNodes.every((call) => hasAdjacentBridgeWrite(call, writers))
  ) {
    return null;
  }
  return {
    action: "use-value",
    confidence: "probable",
    message: `Delete the React mirror \`${state.valueName}\` and render from \`${initial.text}\`, the one-hop \`${hookCall.expression.getText()}\` value; every React setter call is paired with the same inert argument to its proven observable writer, which remains the sole update path.`,
  };
}

function sourceBindingOnlySeedsState(
  source: ts.VariableDeclaration,
  state: StateCandidate,
): boolean {
  if (!ts.isIdentifier(source.name) || !state.owner.body) {
    return false;
  }
  const binding = source.name;
  const [initial] = state.call.arguments;
  let references = 0;
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== binding.text ||
      node === binding ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    references += 1;
    if (node !== initial) {
      safe = false;
    }
  });
  return safe && references === 1;
}

function hasAdjacentBridgeWrite(
  setterCall: ts.CallExpression,
  writers: ReadonlySet<string>,
): boolean {
  const statement = setterCall.parent;
  if (
    !ts.isExpressionStatement(statement) ||
    statement.expression !== setterCall ||
    !ts.isBlock(statement.parent) ||
    setterCall.arguments.length !== 1 ||
    !setterCall.arguments[0] ||
    !isEvaluationInert(setterCall.arguments[0])
  ) {
    return false;
  }
  const { statements } = statement.parent;
  const index = statements.indexOf(statement);
  return [statements[index - 1], statements[index + 1]].some((candidate) => {
    if (!candidate || !ts.isExpressionStatement(candidate)) {
      return false;
    }
    const expression = unwrapTransparentExpression(candidate.expression);
    if (!ts.isCallExpression(expression) || expression.arguments.length !== 1) {
      return false;
    }
    const [argument] = expression.arguments;
    const [setterArgument] = setterCall.arguments;
    return (
      argument !== undefined &&
      setterArgument !== undefined &&
      ts.isIdentifier(expression.expression) &&
      writers.has(expression.expression.text) &&
      argument.getText() === setterArgument.getText()
    );
  });
}

interface StateClassificationInputs {
  readonly belongsToObservableSelection: boolean;
  readonly branchUnmountMove: BranchUnmountMove | null;
  readonly childContracts: ChildContractResolver | null;
  readonly deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>;
  readonly dialogPayloadCut: DialogPayloadCut | null;
  readonly eventTransitionCallbacks: ReadonlySet<RuntimeFunctionLike>;
  readonly hasAdjacentEffectBooleanConsumers: boolean;
  readonly hasAdjacentEventBooleanConsumers: boolean;
  readonly hasCompanionWrites: boolean;
  readonly hasIndependentDirectEventWrite: boolean;
  readonly hasIndependentVisibilitySetterTransport: boolean;
  readonly hasMemoizedOptionCommand: boolean;
  readonly hasMultiSurfaceBooleanConsumers: boolean;
  readonly hasNonClosingCompanionWrites: boolean;
  readonly hasReactiveHostPropScalarConsumer: boolean;
  readonly hasReactiveMutationPath: boolean;
  readonly hasReturnedKeyedCursorConsumer: boolean;
  readonly hasSafeCommands: boolean;
  readonly hasSourceEventScalarConsumers: boolean;
  readonly isAsyncLeafStatus: boolean;
  readonly isCohesiveAsyncStatus: boolean;
  readonly isDeferredReveal: boolean;
  readonly isKeyedLeafCollection: boolean;
  readonly isKeyedLeafRecord: boolean;
  readonly isKeyedLeafScalar: boolean;
  readonly isKeyedScalarWithSecondary: boolean;
  readonly isPropertyLocalObjectDraft: boolean;
  readonly isSelfRefreshingCommand: boolean;
  readonly isUnprovenAsyncStatus: boolean;
  readonly localComponents: ReadonlySet<string>;
  readonly ownerObservableSubscriptions: number;
  readonly siblingRenderCut: SiblingRenderCut | null;
  readonly sourceComponents: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
  readonly state: StateCandidate;
  readonly subtree: StateSubtree | null;
  readonly usage: StateUsage;
}

interface StateRenderCutEvidence {
  readonly branchCallSite: DirectReturnCallSite | null;
  readonly callbackLeaf: LazyCallbackLeaf | null;
  readonly descendantControlledCut: boolean;
  readonly directCallSite: DirectReturnCallSite | null;
  readonly hasCompactBooleanTransportCut: boolean;
  readonly hasRepeatedOwnerRenderCut: boolean;
  readonly hasVisibilityValueTransport: boolean;
}

interface StateCommandSnapshotEvidence {
  readonly hasCommandSnapshotHazard: boolean;
  readonly hasEventCommandReadProof: boolean;
  readonly hasFunctionalSnapshotHazard: boolean;
  readonly preservesFunctionalSnapshot: boolean;
}

interface StateClassificationContext extends StateClassificationInputs {
  readonly commandSnapshot: StateCommandSnapshotEvidence;
  readonly renderCut: StateRenderCutEvidence;
}

type StateVerdict = (context: StateClassificationContext) => ClassifiedState | null;

interface TransportRenderCutScope extends ComponentScope {
  readonly branchSubtree: ts.Node | null;
}

function isIndependentTransportRenderCut(
  branchCallSite: DirectReturnCallSite | null,
  { branchSubtree, localComponents, sourceComponents }: TransportRenderCutScope,
): boolean {
  if (branchCallSite === null || branchSubtree === null) {
    return false;
  }
  return hasIndependentRenderCutWitness(
    branchCallSite.returned,
    [branchSubtree],
    localComponents,
    sourceComponents,
  );
}

function isCommandEndingBooleanState(state: StateCandidate, usage: StateUsage): boolean {
  return (
    usage.setterTargets.size === 0 &&
    usage.setterCallNodes.every((call) => setterCallEndsCommand(call, state.owner)) &&
    (hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) ||
      hasStateInitializer(state, ts.SyntaxKind.TrueKeyword))
  );
}

function transportsVisibilityProp(usage: StateUsage): boolean {
  return [...usage.valueProps.values()].some((props) =>
    [...props].some((prop) => /^(?:isOpen|isVisible|open|visible)$/u.test(prop)),
  );
}

function stateRenderCutEvidence(inputs: StateClassificationInputs): StateRenderCutEvidence {
  const {
    hasCompanionWrites,
    hasIndependentVisibilitySetterTransport,
    hasReactiveMutationPath,
    localComponents,
    sourceComponents,
    state,
    usage,
  } = inputs;
  const directCallSite = directUniqueReturnCallSite(usage, state.owner);
  const branchCallSite = directBranchReturnCallSite(usage, state.owner);
  const branchSubtree = branchCallSite ? jsxSubtreeForOpening(branchCallSite.opening) : null;
  const hasIndependentTransportRenderCut = isIndependentTransportRenderCut(branchCallSite, {
    branchSubtree,
    localComponents,
    sourceComponents,
  });
  const hasRepeatedOwnerRenderCut =
    branchSubtree !== null && hasRepeatedJsxRenderWorkOutside(state.owner, branchSubtree);
  const hasCompactBooleanTransportCut =
    hasIndependentTransportRenderCut &&
    !hasCompanionWrites &&
    !hasReactiveMutationPath &&
    isCommandEndingBooleanState(state, usage);
  const descendantControlledCut =
    branchCallSite !== null &&
    branchSubtree !== null &&
    hasIndependentVisibilitySetterTransport &&
    setterOwnedByValueCallSite(usage, state.owner) &&
    hasIndependentTransportRenderCut;
  const callbackLeaf = findLazyCallbackLeaf(
    state,
    usage,
    localComponents,
    sourceComponents,
    LAZY_CALLBACK_LEAF_PROOFS,
  );
  return {
    branchCallSite,
    callbackLeaf,
    descendantControlledCut,
    directCallSite,
    hasCompactBooleanTransportCut,
    hasRepeatedOwnerRenderCut,
    hasVisibilityValueTransport: transportsVisibilityProp(usage),
  };
}

function stateCommandSnapshotEvidence(
  inputs: StateClassificationInputs,
): StateCommandSnapshotEvidence {
  const { eventTransitionCallbacks, state, usage } = inputs;
  const hasFunctionalSnapshotHazard = functionalUpdaterPrecedesSnapshotRead(
    state,
    usage,
    nearestMutationFunction,
  );
  const preservesFunctionalSnapshot =
    hasFunctionalSnapshotHazard &&
    functionalCounterUpdaterPreservesSnapshot(state, usage, nearestMutationFunction);
  const hasEventCommandReadProof = hasOnlyEventCommandReads(
    state,
    EMPTY_NODES,
    eventTransitionCallbacks,
  );
  const hasCommandSnapshotHazard = refWouldChangeCommandSnapshot(
    state,
    usage,
    hasEventCommandReadProof,
  );
  return {
    hasCommandSnapshotHazard,
    hasEventCommandReadProof,
    hasFunctionalSnapshotHazard,
    preservesFunctionalSnapshot,
  };
}

function intrinsicStateVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { isPropertyLocalObjectDraft, state, usage } = context;
  if (state.setterName === null) {
    return {
      action: "keep-state",
      confidence: "certain",
      message: `Keep \`${state.valueName}\` as React state; it owns a stable component-lifetime value and has no setter.`,
    };
  }
  if (stateOnlyReceivesItsInitialPrimitive(state, usage)) {
    return {
      action: "review-state",
      confidence: "certain",
      message: `Review \`${state.valueName}\` as dead-code cleanup only; every proven write repeats its primitive initializer, so React already bails out and no render or lifecycle improvement is established.`,
    };
  }
  if (isPropertyLocalObjectDraft) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace object draft \`${state.valueName}\` with one owner-scoped observable; clone its initial object once, write each controlled property directly, subscribe at each existing property leaf and pure aggregate leaf, and clone one non-tracking whole-draft snapshot at the start of submit or commit commands.`,
    };
  }
  return null;
}

function controlledCutVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { childContracts, dialogPayloadCut, state, usage } = context;
  const filteredControlCut = controlledFilterLeafCut(state, usage, childContracts);
  if (filteredControlCut) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace filtered control state \`${state.valueName}\` with an owner-scoped observable and extract the \`${filteredControlCut.producer}\` render slot at line ${filteredControlCut.line} into one stable subscriber; move the exact filter and its repeated producer into that subscriber, pass their inputs as plain snapshots, preserve existing keys and conditional mounts, and keep the source-resolved \`${filteredControlCut.target}\` callback API unchanged.`,
    };
  }
  if (dialogPayloadCut) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: dialogPayloadCut.conditional
        ? `Replace nullable dialog payload \`${state.valueName}\` with a component-lifetime observable and replace the complete conditional ${dialogPayloadCut.consumerLabel} slot at line ${dialogPayloadCut.consumerLine} with one always-mounted stable leaf subscriber; evaluate the existing payload gate and call-free child projections there, use non-tracking snapshots in event commands, and preserve callbacks, write positions, and the dialog's conditional mount identity.`
        : `Replace nullable dialog payload \`${state.valueName}\` with a component-lifetime observable and wrap the complete always-mounted ${dialogPayloadCut.consumerLabel} call site at line ${dialogPayloadCut.consumerLine} in one stable leaf subscriber; subscribe there with \`useValue\`, use non-tracking snapshots in event commands, and preserve the existing open expression, callbacks, write positions, and mount identity.`,
    };
  }
  return null;
}

function commandLifecycleVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { isDeferredReveal, isSelfRefreshingCommand, state } = context;
  if (isSelfRefreshingCommand) {
    return {
      action: "use-ref",
      confidence: "probable",
      message: `Replace self-refreshing command snapshot \`${state.valueName}\` with a ref; keep the memoized command, effects, listener registration and cleanup in place, compare and assign through \`.current\` at the same statement positions, and remove only this snapshot from the command dependency list.`,
    };
  }
  if (isDeferredReveal) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace the one-shot reveal flag \`${state.valueName}\` with a component-lifetime observable and subscribe only in its gated leaf; keep the existing deferred scheduler and exact cleanup, changing only the scheduled write to \`.set(true)\`.`,
    };
  }
  return null;
}

function keyedSelectionVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { isKeyedLeafCollection, isKeyedLeafRecord, isKeyedLeafScalar, state } = context;
  if (isKeyedLeafCollection) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace keyed collection state \`${state.valueName}\` with a component-lifetime observable collection; extract the repeated row and subscribe there with an equivalent per-row \`useValue\` membership selector, preserve any proven filter inside the row and aggregate leaves, and read commands without subscribing.`,
    };
  }
  if (isKeyedLeafRecord) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace keyed record state \`${state.valueName}\` with a component-lifetime observable record; extract the stable-keyed row, subscribe there to only its dynamic entry with \`useValue(${state.valueName}$[rowKey])\`, and preserve every optimistic and rollback command position while replacing exact clone writes with child \`.set(...)\` and \`.delete()\` operations.`,
    };
  }
  if (isKeyedLeafScalar) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace scalar row-selection state \`${state.valueName}\` with a component-lifetime observable; extract a stable-keyed row component and subscribe with a per-item \`useValue(() => ${state.valueName}$.get() === rowDiscriminator)\` selector, while event commands read or update the cursor without subscribing.`,
    };
  }
  return null;
}

function keyedCursorVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { hasCompanionWrites, hasReturnedKeyedCursorConsumer, isKeyedScalarWithSecondary, state } =
    context;
  if (isKeyedScalarWithSecondary) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace keyed selection state \`${state.valueName}\` with a component-lifetime observable; keep repeated row events command-only, subscribe per row where equality is rendered, move selected-item or non-null projections into one footer or detail leaf, and snapshot event commands without subscribing.`,
    };
  }
  if (hasReturnedKeyedCursorConsumer && !hasCompanionWrites) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace effect-owned custom-hook cursor \`${state.valueName}\` with a component-lifetime observable; keep every effect and cleanup, use non-tracking reads in registered commands, remove cursor-only dependencies and the list \`extraData\` broadcast, and subscribe with an equality selector only in the stable-keyed row.`,
    };
  }
  return null;
}

function boundaryMoveVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { branchUnmountMove, localComponents, siblingRenderCut, sourceComponents, state, usage } =
    context;
  if (siblingRenderCut && usage.effectWrites === 0) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace \`${state.valueName}\` with a component-lifetime observable; keep the producer sibling command-only and subscribe only in the sibling ${siblingRenderCut.consumerLabel} boundary at line ${siblingRenderCut.consumerLine}, passing state-independent projection inputs as ordinary snapshots.`,
    };
  }
  if (
    branchUnmountMove &&
    (localComponents.has(branchUnmountMove.target) ||
      sourceComponents.has(branchUnmountMove.target))
  ) {
    return {
      action: "move-state-down",
      confidence: "probable",
      message: `Move React state \`${state.valueName}\` into \`${branchUnmountMove.target}\`; every read and interactive write belongs to that branch, and the owner resets it only when that branch unmounts.`,
    };
  }
  return null;
}

function unusedStateVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { state, usage } = context;
  const unusedStateDeletionConfidence = setterCallsDiscardConfidence(usage.setterCallNodes);
  const onlyCalculatesOwnSetter = stateReadsOnlyCalculateOwnSetter(state, usage);
  if (
    usage.setterCalls > 0 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.escaped &&
    !usage.shadowed &&
    !stateMayHoldCallable(state) &&
    state.call.arguments.length <= 1 &&
    (state.call.arguments[0] === undefined || isEvaluationInert(state.call.arguments[0])) &&
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    (usage.deferredReads === 0 || onlyCalculatesOwnSetter) &&
    usage.transportedOccurrences === 0 &&
    (unusedStateDeletionConfidence !== null || onlyCalculatesOwnSetter)
  ) {
    return {
      action: "delete-unused-state",
      confidence: unusedStateDeletionConfidence ?? "certain",
      message:
        unusedStateDeletionConfidence === "probable"
          ? `Delete React state \`${state.valueName}\`; replace each setter call with a \`void\` expression that evaluates the same argument at the same position, because the assigned value is never consumed but property evaluation must be preserved.`
          : `Delete React state \`${state.valueName}\` and its setter calls; assigned values are never consumed.`,
    };
  }
  return null;
}

function lazyCallbackLeafVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { hasCompanionWrites, hasReactiveMutationPath, hasSafeCommands, state, usage } = context;
  const { callbackLeaf } = context.renderCut;
  if (
    callbackLeaf &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    !hasCompanionWrites &&
    !hasReactiveMutationPath &&
    hasSafeCommands &&
    state.setterName !== null &&
    usage.setterCallNodes.some((call) =>
      mutationRegionOnlyCallsStateSetters(
        nearestMutationFunction(call, state.owner),
        new Set([state.setterName!]),
      ),
    ) &&
    usage.setterReferences > 0 &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped
  ) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace lazy-initialized state \`${state.valueName}\` with one owner-lifetime observable created exactly once from the existing initializer (do not turn the initializer into a computed); keep the current render-callback placement and setter timing, and subscribe only in the nested \`${callbackLeaf.target}\` leaf at line ${callbackLeaf.line}.`,
    };
  }
  return null;
}

function asyncStatusVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { isAsyncLeafStatus, state, usage } = context;
  if (isAsyncLeafStatus) {
    const [target] = [...usage.valueTargets];
    const callSiteCount = usage.valueTransportSites.size;
    const boundary = asyncStatusBoundaryLabel(callSiteCount, target);
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace async pending flag \`${state.valueName}\` with a component-lifetime observable and wrap ${boundary} in ${callSiteCount > 1 ? "separate leaf subscribers" : "a leaf subscriber"}; preserve the event command's async completion boundary exactly, changing only the true/false writes so pending transitions do not invalidate independent owner content.`,
    };
  }
  return null;
}

function pairedAsyncStatusVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { isCohesiveAsyncStatus, isUnprovenAsyncStatus, state } = context;
  if (isCohesiveAsyncStatus) {
    return {
      action: "keep-state",
      confidence: "certain",
      message: `Keep async pending flag \`${state.valueName}\` as React state; its exact status consumer is already the cohesive owner boundary, so an observable cannot narrow rendering.`,
    };
  }
  if (isUnprovenAsyncStatus) {
    return {
      action: "review-state",
      confidence: "probable",
      message: `Review \`${state.valueName}\`; its async pending interval and leaf boundary are proven, but source does not prove that every command runs from a deferred event. Do not publish these writes through an observable until the callback contract resolves.`,
    };
  }
  return null;
}

function stateIsTransportOnly(usage: StateUsage): boolean {
  return (
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences > 0
  );
}

function stateHasSingleTransportTarget(usage: StateUsage): boolean {
  return (
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1 &&
    !usage.repeatedValueTransport
  );
}

function stateWritesAreUntracked(usage: StateUsage): boolean {
  return !usage.setterUsesPreviousValue && !usage.shadowed && !usage.escaped;
}

function stateHasNoEffectOrDeferredUse(usage: StateUsage): boolean {
  return usage.effectReads === 0 && usage.effectWrites === 0 && usage.deferredReads === 0;
}

function transportTargetIsKnownComponent(
  usage: StateUsage,
  { localComponents, sourceComponents }: ComponentScope,
): boolean {
  const [target] = [...usage.valueTargets];
  return target !== undefined && (localComponents.has(target) || sourceComponents.has(target));
}

function controlledStateReadsAreEventOnly(usage: StateUsage): boolean {
  return (
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads > 0 &&
    usage.transportedOccurrences > 0 &&
    !usage.repeatedTransport
  );
}

function setterCallsAssignBooleanLiterals(usage: StateUsage): boolean {
  return usage.setterCallNodes.every((call) => {
    const [argument] = call.arguments;
    return (
      call.arguments.length === 1 &&
      argument !== undefined &&
      (argument.kind === ts.SyntaxKind.TrueKeyword || argument.kind === ts.SyntaxKind.FalseKeyword)
    );
  });
}

function ownerRenderCutIsMaterial(context: StateClassificationContext): boolean {
  const { state, usage } = context;
  const { hasCompactBooleanTransportCut, hasRepeatedOwnerRenderCut } = context.renderCut;
  return (
    jsxElementCount(state.owner) >= BROAD_OWNER_JSX_ELEMENTS ||
    hasCompactBooleanTransportCut ||
    (hasRepeatedOwnerRenderCut &&
      !usage.repeatedTransport &&
      usage.setterCallNodes.every((call) => nearestRepeatedRenderCall(call, state.owner) === null))
  );
}

function companionWritesAllowTransportCut(context: StateClassificationContext): boolean {
  const {
    hasCompanionWrites,
    hasIndependentDirectEventWrite,
    hasIndependentVisibilitySetterTransport,
    hasNonClosingCompanionWrites,
    hasReactiveMutationPath,
  } = context;
  const { hasVisibilityValueTransport } = context.renderCut;
  const independentWrite =
    hasIndependentDirectEventWrite || hasIndependentVisibilitySetterTransport;
  return (
    (!hasCompanionWrites ||
      (hasVisibilityValueTransport && !hasNonClosingCompanionWrites && independentWrite)) &&
    (!hasReactiveMutationPath || independentWrite)
  );
}

function compactTransportCutVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { hasSafeCommands, state, usage } = context;
  const { branchCallSite, hasCompactBooleanTransportCut, hasRepeatedOwnerRenderCut } =
    context.renderCut;
  if (
    !isCustomHookOwner(state.owner) &&
    ownerRenderCutIsMaterial(context) &&
    stateIsTransportOnly(usage) &&
    stateHasSingleTransportTarget(usage) &&
    branchCallSite !== null &&
    companionWritesAllowTransportCut(context) &&
    hasSafeCommands &&
    hasDirectPrimitiveInitializer(state) &&
    !stateMayHoldCallable(state) &&
    !setterOwnedByValueCallSite(usage, state.owner) &&
    usage.setterReferences > 0 &&
    stateWritesAreUntracked(usage)
  ) {
    const target = [...usage.valueTargets][0] ?? "the receiving child";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace \`${state.valueName}\` with a component-lifetime observable and extract one stable call-site leaf wrapper around \`${target}\` (never define it inline); subscribe there, pass the same prop snapshot, and adapt every command-only setter call or prop to mutate without subscribing.${renderCutSuffix(
        jsxElementCount(state.owner) < BROAD_OWNER_JSX_ELEMENTS && hasCompactBooleanTransportCut,
        jsxElementCount(state.owner) < BROAD_OWNER_JSX_ELEMENTS && hasRepeatedOwnerRenderCut,
      )}`,
    };
  }
  return null;
}

function descendantControlledCutVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { hasCompanionWrites, hasSafeCommands, localComponents, sourceComponents, state, usage } =
    context;
  const { branchCallSite, descendantControlledCut, directCallSite } = context.renderCut;
  if (
    !isCustomHookOwner(state.owner) &&
    jsxElementCount(state.owner) >= BROAD_OWNER_JSX_ELEMENTS &&
    stateIsTransportOnly(usage) &&
    stateHasSingleTransportTarget(usage) &&
    (descendantControlledCut ||
      transportTargetIsKnownComponent(usage, { localComponents, sourceComponents })) &&
    branchCallSite !== null &&
    (directCallSite === null || usage.unstableTransport) &&
    !hasCompanionWrites &&
    hasSafeCommands &&
    hasDirectPrimitiveInitializer(state) &&
    !stateMayHoldCallable(state) &&
    (descendantControlledCut || setterOwnedByValueTransitionCallSite(state, usage)) &&
    stateWritesAreUntracked(usage)
  ) {
    const target = [...usage.valueTargets][0] ?? "the receiving child";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace call-site-owned state \`${state.valueName}\` with a component-lifetime observable and wrap the branch-local \`${target}\` call site in a leaf subscriber; keep ownership at this owner so alternate returns and conditional mounts preserve the existing state lifetime.`,
    };
  }
  return null;
}

function visibilityTransportVerdict(context: StateClassificationContext): ClassifiedState | null {
  const {
    hasCompanionWrites,
    hasMemoizedOptionCommand,
    hasReactiveMutationPath,
    localComponents,
    sourceComponents,
    state,
    usage,
  } = context;
  const { branchCallSite } = context.renderCut;
  if (
    isLiteralBooleanLeafState(state, usage, {
      branchCallSiteExists: branchCallSite !== null,
      hasCompanionWrites,
      hasMemoizedOptionCommand,
      hasReactiveMutationPath,
      isCustomHookOwner: isCustomHookOwner(state.owner),
      localComponents,
      sourceComponents,
    })
  ) {
    const target = [...usage.valueTargets][0] ?? "the receiving child";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace boolean leaf state \`${state.valueName}\` with a component-lifetime observable and wrap the stable \`${target}\` call site in a leaf subscriber; preserve owner lifetime and change only the literal setter commands so external callbacks no longer invalidate the broad owner.`,
    };
  }
  return null;
}

function controlledLeafVerdict(context: StateClassificationContext): ClassifiedState | null {
  const {
    eventTransitionCallbacks,
    hasCompanionWrites,
    hasIndependentDirectEventWrite,
    hasSafeCommands,
    localComponents,
    sourceComponents,
    state,
    usage,
  } = context;
  const controlledLeafCut =
    !isCustomHookOwner(state.owner) &&
    !stateMayHoldCallable(state) &&
    controlledStateReadsAreEventOnly(usage) &&
    (!usage.setterUsesPreviousValue || isExactControlledArrayMembershipToggle(state, usage)) &&
    !usage.shadowed &&
    !usage.escaped &&
    (!hasCompanionWrites || hasIndependentDirectEventWrite) &&
    hasSafeCommands &&
    hasOnlyEventCommandReads(state, EMPTY_NODES, eventTransitionCallbacks) &&
    controlledLeafRenderCut(state, usage, { localComponents, sourceComponents });
  if (controlledLeafCut) {
    const target = [...usage.valueTargets][0] ?? "the controlled child";
    const controlledSubtree: ts.Node = ts.isJsxOpeningElement(controlledLeafCut.opening)
      ? controlledLeafCut.opening.parent
      : controlledLeafCut.opening;
    if (stateReferencesConfinedTo(state, controlledSubtree)) {
      return {
        action: "move-state-down",
        confidence: "probable",
        message: `Extract one stable local wrapper around \`${target}\` and move React state \`${state.valueName}\` into it; every value read and command is confined to that controlled leaf.`,
      };
    }
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace controlled state \`${state.valueName}\` with an owner-scoped observable and wrap \`${target}\` in a stable leaf subscriber; keep its value callback API unchanged and use non-tracking reads in submit or commit commands, snapshotting once at command entry before deferred work.`,
    };
  }
  return null;
}

function cohesiveControlledLeafVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { state, usage } = context;
  const cohesiveControlledLeaf = cohesiveControlledLeafOwner(state, usage);
  if (cohesiveControlledLeaf) {
    return {
      action: "keep-state",
      confidence: "certain",
      message: `Keep controlled state \`${state.valueName}\` in React; its value and setter are already confined to the cohesive \`${cohesiveControlledLeaf}\` leaf owner, so another observable subscriber would not narrow rendering.`,
    };
  }
  return null;
}

function controlledCallSiteProjectionVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const {
    eventTransitionCallbacks,
    hasCompanionWrites,
    hasIndependentDirectEventWrite,
    hasSafeCommands,
    localComponents,
    sourceComponents,
    state,
    usage,
  } = context;
  const controlledCallSiteProjection =
    !isCustomHookOwner(state.owner) &&
    !stateMayHoldCallable(state) &&
    usage.localRenderReads > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences > 0 &&
    !usage.repeatedTransport &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped &&
    (!hasCompanionWrites || hasIndependentDirectEventWrite) &&
    hasSafeCommands &&
    hasOnlyEventCommandReads(state, new Set(usage.directRenderNodes), eventTransitionCallbacks)
      ? controlledSameCallSiteProjectionCut(state, usage, { localComponents, sourceComponents })
      : null;
  if (controlledCallSiteProjection) {
    const target = [...usage.valueTargets][0] ?? "the controlled child";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace controlled state \`${state.valueName}\` with an owner-scoped observable and wrap \`${target}\` in one stable leaf subscriber; derive every state-dependent prop inside that wrapper, keep the callback API unchanged, and preserve the owner's state lifetime.`,
    };
  }
  return null;
}

function controlledProjectionCutVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const {
    eventTransitionCallbacks,
    hasCompanionWrites,
    hasIndependentDirectEventWrite,
    hasSafeCommands,
    localComponents,
    sourceComponents,
    state,
    usage,
  } = context;
  const controlledProjectionCut =
    !isCustomHookOwner(state.owner) &&
    !stateMayHoldCallable(state) &&
    usage.localRenderReads > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.transportedOccurrences > 0 &&
    !usage.repeatedTransport &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped &&
    (!hasCompanionWrites || hasIndependentDirectEventWrite) &&
    hasSafeCommands &&
    hasOnlyEventCommandReads(state, new Set(usage.directRenderNodes), eventTransitionCallbacks)
      ? controlledLeafProjectionCut(state, usage, { localComponents, sourceComponents })
      : null;
  if (controlledProjectionCut) {
    const target = [...usage.valueTargets][0] ?? "the controlled child";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace controlled state \`${state.valueName}\` with an owner-scoped observable; wrap \`${target}\` and the sibling ${controlledProjectionCut.consumerLabel} projection at line ${controlledProjectionCut.consumerLine} in stable leaf subscribers, derive validation from the subscribed value, keep the input callback API unchanged, and use non-tracking reads in event commands.`,
    };
  }
  return null;
}

function refCommandSnapshotVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { state, usage } = context;
  if (
    isCustomHookOwner(state.owner) &&
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.deferredReads === 1 &&
    usage.transportedOccurrences === 0 &&
    usage.jsxTargets.size === 0 &&
    usage.effectWrites > 0 &&
    usage.setterCalls === usage.effectWrites &&
    usage.setterReferences === usage.effectWrites &&
    !usage.shadowed &&
    !usage.escaped &&
    stateFeedsReturnedSwitchCommand(state)
  ) {
    return {
      action: "use-ref",
      confidence: "probable",
      message: `Replace effect-written command cursor \`${state.valueName}\` with a ref; preserve the effect and update its current value at the same statement positions, then read it only as the returned navigation switch discriminant.`,
    };
  }
  return null;
}

function functionalSnapshotVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { childContracts, deferredCallbackHooks, state, usage } = context;
  const {
    hasCommandSnapshotHazard,
    hasEventCommandReadProof,
    hasFunctionalSnapshotHazard,
    preservesFunctionalSnapshot,
  } = context.commandSnapshot;
  if (
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.deferredReads > 0 &&
    usage.transportedOccurrences === 0 &&
    usage.jsxTargets.size === 0 &&
    (!hasFunctionalSnapshotHazard || preservesFunctionalSnapshot) &&
    (!hasCommandSnapshotHazard || preservesFunctionalSnapshot) &&
    !stateReadCallbackEscapesThroughUnknownHook(
      state,
      deferredCallbackHooks,
      childContracts
        ? (hookName, argumentIndex, property) =>
            childContracts.callbackPropertyIsDeferred(hookName, argumentIndex, property)
        : undefined,
    ) &&
    !statePublishesReadOnlyGetter(state) &&
    !usage.shadowed &&
    !usage.escaped &&
    ((usage.eventReads === 0 && usage.effectWrites === 0) || hasEventCommandReadProof)
  ) {
    return {
      action: "use-ref",
      confidence: "probable",
      message: preservesFunctionalSnapshot
        ? `Replace \`${state.valueName}\` with a ref; inside the source-proven deferred callback, capture the ref's pre-update snapshot, evaluate the counter updater from that snapshot, and keep every later read on the captured value so the command preserves React's current ordering without rerendering.`
        : `Replace \`${state.valueName}\` with a ref; preserve any existing React lifecycle hook timing and statement order, write \`.current\` at the same setter positions${usage.setterUsesPreviousValue ? ", evaluate functional updaters against the current handle value" : ""}, read \`.current\` inside deferred commands, and remove only this value from their dependency arrays.`,
    };
  }
  return null;
}

function effectProjectionSubtreeVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { hasCompanionWrites, state, subtree } = context;
  const effectCommandProjectionSubtree =
    subtree?.kind === "effect-command-projection" ? subtree : null;
  if (effectCommandProjectionSubtree && !hasCompanionWrites) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace presentation state \`${state.valueName}\` with an owner-scoped observable, preserve the memoized command, React effect and cleanup, dependencies, and statement order, and wrap the full ${effectCommandProjectionSubtree.label} render boundary at line ${effectCommandProjectionSubtree.line} in an always-mounted leaf subscriber.`,
    };
  }
  return null;
}

function splitEffectProjectionVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { hasCompanionWrites, state, subtree } = context;
  const splitEffectProjectionSubtree = subtree?.kind === "effect-split-projection" ? subtree : null;
  if (splitEffectProjectionSubtree && !hasCompanionWrites) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace effect-written scalar \`${state.valueName}\` with an owner-scoped observable; preserve the React effect, cleanup, dependencies, calculations, and write order, then subscribe only in its ${splitEffectProjectionSubtree.leafCount ?? DEFAULT_PRESENTATION_LEAF_COUNT} bounded presentation leaves. Keep keyed repeated rows keyed and calculate each existing projection once inside its containing subscriber.`,
    };
  }
  return null;
}

function effectProjectionVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { hasCompanionWrites, state, subtree } = context;
  const effectProjectionSubtree = subtree?.kind === "effect-projection" ? subtree : null;
  if (effectProjectionSubtree && !hasCompanionWrites) {
    const selector = repeatedSubscriptionSuffix(effectProjectionSubtree);
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace effect-written presentation state \`${state.valueName}\` with an owner-scoped observable, preserve the React effect, cleanup, dependencies, and statement order, and wrap the full ${effectProjectionSubtree.label} render boundary at line ${effectProjectionSubtree.line} in an always-mounted leaf subscriber${selector}; evaluate the existing projection or gate inside that subscriber.`,
    };
  }
  return null;
}

function booleanConsumerVerdict(context: StateClassificationContext): ClassifiedState | null {
  const {
    hasAdjacentEffectBooleanConsumers,
    hasReactiveHostPropScalarConsumer,
    hasSourceEventScalarConsumers,
    state,
  } = context;
  if (hasAdjacentEffectBooleanConsumers) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace effect-written boolean \`${state.valueName}\` with one component-lifetime observable and extract its adjacent conditional presentation surfaces into one stable leaf subscriber; keep the React effect, dependencies, cleanup, boolean calculation, write position, and each existing conditional mount unchanged.`,
    };
  }
  if (hasSourceEventScalarConsumers) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace event-owned numeric state \`${state.valueName}\` with one component-lifetime observable; keep the source-proven event callback and write position unchanged, and subscribe separately in each bounded projection leaf inside the existing render branch so the broad owner and its branch condition do not subscribe.`,
    };
  }
  if (hasReactiveHostPropScalarConsumer) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace event-owned scalar state \`${state.valueName}\` with one component-lifetime observable and make its single host prop reactive; preserve the source-proven event callback, calculation, write position, host children, and mount identity so the host prop updates without rerendering the broad owner.`,
    };
  }
  return null;
}

function unsafeOwnershipVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { belongsToObservableSelection, sourceFile, state, usage } = context;
  if (usage.shadowed || usage.escaped || usage.effectWrites > 0) {
    return {
      action: "review-state",
      confidence: "probable",
      message:
        !usage.shadowed && isStructuralLegendCandidate(state, usage, sourceFile)
          ? legendCandidateMessage(state, usage)
          : `Review React state \`${state.valueName}\`; its value or setter crosses a boundary this local analysis cannot prove safe.`,
    };
  }
  if (
    usage.setterCalls > 0 &&
    usage.setterReferences === usage.legendReactionWrites &&
    usage.setterCalls === usage.legendReactionWrites &&
    usage.localRenderReads > 0
  ) {
    return {
      action: "use-value",
      confidence: "probable",
      message: `Delete the React mirror \`${state.valueName}\` and derive it with \`useValue\` from the observable read in its Legend reaction.`,
    };
  }
  if (belongsToObservableSelection && !usage.shadowed) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace the selection hook's React state cluster with one observable model; expose observable fields and subscribe per row or control with \`useValue\`.`,
    };
  }
  return null;
}

function confinedSubtreeVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { hasCompanionWrites, state, subtree } = context;
  const directSubtree = subtree?.kind === "direct" ? subtree : null;
  if (directSubtree && !hasCompanionWrites) {
    if (directSubtree.repeated) {
      return {
        action: "use-observable",
        confidence: "probable",
        message: `Replace \`${state.valueName}\` with a component-lifetime observable and subscribe with a per-item \`useValue\` selector inside the repeated row under the ${directSubtree.label} subtree at line ${directSubtree.line}; do not subscribe the list owner.`,
      };
    }
    if (directSubtree.unstable) {
      return {
        action: "use-observable",
        confidence: "probable",
        message: `Replace \`${state.valueName}\` with a component-lifetime observable, extract the ${directSubtree.label} subtree at line ${directSubtree.line} into a leaf wrapper, and subscribe there with \`useValue\`; keeping ownership here preserves conditional mount lifetime.`,
      };
    }
    return {
      action: "move-state-down",
      confidence: "probable",
      message: `Extract the ${directSubtree.label} subtree at line ${directSubtree.line} into a leaf component and move \`${state.valueName}\` into it; every read and command is confined to that stable subtree.`,
    };
  }
  return null;
}

function gatedSubtreeVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { hasCompanionWrites, state, subtree, usage } = context;
  const projectionSubtree = subtree?.kind === "projection" ? subtree : null;
  const gateSubtree = subtree?.kind === "gate" ? subtree : null;
  if (gateSubtree && !hasCompanionWrites) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace \`${state.valueName}\` with a component-lifetime observable and replace the full state-controlled render expression at the ${gateSubtree.label} boundary on line ${gateSubtree.line} with one always-mounted leaf subscriber; evaluate the complete gate and its selected content inside that wrapper so an initially hidden child can still open.`,
    };
  }
  if (projectionSubtree && !hasCompanionWrites) {
    const selector = repeatedSubscriptionSuffix(projectionSubtree);
    return {
      action: "use-observable",
      confidence: "probable",
      message:
        usage.transportedOccurrences > 0
          ? `Replace \`${state.valueName}\` with a component-lifetime observable and wrap the ${projectionSubtree.label} call site at line ${projectionSubtree.line} in a leaf subscriber${selector}; subscribe to the raw value once, pass that snapshot unchanged, derive every existing projection from the same snapshot, and leave the child API unchanged.`
          : `Replace \`${state.valueName}\` with a component-lifetime observable and wrap the ${projectionSubtree.label} call site at line ${projectionSubtree.line} in a leaf subscriber${selector}; evaluate its existing pure projections inside that wrapper and leave the child API unchanged.`,
    };
  }
  return null;
}

function multiSurfaceVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { hasAdjacentEventBooleanConsumers, hasMultiSurfaceBooleanConsumers, state } = context;
  if (hasAdjacentEventBooleanConsumers) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace event-computed boolean \`${state.valueName}\` with one component-lifetime observable and extract its adjacent conditional presentation surfaces into one stable leaf subscriber; keep the event callback, boolean calculation, write position, and each existing conditional mount unchanged, while passing state-independent inputs as ordinary props.`,
    };
  }
  if (hasMultiSurfaceBooleanConsumers) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace event-owned boolean \`${state.valueName}\` with one component-lifetime observable; keep the existing event callbacks and write positions, use reactive props for the proven class/style projections, use \`Show\` only at the bounded conditional presentation leaves, and do not subscribe the large owner.`,
    };
  }
  return null;
}

function wideOwnerTransportVerdict(context: StateClassificationContext): ClassifiedState | null {
  const {
    hasCompanionWrites,
    hasReactiveMutationPath,
    hasSafeCommands,
    localComponents,
    sourceFile,
    state,
    usage,
  } = context;
  if (
    ownerLineSpan(state.owner, sourceFile) >= WIDE_OWNER_LINE_SPAN &&
    jsxElementCount(state.owner) >= BROAD_OWNER_JSX_ELEMENTS &&
    !stateMayHoldCallable(state) &&
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences > 0 &&
    usage.valueTargets.size === 1 &&
    localComponents.has([...usage.valueTargets][0] ?? "") &&
    usage.setterReferences > 0 &&
    hasSafeCommands &&
    !hasCompanionWrites &&
    !hasReactiveMutationPath &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped
  ) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace \`${state.valueName}\` with \`useObservable\` at this owner and subscribe with \`useValue\` only in the transported leaf consumers.`,
    };
  }
  return null;
}

function delayedPendingVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { ownerObservableSubscriptions, state, usage } = context;
  if (isCohesiveDelayedPendingState(state, usage)) {
    return {
      action: "keep-state",
      confidence: "certain",
      message: `Keep \`${state.valueName}\` as React state; its cohesive button owner intentionally delays the pending transition and clears that timer before the final reset.`,
    };
  }
  if (usage.localRenderReads > 0) {
    if (
      isCustomHookOwner(state.owner) ||
      jsxElementCount(state.owner) >= SMALL_OWNER_JSX_ELEMENTS
    ) {
      const boundary = isCustomHookOwner(state.owner)
        ? "its unknown hook consumers"
        : `this owner with ${jsxElementCount(state.owner)} JSX elements`;
      const competing = competingSubscriptionsNote(ownerObservableSubscriptions);
      return {
        action: "review-state",
        confidence: "probable",
        message: `Legend-first restructuring candidate: replace \`${state.valueName}\` with observable ownership and move its subscription into the smallest rendered subtree; updates currently invalidate ${boundary}.${competing}`,
      };
    }
    return {
      action: "keep-state",
      confidence: "certain",
      message: `Keep \`${state.valueName}\` as React state for now; its owner is already a small render boundary.`,
    };
  }
  return null;
}

function renderReadVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { sourceComponents, sourceFile, state, usage } = context;
  if (
    usage.repeatedTransport &&
    usage.deferredReads === 0 &&
    usage.setterCalls === 0 &&
    !stateMayHoldCallable(state)
  ) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace \`${state.valueName}\` with \`useObservable\` and subscribe in the transported leaves so updates do not invalidate this owner.`,
    };
  }
  if (usage.jsxTargets.size > 1) {
    return {
      action: "review-state",
      confidence: "probable",
      message: isStructuralLegendCandidate(state, usage, sourceFile)
        ? legendCandidateMessage(state, usage, sourceComponents)
        : `Review React state \`${state.valueName}\`; it fans out to multiple leaves, but local evidence does not prove that observable transport beats a smaller React boundary.`,
    };
  }
  return null;
}

function singleTargetTransportVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { hasCompanionWrites, state, usage } = context;
  if (
    !isCustomHookOwner(state.owner) &&
    jsxElementCount(state.owner) >= BROAD_OWNER_JSX_ELEMENTS &&
    !stateMayHoldCallable(state) &&
    usage.transportedOccurrences > 0 &&
    usage.jsxTargets.size === 1 &&
    usage.effectReads === 0 &&
    usage.deferredReads === 0 &&
    usage.valueTargets.size === 1 &&
    usage.valueTransportSites.size === 1 &&
    setterOwnedByValueTransitionCallSite(state, usage) &&
    directUniqueReturnCallSite(usage, state.owner) !== null &&
    !hasCompanionWrites &&
    usage.effectWrites === 0 &&
    !usage.unstableTransport &&
    !usage.shadowed &&
    !usage.escaped
  ) {
    const [target] = usage.jsxTargets;
    return {
      action: "move-state-down",
      confidence: "probable",
      message: `Extract one stable local wrapper around \`${target ?? "the receiving child"}\` and move \`${state.valueName}\` into it; this broad owner only transports the value and setter to that leaf.`,
    };
  }
  return null;
}

interface VerifiedLeafRenderProp {
  readonly propName: string;
  readonly target: string;
}

function verifiedLeafRenderProp(
  usage: StateUsage,
  childContracts: ChildContractResolver,
): VerifiedLeafRenderProp | null {
  const [target] = [...usage.jsxTargets];
  if (target === undefined) {
    return null;
  }
  const propNames = usage.valueProps.get(target);
  const [propName] = propNames?.size === 1 ? [...propNames] : [];
  const child = childContracts.resolveComponent(target);
  if (propName === undefined || !child || !propIsLeafRenderConsumer(child, propName)) {
    return null;
  }
  return { propName, target };
}

function broadTransportVerdict(context: StateClassificationContext): ClassifiedState | null {
  const { childContracts, hasReactiveMutationPath, hasSafeCommands, state, usage } = context;
  const ownerCallSite = stableOwnerLevelCallSite(usage, state.owner);
  if (
    childContracts &&
    usage.jsxTargets.size === 1 &&
    usage.localRenderReads === 0 &&
    ownerCallSite !== null &&
    hasSafeCommands &&
    !hasReactiveMutationPath &&
    stateHasNoEffectOrDeferredUse(usage) &&
    usage.setterCalls >= 1 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.repeatedTransport &&
    stateWritesAreUntracked(usage) &&
    !stateMayHoldCallable(state) &&
    !callSiteIsKeyed(ownerCallSite) &&
    setterCallsAssignBooleanLiterals(usage)
  ) {
    const leafProp = verifiedLeafRenderProp(usage, childContracts);
    if (leafProp) {
      return {
        action: "use-observable",
        confidence: "probable",
        message: `Replace \`${state.valueName}\` with a component-lifetime observable and wrap the stable \`${leafProp.target}\` call site in a leaf subscriber; subscribe once with \`useValue\`, pass the same plain value, and leave the child API unchanged. The child contract is verified: \`${leafProp.target}\` renders the \`${leafProp.propName}\` value directly and owns none of its lifecycle.`,
      };
    }
  }
  return null;
}

function residualStateVerdict(context: StateClassificationContext): ClassifiedState {
  const { sourceComponents, sourceFile, state, usage } = context;
  return {
    action: "review-state",
    confidence: "probable",
    message:
      isStructuralLegendCandidate(state, usage, sourceFile) ||
      [...usage.jsxTargets].some((target) => sourceComponents.has(target))
        ? legendCandidateMessage(state, usage, sourceComponents)
        : `Review React state \`${state.valueName}\`; local evidence does not prove a render-boundary improvement.`,
  };
}

const STATE_VERDICTS: readonly StateVerdict[] = [
  intrinsicStateVerdict,
  controlledCutVerdict,
  commandLifecycleVerdict,
  keyedSelectionVerdict,
  keyedCursorVerdict,
  boundaryMoveVerdict,
  unusedStateVerdict,
  lazyCallbackLeafVerdict,
  asyncStatusVerdict,
  pairedAsyncStatusVerdict,
  compactTransportCutVerdict,
  descendantControlledCutVerdict,
  visibilityTransportVerdict,
  controlledLeafVerdict,
  cohesiveControlledLeafVerdict,
  controlledCallSiteProjectionVerdict,
  controlledProjectionCutVerdict,
  refCommandSnapshotVerdict,
  functionalSnapshotVerdict,
  effectProjectionSubtreeVerdict,
  splitEffectProjectionVerdict,
  effectProjectionVerdict,
  booleanConsumerVerdict,
  unsafeOwnershipVerdict,
  confinedSubtreeVerdict,
  gatedSubtreeVerdict,
  multiSurfaceVerdict,
  wideOwnerTransportVerdict,
  delayedPendingVerdict,
  renderReadVerdict,
  singleTargetTransportVerdict,
  broadTransportVerdict,
];

function classifyState(inputs: StateClassificationInputs): ClassifiedState {
  const context: StateClassificationContext = {
    ...inputs,
    commandSnapshot: stateCommandSnapshotEvidence(inputs),
    renderCut: stateRenderCutEvidence(inputs),
  };
  for (const verdict of STATE_VERDICTS) {
    const classified = verdict(context);
    if (classified) {
      return classified;
    }
  }
  return residualStateVerdict(context);
}

function stateIsTransportedFilterTerm(state: StateCandidate, usage: StateUsage): boolean {
  return (
    state.setterName !== null &&
    ts.isStringLiteralLike(unwrapTransparentExpression(state.call.arguments[0] ?? state.call)) &&
    usage.setterReferences === 1 &&
    usage.setterCalls === 0 &&
    usage.setterTransportSites.size === 1 &&
    usage.setterTargets.size === 1 &&
    usage.valueTransportSites.size === 0 &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    !usage.shadowed
  );
}

function readOnlyFilterResultReferences(
  state: StateCandidate,
  filter: ExactStringFilter,
): readonly ts.Identifier[] | null {
  const references = bindingReferences(state.owner, filter.resultName.text, filter.resultName);
  if (
    references.length === 0 ||
    references.some((reference) => !isReadOnlyFilteredResultReference(reference, state.owner))
  ) {
    return null;
  }
  return references;
}

function controlledFilterLeafCut(
  state: StateCandidate,
  usage: StateUsage,
  childContracts: ChildContractResolver | null,
): ControlledFilterLeafCut | null {
  if (!childContracts || !stateIsTransportedFilterTerm(state, usage)) {
    return null;
  }
  const setterTransport = deferredSetterTransport(state, childContracts);
  const filter = setterTransport ? soleReadOnlyStringFilter(state) : null;
  const resultReferences = filter ? readOnlyFilterResultReferences(state, filter) : null;
  if (!setterTransport || !filter || !resultReferences) {
    return null;
  }
  const slot = repeatedProducerRenderCut(state, filter, [
    setterTransport.reference,
    ...resultReferences,
  ]);
  return slot
    ? {
        line:
          slot.node.getSourceFile().getLineAndCharacterOfPosition(slot.node.getStart()).line + 1,
        producer: slot.producer,
        target: setterTransport.target,
      }
    : null;
}

function deferredSetterTransport(
  state: StateCandidate,
  childContracts: ChildContractResolver,
): SetterTransport | null {
  const setterTransport = directSetterTransport(state);
  if (
    !setterTransport ||
    !childContracts.componentCallbackPropIsDeferred(
      setterTransport.target,
      setterTransport.attribute.name.getText(),
    )
  ) {
    return null;
  }
  return setterTransport;
}

function soleReadOnlyStringFilter(state: StateCandidate): ExactStringFilter | null {
  const reads = stateValueReferences(state);
  const filter = reads.length === 1 ? exactStringFilter(reads[0]!, state.owner) : null;
  return filter && collectionBindingIsReadOnly(filter.sourceName, state.owner) ? filter : null;
}

interface RepeatedProducerSlot {
  readonly node: ts.Node;
  readonly producer: string;
}

function repeatedProducerRenderCut(
  state: StateCandidate,
  filter: ExactStringFilter,
  references: readonly ts.Node[],
): RepeatedProducerSlot | null {
  const repeated = commonContainingRepeatedRender(references, state.owner);
  const producer = repeated ? repeatedRenderBinding(repeated, state.owner) : null;
  const producerReferences = producer
    ? bindingReferences(state.owner, producer.text, producer)
    : [];
  const slot =
    producerReferences.length === 1
      ? directReturnedJsxSlot(producerReferences[0]!, state.owner)
      : null;
  const ownerElements = jsxElementCount(state.owner);
  const producerElements = repeated ? jsxElementCountIn(repeated) : ownerElements;
  if (
    !repeated ||
    !producer ||
    !slot ||
    ownerElements < BROAD_OWNER_JSX_ELEMENTS ||
    ownerElements - producerElements < MIN_OWNER_RENDER_CUT_ELEMENTS ||
    renderCollectionWorkOutside(state.owner, repeated, filter.call) < MIN_COLLECTION_RENDER_WORK
  ) {
    return null;
  }
  return { node: slot, producer: producer.text };
}

interface SetterTransport {
  readonly attribute: ts.JsxAttribute;
  readonly reference: ts.Identifier;
  readonly target: string;
}

function directSetterTransport(state: StateCandidate): SetterTransport | null {
  if (!state.setterName || !state.owner.body) {
    return null;
  }
  const matches: {
    attribute: ts.JsxAttribute;
    reference: ts.Identifier;
    target: string;
  }[] = [];
  visit(state.owner.body, (node) => {
    if (
      !ts.isIdentifier(node) ||
      node.text !== state.setterName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
    const target = attribute ? jsxTargetName(attribute) : null;
    if (attribute && target && isDirectJsxAttributeExpression(attribute, node)) {
      matches.push({ attribute, reference: node, target });
    }
  });
  return matches.length === 1 ? matches[0]! : null;
}

function stateValueReferences(state: StateCandidate): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(state.owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === state.valueName &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node) &&
      node.parent !== state.call.parent
    ) {
      references.push(node);
    }
  });
  return references;
}

interface ExactStringFilter {
  readonly call: ts.CallExpression;
  readonly resultName: ts.Identifier;
  readonly sourceName: ts.Identifier;
}

function caseInsensitiveIncludesPredicate(
  stateRead: ts.Identifier,
  owner: RuntimeFunctionLike,
): ts.ArrowFunction | null {
  const includesCall = stateRead.parent;
  if (
    !ts.isCallExpression(includesCall) ||
    includesCall.arguments.length !== 1 ||
    includesCall.arguments[0] !== stateRead ||
    !ts.isPropertyAccessExpression(includesCall.expression) ||
    includesCall.expression.name.text !== "includes"
  ) {
    return null;
  }
  const lowerCall = toLowerCaseCall(includesCall.expression.expression);
  const callback = lowerCall ? findAncestorUntil(includesCall, isRuntimeFunctionLike, owner) : null;
  const parameter = callback?.parameters[0]?.name;
  if (
    !lowerCall ||
    !callback ||
    !ts.isArrowFunction(callback) ||
    ts.isBlock(callback.body) ||
    !parameter ||
    !ts.isIdentifier(parameter) ||
    !staticPropertyChainStartsAt(lowerCall.expression.expression, parameter) ||
    !isPureExpression(callback.body, (call) => call === includesCall || call === lowerCall)
  ) {
    return null;
  }
  return callback;
}

interface ToLowerCaseCall extends ts.CallExpression {
  readonly expression: ts.PropertyAccessExpression;
}

function toLowerCaseCall(expression: ts.Expression): ToLowerCaseCall | null {
  const call = unwrapTransparentExpression(expression);
  if (
    !ts.isCallExpression(call) ||
    call.arguments.length > 0 ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "toLowerCase"
  ) {
    return null;
  }
  // SAFETY: the guard above proves `call` is a zero-argument `.toLowerCase()` property-access call.
  return call as ToLowerCaseCall;
}

function uniqueFilterSourceName(
  filterCall: ts.Node,
  callback: ts.ArrowFunction,
  owner: RuntimeFunctionLike,
): ts.Identifier | null {
  const source =
    ts.isCallExpression(filterCall) && ts.isPropertyAccessExpression(filterCall.expression)
      ? unwrapTransparentExpression(filterCall.expression.expression)
      : null;
  if (
    !ts.isCallExpression(filterCall) ||
    filterCall.arguments.length !== 1 ||
    filterCall.arguments[0] !== callback ||
    !ts.isPropertyAccessExpression(filterCall.expression) ||
    filterCall.expression.name.text !== "filter" ||
    !source ||
    !ts.isIdentifier(source) ||
    bindingDeclarationCount(owner, source.text) !== 1
  ) {
    return null;
  }
  return source;
}

function uniqueConstResultName(
  filterCall: ts.CallExpression,
  owner: RuntimeFunctionLike,
): ts.Identifier | null {
  const result = filterCall.parent;
  if (
    !ts.isVariableDeclaration(result) ||
    result.initializer !== filterCall ||
    !ts.isIdentifier(result.name) ||
    !ts.isVariableDeclarationList(result.parent) ||
    (result.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, result.name.text) !== 1
  ) {
    return null;
  }
  return result.name;
}

function exactStringFilter(
  stateRead: ts.Identifier,
  owner: RuntimeFunctionLike,
): ExactStringFilter | null {
  const callback = caseInsensitiveIncludesPredicate(stateRead, owner);
  if (!callback) {
    return null;
  }
  const filterCall = callback.parent;
  const sourceName = uniqueFilterSourceName(filterCall, callback, owner);
  if (!sourceName || !ts.isCallExpression(filterCall)) {
    return null;
  }
  const resultName = uniqueConstResultName(filterCall, owner);
  return resultName ? { call: filterCall, resultName, sourceName } : null;
}

const READ_ONLY_COLLECTION_METHODS = new Set([
  "at",
  "concat",
  "entries",
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "flatMap",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "reduce",
  "reduceRight",
  "slice",
  "some",
  "toReversed",
  "toSorted",
  "toSpliced",
  "values",
]);
const RENDER_COLLECTION_WORK_METHODS = new Set([
  "concat",
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "slice",
  "some",
  "toReversed",
  "toSorted",
  "toSpliced",
]);

function collectionBindingIsReadOnly(
  declaration: ts.Identifier,
  owner: RuntimeFunctionLike,
): boolean {
  return bindingReferences(owner, declaration.text, declaration).every((reference) => {
    const access = reference.parent;
    if (!ts.isPropertyAccessExpression(access) || access.expression !== reference) {
      return false;
    }
    if (access.name.text === "length" || access.name.text === "size") {
      return true;
    }
    return (
      READ_ONLY_COLLECTION_METHODS.has(access.name.text) &&
      ts.isCallExpression(access.parent) &&
      access.parent.expression === access
    );
  });
}

function staticPropertyChainStartsAt(expression: ts.Expression, root: ts.Identifier): boolean {
  let current = unwrapTransparentExpression(expression);
  while (ts.isPropertyAccessExpression(current)) {
    current = unwrapTransparentExpression(current.expression);
  }
  return ts.isIdentifier(current) && current.text === root.text;
}

function commonContainingRepeatedRender(
  nodes: readonly ts.Node[],
  owner: RuntimeFunctionLike,
): ts.CallExpression | null {
  const [first] = nodes;
  if (!first) {
    return null;
  }
  for (
    let current: ts.Node | undefined = first;
    current && current !== owner;
    current = current.parent
  ) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ["map", "flatMap"].includes(current.expression.name.text) &&
      nodes.every((node) => nodeWithin(node, current))
    ) {
      return current;
    }
  }
  return null;
}

function repeatedRenderBinding(
  repeated: ts.CallExpression,
  owner: RuntimeFunctionLike,
): ts.Identifier | null {
  const declaration = repeated.parent;
  return ts.isVariableDeclaration(declaration) &&
    declaration.initializer === repeated &&
    ts.isIdentifier(declaration.name) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    bindingDeclarationCount(owner, declaration.name.text) === 1
    ? declaration.name
    : null;
}

function directReturnedJsxSlot(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
): ts.Identifier | null {
  const expression = findAncestorUntil(reference, ts.isJsxExpression, owner);
  const returned = uniqueReturnedExpression(owner);
  return expression?.expression &&
    (ts.isJsxElement(expression.parent) || ts.isJsxFragment(expression.parent)) &&
    unwrapTransparentExpression(expression.expression) === reference &&
    returned &&
    nodeWithin(expression, returned) &&
    nearestNestedFunction(reference, owner) === null
    ? reference
    : null;
}

function renderCollectionWorkOutside(
  owner: RuntimeFunctionLike,
  repeated: ts.CallExpression,
  movedFilter: ts.CallExpression,
): number {
  const { body } = owner;
  if (!body || !ts.isBlock(body)) {
    return 0;
  }
  let count = 0;
  visitSkippingNestedRuntimeFunctions(body, (node) => {
    if (
      ts.isCallExpression(node) &&
      isUnconditionalOwnerLevelCall(node, { body, movedFilter, owner, repeated }) &&
      isCollectionWorkCall(node)
    ) {
      count += 1;
    }
  });
  return count;
}

interface OwnerLevelCallScope {
  readonly body: ts.Block;
  readonly movedFilter: ts.CallExpression;
  readonly owner: RuntimeFunctionLike;
  readonly repeated: ts.CallExpression;
}

function isUnconditionalOwnerLevelCall(
  node: ts.CallExpression,
  { body, movedFilter, owner, repeated }: OwnerLevelCallScope,
): boolean {
  const declaration = findAncestorUntil(node, ts.isVariableDeclaration, owner);
  const statement = declaration?.parent.parent;
  return (
    node !== movedFilter &&
    node.questionDotToken === undefined &&
    !nodeWithin(node, repeated) &&
    node.getStart() < repeated.getStart() &&
    declaration !== null &&
    statement !== undefined &&
    ts.isVariableStatement(statement) &&
    statement.parent === body &&
    !isConditionallyEvaluatedWithin(node, declaration)
  );
}

function isCollectionWorkCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken !== undefined) {
    return false;
  }
  if (RENDER_COLLECTION_WORK_METHODS.has(callee.name.text)) {
    return true;
  }
  const receiver = unwrapTransparentExpression(callee.expression);
  return callee.name.text === "from" && ts.isIdentifier(receiver) && receiver.text === "Array";
}

function isConditionallyEvaluatedWithin(node: ts.Node, boundary: ts.Node): boolean {
  for (let current = node.parent; current && current !== boundary; current = current.parent) {
    if (
      ts.isConditionalExpression(current) ||
      (ts.isBinaryExpression(current) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(current.operatorToken.kind)) ||
      (ts.isCallExpression(current) && current.questionDotToken !== undefined) ||
      (ts.isPropertyAccessExpression(current) && current.questionDotToken !== undefined)
    ) {
      return true;
    }
  }
  return false;
}

function bindingReferences(
  owner: RuntimeFunctionLike,
  name: string,
  declaration: ts.Identifier,
): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node !== declaration &&
      node.text === name &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references;
}

function isReadOnlyFilteredResultReference(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
): boolean {
  const access = reference.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== reference) {
    return false;
  }
  if (access.name.text === "length") {
    return Boolean(findAncestorUntil(access, isJsxNode, owner));
  }
  if (access.name.text !== "map" || !ts.isCallExpression(access.parent)) {
    return false;
  }
  const [callback] = access.parent.arguments;
  return (
    callback !== undefined &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    Boolean(findAncestorUntil(access, isJsxNode, owner))
  );
}

function repeatedSubscriptionSuffix(subtree: StateSubtree): string {
  if (subtree.uniqueRepeatedBranch) {
    return " inside its uniquely selected branch";
  }
  return subtree.repeated ? " with a per-item selector" : "";
}

function isCohesiveDelayedPendingState(state: StateCandidate, usage: StateUsage): boolean {
  if (!stateIsCompactRenderedPendingFlag(state, usage)) {
    return false;
  }
  const pending = usage.setterCallNodes.find(
    (call) => call.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword,
  );
  const reset = usage.setterCallNodes.find(
    (call) => call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword,
  );
  if (!pending || !reset) {
    return false;
  }
  return pendingWriteIsTimedAndCleared(pending, reset, state.owner);
}

function stateIsCompactRenderedPendingFlag(state: StateCandidate, usage: StateUsage): boolean {
  return (
    state.call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword &&
    jsxElementCount(state.owner) <= SMALL_OWNER_JSX_ELEMENTS &&
    usage.localRenderReads > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    stateHasNoEffectOrDeferredUse(usage) &&
    usage.transportedOccurrences === 0 &&
    usage.setterCallNodes.length === PAIRED_SETTER_CALLS &&
    usage.setterReferences === usage.setterCalls &&
    !usage.shadowed &&
    !usage.escaped
  );
}

function pendingWriteIsTimedAndCleared(
  pending: ts.CallExpression,
  reset: ts.CallExpression,
  owner: RuntimeFunctionLike,
): boolean {
  const timerDeclaration = scheduledPendingTimerDeclaration(pending, owner);
  const timerCall = timerDeclaration?.initializer;
  const command = timerCall ? nearestMutationFunction(timerCall, owner) : null;
  if (!timerDeclaration || !command || !isAsyncEventCommand(command, owner)) {
    return false;
  }
  const tryStatement = findAncestorUntil(reset, ts.isTryStatement, command);
  if (!tryStatement || !finallyClearsTimer(tryStatement, { reset, timerDeclaration })) {
    return false;
  }
  return blockAwaits(tryStatement.tryBlock);
}

function blockAwaits(block: ts.Block): boolean {
  let awaits = false;
  visitSkippingNestedRuntimeFunctions(block, (node) => {
    awaits ||= ts.isAwaitExpression(node);
  });
  return awaits;
}

function scheduledPendingTimerDeclaration(
  pending: ts.CallExpression,
  owner: RuntimeFunctionLike,
): ts.VariableDeclaration | null {
  const scheduled = nearestNestedFunction(pending, owner);
  if (!scheduled || !ts.isArrowFunction(scheduled) || !scheduledSetterIsExact(scheduled, pending)) {
    return null;
  }
  const timerCall = scheduled.parent;
  if (
    !ts.isCallExpression(timerCall) ||
    timerCall.arguments[0] !== scheduled ||
    !isNamedCall(timerCall, "setTimeout")
  ) {
    return null;
  }
  const timerDeclaration = timerCall.parent;
  if (
    !ts.isVariableDeclaration(timerDeclaration) ||
    timerDeclaration.initializer !== timerCall ||
    !ts.isIdentifier(timerDeclaration.name) ||
    !ts.isVariableDeclarationList(timerDeclaration.parent) ||
    (timerDeclaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  return timerDeclaration;
}

function isAsyncEventCommand(command: RuntimeFunctionLike, owner: RuntimeFunctionLike): boolean {
  return (
    command !== owner &&
    (ts.isArrowFunction(command) ||
      ts.isFunctionDeclaration(command) ||
      ts.isFunctionExpression(command)) &&
    command.body !== undefined &&
    ts.isBlock(command.body) &&
    (command.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ??
      false) &&
    callbackIsEventRooted(command, owner, "", new Set())
  );
}

interface PendingTimerCleanup {
  readonly reset: ts.CallExpression;
  readonly timerDeclaration: ts.VariableDeclaration;
}

function finallyClearsTimer(
  tryStatement: ts.TryStatement,
  { reset, timerDeclaration }: PendingTimerCleanup,
): boolean {
  const finalizer = tryStatement.finallyBlock;
  if (
    !finalizer ||
    finalizer.statements.length !== PAIRED_FINALIZER_STATEMENTS ||
    !ts.isExpressionStatement(finalizer.statements[0]!) ||
    !ts.isExpressionStatement(finalizer.statements[1]!) ||
    unwrapTransparentExpression(finalizer.statements[1]!.expression) !== reset
  ) {
    return false;
  }
  const clear = unwrapTransparentExpression(finalizer.statements[0]!.expression);
  return (
    ts.isCallExpression(clear) &&
    isNamedCall(clear, "clearTimeout") &&
    clear.arguments.length === 1 &&
    ts.isIdentifier(clear.arguments[0]!) &&
    clear.arguments[0]!.text === timerDeclaration.name.getText()
  );
}

function scheduledSetterIsExact(callback: ts.ArrowFunction, setter: ts.CallExpression): boolean {
  if (!ts.isBlock(callback.body)) {
    return unwrapTransparentExpression(callback.body) === setter;
  }
  const [statement] = callback.body.statements;
  return (
    callback.body.statements.length === 1 &&
    statement !== undefined &&
    ts.isExpressionStatement(statement) &&
    unwrapTransparentExpression(statement.expression) === setter
  );
}

function isNamedCall(call: ts.CallExpression, name: string): boolean {
  const callee = call.expression;
  return ts.isIdentifier(callee)
    ? callee.text === name
    : ts.isPropertyAccessExpression(callee) && callee.name.text === name;
}

function setterCallsConfinedToValueSubtree(
  usage: StateUsage,
  body: ts.Node,
  valueSite: number,
): boolean {
  const opening = firstDirectJsxOpeningAt(body, valueSite);
  if (!opening) {
    return false;
  }
  const subtree = jsxSubtreeForOpening(opening);
  return usage.setterCallNodes.every((call) => nodeWithin(call, subtree));
}

function setterOwnedByValueCallSite(usage: StateUsage, owner: RuntimeFunctionLike): boolean {
  const [valueSite] = [...usage.valueTransportSites];
  if (valueSite === undefined || usage.setterReferences === 0) {
    return false;
  }
  const transportsSetterAtValueSite =
    usage.setterTargets.size === 1 &&
    usage.setterTransportSites.size === 1 &&
    [...usage.setterTransportSites][0] === valueSite;
  if (
    transportsSetterAtValueSite &&
    usage.setterCalls === 0 &&
    [...usage.valueTargets][0] === [...usage.setterTargets][0]
  ) {
    return true;
  }
  if (
    !usage.escaped &&
    (usage.setterReferences === usage.setterCalls || transportsSetterAtValueSite) &&
    usage.setterCallNodes.length > 0 &&
    owner.body &&
    setterCallsConfinedToValueSubtree(usage, owner.body, valueSite)
  ) {
    return true;
  }
  return (
    usage.setterReferences === usage.setterCalls &&
    usage.setterCallNodes.length > 0 &&
    usage.setterCallNodes.every((call) => {
      const attribute = findAncestorUntil(call, ts.isJsxAttribute, owner);
      return attribute !== null && jsxTransportSite(attribute) === valueSite;
    })
  );
}

function setterOwnedByValueTransitionCallSite(state: StateCandidate, usage: StateUsage): boolean {
  const { setterName } = state;
  if (!setterName || !setterOwnedByValueCallSite(usage, state.owner)) {
    return false;
  }
  if (usage.setterCalls > 0) {
    return usage.setterCallNodes.every((call) => setterCallIsValueTransition(call, state));
  }
  const [valueSite] = [...usage.valueTransportSites];
  if (valueSite === undefined || !state.owner.body) {
    return false;
  }
  const opening = firstDirectJsxOpeningAt(state.owner.body, valueSite);
  return (
    opening !== null &&
    hasDirectInteractionSetter(opening, setterName, (name) =>
      isValueTransitionAttribute(opening, name, state.valueName),
    )
  );
}

function setterCallIsValueTransition(call: ts.CallExpression, state: StateCandidate): boolean {
  const attribute = findAncestorUntil(call, ts.isJsxAttribute, state.owner);
  const opening = attribute?.parent.parent;
  return (
    attribute !== null &&
    opening !== undefined &&
    (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) &&
    isValueTransitionAttribute(opening, attribute.name.getText(), state.valueName)
  );
}

interface ComponentScope {
  readonly localComponents: ReadonlySet<string>;
  readonly sourceComponents: ReadonlySet<string>;
}

function controlledLeafRenderCut(
  state: StateCandidate,
  usage: StateUsage,
  { localComponents, sourceComponents }: ComponentScope,
): {
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  returned: ts.Expression;
} | null {
  const callSite = controlledLeafCallSite(state, usage, isValueTransitionProp);
  if (!callSite) {
    return null;
  }
  const controlled = callSite.opening;
  const controlledSubtree: ts.Node = ts.isJsxOpeningElement(controlled)
    ? controlled.parent
    : controlled;
  return hasIndependentRenderCutWitness(
    callSite.returned,
    [controlledSubtree],
    localComponents,
    sourceComponents,
  )
    ? callSite
    : null;
}

function controlledProjectionConsumer(
  state: StateCandidate,
  usage: StateUsage,
): JsxSubtreeNode | null {
  const references = controlledProjectionRenderReferences(state, usage);
  if (
    !references ||
    references.some((reference) => nearestRepeatedRenderCall(reference, state.owner) !== null)
  ) {
    return null;
  }
  const consumer = lowestCommonJsxSubtree(references, state.owner);
  if (
    !consumer ||
    jsxElementCountIn(consumer) / jsxElementCount(state.owner) > MAX_LEAF_SUBTREE_RATIO
  ) {
    return null;
  }
  return consumer;
}

function controlledLeafProjectionCut(
  state: StateCandidate,
  usage: StateUsage,
  { localComponents, sourceComponents }: ComponentScope,
): ControlledProjectionCut | null {
  const callSite = controlledLeafCallSite(state, usage);
  if (!callSite) {
    return null;
  }
  const consumer = controlledProjectionConsumer(state, usage);
  if (!consumer) {
    return null;
  }
  const controlled: ts.Node = ts.isJsxOpeningElement(callSite.opening)
    ? callSite.opening.parent
    : callSite.opening;
  if (
    controlled === consumer ||
    nodeWithin(controlled, consumer) ||
    nodeWithin(consumer, controlled) ||
    !shareUniqueOwnerReturn(controlled, consumer, state.owner) ||
    !hasIndependentRenderCutWitness(
      callSite.returned,
      [controlled, consumer],
      localComponents,
      sourceComponents,
    )
  ) {
    return null;
  }
  return {
    consumerLabel: jsxSubtreeLabel(consumer),
    consumerLine:
      consumer.getSourceFile().getLineAndCharacterOfPosition(consumer.getStart()).line + 1,
  };
}

function controlledSameCallSiteProjectionCut(
  state: StateCandidate,
  usage: StateUsage,
  { localComponents, sourceComponents }: ComponentScope,
): boolean {
  const callSite = controlledLeafCallSite(state, usage, isValueTransitionProp);
  if (!callSite) {
    return false;
  }
  const references = controlledProjectionRenderReferences(state, usage);
  if (
    !references ||
    references.some(
      (reference) =>
        !nodeWithin(reference, callSite.opening) ||
        nearestRepeatedRenderCall(reference, state.owner) !== null,
    )
  ) {
    return false;
  }
  const controlled: ts.Node = ts.isJsxOpeningElement(callSite.opening)
    ? callSite.opening.parent
    : callSite.opening;
  return hasIndependentRenderCutWitness(
    callSite.returned,
    [controlled],
    localComponents,
    sourceComponents,
  );
}

function cohesiveControlledLeafOwner(state: StateCandidate, usage: StateUsage): string | null {
  if (
    isCustomHookOwner(state.owner) ||
    stateMayHoldCallable(state) ||
    usage.localRenderReads !== 0 ||
    usage.effectReads !== 0 ||
    usage.effectWrites !== 0 ||
    usage.deferredReads !== 0 ||
    usage.transportedOccurrences === 0 ||
    usage.repeatedTransport ||
    usage.shadowed ||
    usage.escaped
  ) {
    return null;
  }
  const directCallSite = directUniqueReturnCallSite(usage, state.owner);
  if (!directCallSite) {
    return null;
  }
  const controlled: ts.Node = ts.isJsxOpeningElement(directCallSite.opening)
    ? directCallSite.opening.parent
    : directCallSite.opening;
  if (
    jsxElementCount(state.owner) !== jsxElementCountIn(controlled) ||
    !stateReferencesConfinedTo(state, controlled)
  ) {
    return null;
  }
  return [...usage.valueTargets][0] ?? "controlled child";
}

function controlledLeafCallSite(
  state: StateCandidate,
  usage: StateUsage,
  isInteractionProp: (name: string) => boolean = isControlledInteractionProp,
): {
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  returned: ts.Expression;
} | null {
  if (
    !state.owner.body ||
    !state.setterName ||
    ownerHasRefBackedRenderRead(state.owner) ||
    usage.valueTransportSites.size !== 1 ||
    usage.valueTargets.size !== 1 ||
    !usage.setterCallNodes.every((call) => {
      const callback = nearestNestedFunction(call, state.owner);
      return callback !== null && !isSynchronousRenderCallback(callback);
    })
  ) {
    return null;
  }
  const callSite =
    directUniqueReturnCallSite(usage, state.owner) ??
    directBranchReturnCallSite(usage, state.owner);
  if (!callSite) {
    return null;
  }
  const isStateInteractionProp = (name: string): boolean =>
    isInteractionProp(name) || isPairedSetterProp(callSite.opening, name, state.valueName);
  if (
    !hasDirectInteractionSetter(callSite.opening, state.setterName, isStateInteractionProp) &&
    !hasInlineInteractionSetter(callSite.opening, state, {
      isInteractionProp: isStateInteractionProp,
      usage,
    }) &&
    !hasInteractionSetterAdapter(callSite.opening, state, {
      isInteractionProp: isStateInteractionProp,
      usage,
    })
  ) {
    return null;
  }
  return callSite;
}

function stateReferencesConfinedTo(state: StateCandidate, boundary: ts.Node): boolean {
  if (!state.owner.body) {
    return false;
  }
  let confined = true;
  visit(state.owner.body, (node) => {
    if (
      !confined ||
      !ts.isIdentifier(node) ||
      (node.text !== state.valueName && node.text !== state.setterName) ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (!nodeWithin(node, boundary)) {
      confined = false;
    }
  });
  return confined;
}

function ownerHasRefBackedRenderRead(owner: RuntimeFunctionLike): boolean {
  if (!owner.body) {
    return false;
  }
  let found = false;
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (!found && ts.isPropertyAccessExpression(node) && node.name.text === "current") {
      found = true;
    }
  });
  return found;
}

function controlledProjectionRenderReferences(
  state: StateCandidate,
  usage: StateUsage,
): readonly ts.Identifier[] | null {
  const references = oneHopRenderProjectionReferences(state.owner, usage.directRenderNodes);
  if (!references) {
    return null;
  }
  if (
    references.some((reference) => classifyProjectionReference(reference, state.owner) === "unsafe")
  ) {
    return null;
  }
  const renderReferences = references.filter(
    (reference) => classifyProjectionReference(reference, state.owner) === "render",
  );
  return renderReferences.length > 0 ? renderReferences : null;
}

type ProjectionReferenceRole = "event" | "render" | "unsafe";

function classifyProjectionReference(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
): ProjectionReferenceRole {
  if (findAncestorUntil(reference, ts.isJsxAttribute, owner)) {
    return isSafeJsxProjectionReference(reference, owner) ? "render" : "unsafe";
  }
  return referenceIsEventRooted(reference, owner) ? "event" : "unsafe";
}

function referenceIsEventRooted(reference: ts.Identifier, owner: RuntimeFunctionLike): boolean {
  const callback = nearestNestedFunction(reference, owner);
  if (
    !callback ||
    (!ts.isArrowFunction(callback) &&
      !ts.isFunctionDeclaration(callback) &&
      !ts.isFunctionExpression(callback))
  ) {
    return false;
  }
  return callbackIsEventRooted(callback, owner, reference.text, new Set());
}

function hasDirectInteractionSetter(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  setterName: string,
  isInteractionProp: (name: string) => boolean = isControlledInteractionProp,
): boolean {
  return opening.attributes.properties.some(
    (attribute) =>
      ts.isJsxAttribute(attribute) &&
      isInteractionProp(attribute.name.getText()) &&
      attribute.initializer !== undefined &&
      ts.isJsxExpression(attribute.initializer) &&
      attribute.initializer.expression !== undefined &&
      ts.isIdentifier(attribute.initializer.expression) &&
      attribute.initializer.expression.text === setterName,
  );
}

interface InteractionSetterOptions {
  readonly isInteractionProp?: (name: string) => boolean;
  readonly usage: StateUsage;
}

function hasInlineInteractionSetter(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  state: StateCandidate,
  options: InteractionSetterOptions,
): boolean {
  const { isInteractionProp = isControlledInteractionProp, usage } = options;
  if (!state.setterName || usage.setterCalls === 0 || usage.setterTransportSites.size > 0) {
    return false;
  }
  return usage.setterCallNodes.some((call) =>
    callIsSoleInlineHandlerBody(call, { isInteractionProp, opening, state }),
  );
}

interface InlineHandlerScope {
  readonly isInteractionProp: (name: string) => boolean;
  readonly opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  readonly state: StateCandidate;
}

function inlineHandlerCallback(
  call: ts.CallExpression,
  { isInteractionProp, opening, state }: InlineHandlerScope,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const attribute = findAncestorUntil(call, ts.isJsxAttribute, state.owner);
  if (
    !attribute ||
    !isInteractionProp(attribute.name.getText()) ||
    attribute.parent?.parent !== opening ||
    !attribute.initializer ||
    !ts.isJsxExpression(attribute.initializer)
  ) {
    return null;
  }
  const callback = attribute.initializer.expression;
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return null;
  }
  return callback;
}

function callIsSoleInlineHandlerBody(call: ts.CallExpression, scope: InlineHandlerScope): boolean {
  if (call.arguments.some((argument) => containsCallExpression(argument))) {
    return false;
  }
  const callback = inlineHandlerCallback(call, scope);
  if (!callback || nearestNestedFunction(call, scope.state.owner) !== callback) {
    return false;
  }
  return callbackBodyIsSoleCall(callback.body, call);
}

function callbackBodyIsSoleCall(body: ts.ConciseBody, call: ts.CallExpression): boolean {
  if (ts.isCallExpression(body)) {
    return body === call;
  }
  if (!ts.isBlock(body) || body.statements.length !== 1) {
    return false;
  }
  const [statement] = body.statements;
  return (
    statement !== undefined && ts.isExpressionStatement(statement) && statement.expression === call
  );
}

function stateHasSoleAdapterWrite(state: StateCandidate, usage: StateUsage): boolean {
  const [call] = usage.setterCallNodes;
  return (
    state.setterName !== null &&
    usage.setterReferences === 1 &&
    usage.setterCalls === 1 &&
    usage.setterCallNodes.length === 1 &&
    usage.setterTransportSites.size === 0 &&
    call !== undefined &&
    (!call.arguments.some((argument) => containsCallExpression(argument)) ||
      isExactControlledArrayMembershipToggle(state, usage))
  );
}

function hasInteractionSetterAdapter(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  state: StateCandidate,
  options: InteractionSetterOptions,
): boolean {
  const { isInteractionProp = isControlledInteractionProp, usage } = options;
  const [call] = usage.setterCallNodes;
  if (!call || !stateHasSoleAdapterWrite(state, usage)) {
    return false;
  }
  const callback = producerBoundAdapter(call, state, opening);
  const name = callback ? localCallbackBindingName(callback) : null;
  if (!callback || !name || !openingBindsInteractionCallback(opening, name, isInteractionProp)) {
    return false;
  }
  return callback.body !== undefined && callbackBodyIsSoleCall(callback.body, call);
}

function producerBoundAdapter(
  call: ts.CallExpression,
  state: StateCandidate,
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
): ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null {
  const callback = nearestMutationFunction(call, state.owner);
  if (
    callback === state.owner ||
    (!ts.isArrowFunction(callback) &&
      !ts.isFunctionDeclaration(callback) &&
      !ts.isFunctionExpression(callback)) ||
    jsxProducerForSetterCall(call, state.owner) !== opening
  ) {
    return null;
  }
  return callback;
}

function openingBindsInteractionCallback(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
  isInteractionProp: (name: string) => boolean,
): boolean {
  return opening.attributes.properties.some(
    (attribute) =>
      ts.isJsxAttribute(attribute) &&
      isInteractionProp(attribute.name.getText()) &&
      attribute.initializer !== undefined &&
      ts.isJsxExpression(attribute.initializer) &&
      attribute.initializer.expression !== undefined &&
      ts.isIdentifier(attribute.initializer.expression) &&
      attribute.initializer.expression.text === name,
  );
}

function soleSnapshotUpdater(
  setterCall: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const updater = setterCall.arguments[0] && unwrapTransparentExpression(setterCall.arguments[0]);
  if (
    !updater ||
    (!ts.isArrowFunction(updater) && !ts.isFunctionExpression(updater)) ||
    updater.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    updater.asteriskToken ||
    updater.parameters.length !== 1 ||
    !ts.isIdentifier(updater.parameters[0]!.name)
  ) {
    return null;
  }
  return updater;
}

function isExactControlledArrayMembershipToggle(state: StateCandidate, usage: StateUsage): boolean {
  if (
    usage.setterCalls !== 1 ||
    usage.setterReferences !== 1 ||
    usage.setterCallNodes.length !== 1
  ) {
    return false;
  }
  const setterCall = usage.setterCallNodes[0]!;
  const updater = soleSnapshotUpdater(setterCall);
  const previous = updater ? updater.parameters[0]!.name.getText() : null;
  const toggle = updater ? arrayMembershipToggle(updater) : null;
  const value = toggle && previous ? arrayMembershipValue(toggle.condition, previous) : null;
  if (!toggle || !previous || !value) {
    return false;
  }
  return (
    adapterTakesToggleValue(setterCall, state.owner, value) &&
    isArrayMembershipRemoval(toggle.whenPresent, previous, value) &&
    isArrayMembershipAppend(toggle.whenAbsent, previous, value)
  );
}

function adapterTakesToggleValue(
  setterCall: ts.CallExpression,
  owner: RuntimeFunctionLike,
  value: string,
): boolean {
  const adapter = nearestMutationFunction(setterCall, owner);
  return (
    adapter !== owner &&
    adapter.parameters.some(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === value,
    )
  );
}

interface MembershipToggleBranches {
  readonly condition: ts.Expression;
  readonly whenAbsent: ts.Expression;
  readonly whenPresent: ts.Expression;
}

function soleIfStatement(body: ts.ConciseBody): ts.IfStatement | null {
  if (!ts.isBlock(body) || body.statements.length !== 1) {
    return null;
  }
  const [statement] = body.statements;
  if (!statement || !ts.isIfStatement(statement) || !statement.elseStatement) {
    return null;
  }
  return statement;
}

function arrayMembershipToggle(
  updater: ts.ArrowFunction | ts.FunctionExpression,
): MembershipToggleBranches | null {
  const expression = returnedCallbackExpression(updater);
  if (expression && ts.isConditionalExpression(expression)) {
    return {
      condition: expression.condition,
      whenAbsent: expression.whenFalse,
      whenPresent: expression.whenTrue,
    };
  }
  const statement = soleIfStatement(updater.body);
  if (!statement?.elseStatement) {
    return null;
  }
  const whenPresent = returnedStatementExpression(statement.thenStatement);
  const whenAbsent = returnedStatementExpression(statement.elseStatement);
  return whenPresent && whenAbsent
    ? { condition: statement.expression, whenAbsent, whenPresent }
    : null;
}

function returnedStatementExpression(statement: ts.Statement): ts.Expression | null {
  const returned = soleReturnStatement(statement);
  return returned?.expression ? unwrapTransparentExpression(returned.expression) : null;
}

function soleReturnStatement(statement: ts.Statement): ts.ReturnStatement | null {
  if (!ts.isBlock(statement)) {
    return ts.isReturnStatement(statement) ? statement : null;
  }
  const [only] = statement.statements;
  if (statement.statements.length !== 1 || !only || !ts.isReturnStatement(only)) {
    return null;
  }
  return only;
}

function returnedCallbackExpression(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | null {
  if (!ts.isBlock(callback.body)) {
    return unwrapTransparentExpression(callback.body);
  }
  const [statement] = callback.body.statements;
  return callback.body.statements.length === 1 &&
    statement !== undefined &&
    ts.isReturnStatement(statement) &&
    statement.expression !== undefined
    ? unwrapTransparentExpression(statement.expression)
    : null;
}

function arrayMembershipValue(condition: ts.Expression, previous: string): string | null {
  const value = unwrapTransparentExpression(condition);
  if (
    !ts.isCallExpression(value) ||
    value.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(value.expression) ||
    value.expression.name.text !== "includes" ||
    !isIdentifierNamed(value.expression.expression, previous)
  ) {
    return null;
  }
  const member = unwrapTransparentExpression(value.arguments[0]!);
  return ts.isIdentifier(member) ? member.text : null;
}

function isArrayMembershipRemoval(
  expression: ts.Expression,
  previous: string,
  value: string,
): boolean {
  const removal = unwrapTransparentExpression(expression);
  if (
    !ts.isCallExpression(removal) ||
    removal.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(removal.expression) ||
    removal.expression.name.text !== "filter" ||
    !isIdentifierNamed(removal.expression.expression, previous)
  ) {
    return false;
  }
  const predicate = unwrapTransparentExpression(removal.arguments[0]!);
  if (
    (!ts.isArrowFunction(predicate) && !ts.isFunctionExpression(predicate)) ||
    predicate.parameters.length !== 1 ||
    !ts.isIdentifier(predicate.parameters[0]!.name)
  ) {
    return false;
  }
  const item = predicate.parameters[0]!.name.text;
  const comparison = returnedCallbackExpression(predicate);
  return (
    comparison !== null &&
    ts.isBinaryExpression(comparison) &&
    comparison.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    isIdentifierNamed(comparison.left, item) &&
    isIdentifierNamed(comparison.right, value)
  );
}

function isArrayMembershipAppend(
  expression: ts.Expression,
  previous: string,
  value: string,
): boolean {
  const append = unwrapTransparentExpression(expression);
  if (!ts.isArrayLiteralExpression(append) || append.elements.length !== KEY_VALUE_TUPLE_LENGTH) {
    return false;
  }
  const [spread, member] = append.elements;
  return (
    spread !== undefined &&
    ts.isSpreadElement(spread) &&
    isIdentifierNamed(spread.expression, previous) &&
    member !== undefined &&
    !ts.isSpreadElement(member) &&
    isIdentifierNamed(member, value)
  );
}

function isIdentifierNamed(expression: ts.Expression, name: string): boolean {
  const value = unwrapTransparentExpression(expression);
  return ts.isIdentifier(value) && value.text === name;
}

function isValueTransitionAttribute(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
  valueName: string,
): boolean {
  return isValueTransitionProp(name) || isPairedSetterProp(opening, name, valueName);
}

function isVisibilityTransitionAttribute(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
  valueName: string,
): boolean {
  if (/^on(?:Open|Visible|Visibility)Change$/u.test(name)) {
    return true;
  }
  if (!isPairedSetterProp(opening, name, valueName)) {
    return false;
  }
  return opening.attributes.properties.some(
    (attribute) =>
      ts.isJsxAttribute(attribute) &&
      /^(?:isOpen|isVisible|open|visible)$/u.test(attribute.name.getText()) &&
      attribute.initializer !== undefined &&
      ts.isJsxExpression(attribute.initializer) &&
      attribute.initializer.expression !== undefined &&
      ts.isIdentifier(attribute.initializer.expression) &&
      attribute.initializer.expression.text === valueName,
  );
}

function isPairedSetterProp(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement | undefined,
  name: string,
  valueName: string,
): boolean {
  const setter = /^set(?<suffix>[A-Z][A-Za-z0-9]*)$/u.exec(name)?.groups?.suffix;
  if (!opening || !setter) {
    return false;
  }
  const normalizedSetter = normalizeStatePropName(setter);
  return opening.attributes.properties.some((attribute) => {
    if (
      !ts.isJsxAttribute(attribute) ||
      !attribute.initializer ||
      !ts.isJsxExpression(attribute.initializer) ||
      !attribute.initializer.expression ||
      !ts.isIdentifier(attribute.initializer.expression) ||
      attribute.initializer.expression.text !== valueName
    ) {
      return false;
    }
    return normalizeStatePropName(attribute.name.getText()) === normalizedSetter;
  });
}

function normalizeStatePropName(name: string): string {
  return name.replace(/^is(?=[A-Z])/u, "").toLowerCase();
}

interface DirectReturnCallSite {
  readonly opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  readonly returned: ts.Expression;
}

function directUniqueReturnCallSite(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
): DirectReturnCallSite | null {
  const callSite = directBranchReturnCallSite(usage, owner);
  return callSite && uniqueReturnedExpression(owner) ? callSite : null;
}

function setterCallEndsCommand(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const command = nearestMutationFunction(call, owner);
  if (!command.body) {
    return false;
  }
  if (!ts.isBlock(command.body)) {
    return unwrapTransparentExpression(command.body) === call;
  }
  const statement = call.parent;
  return (
    ts.isExpressionStatement(statement) &&
    statement.expression === call &&
    statement.parent === command.body &&
    command.body.statements.at(-1) === statement
  );
}

function uniqueReturnedExpression(owner: RuntimeFunctionLike): ts.Expression | null {
  if (!owner.body) {
    return null;
  }
  const expressions: ts.Expression[] = [];
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      expressions.push(node.expression);
    }
  });
  return expressions.length === 1 ? expressions[0]! : null;
}

function directBranchReturnCallSite(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
): DirectReturnCallSite | null {
  const [valueSite] = [...usage.valueTransportSites];
  if (!owner.body || valueSite === undefined || usage.repeatedValueTransport) {
    return null;
  }
  const opening = firstDirectJsxOpeningAt(owner.body, valueSite);
  return opening ? directlyReturnedCallSite(opening, owner) : null;
}

function firstDirectJsxOpeningAt(
  body: ts.Node,
  position: number,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const openings: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  visitSkippingNestedRuntimeFunctions(body, (node) => {
    if (
      openings.length === 0 &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.getStart() === position
    ) {
      openings.push(node);
    }
  });
  return openings[0] ?? null;
}

function directlyReturnedCallSite(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  owner: RuntimeFunctionLike,
): DirectReturnCallSite | null {
  for (
    let current: ts.Node | undefined = opening.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (ts.isVariableDeclaration(current) || isRuntimeFunctionLike(current)) {
      return null;
    }
    if (ts.isReturnStatement(current)) {
      return current.expression && nodeWithin(opening, current.expression)
        ? { opening, returned: current.expression }
        : null;
    }
  }
  return null;
}

function setterCallsDiscardConfidence(
  calls: readonly ts.CallExpression[],
): "certain" | "probable" | null {
  let confidence: "certain" | "probable" = "certain";
  for (const call of calls) {
    const callConfidence = setterCallDiscardConfidence(call);
    if (!callConfidence) {
      return null;
    }
    if (callConfidence === "probable") {
      confidence = "probable";
    }
  }
  return confidence;
}

function setterCallDiscardConfidence(call: ts.CallExpression): "certain" | "probable" | null {
  const [argument] = call.arguments;
  if (call.arguments.length !== 1 || !argument) {
    return null;
  }
  return discardableExpressionConfidence(argument);
}

function stateReadsOnlyCalculateOwnSetter(state: StateCandidate, usage: StateUsage): boolean {
  if (
    usage.effectWrites > 0 ||
    usage.setterCallNodes.length === 0 ||
    usage.setterCallNodes.some(
      (call) =>
        nearestMutationFunction(call, state.owner) === state.owner ||
        call.arguments.length !== 1 ||
        !call.arguments[0] ||
        !isEvaluationInert(call.arguments[0]),
    )
  ) {
    return false;
  }

  let reads = 0;
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    reads += 1;
    safe = usage.setterCallNodes.some(
      (call) => call.arguments[0] !== undefined && nodeWithin(node, call.arguments[0]),
    );
  });
  return safe && reads > 0;
}

function stateOnlyReceivesItsInitialPrimitive(state: StateCandidate, usage: StateUsage): boolean {
  const [initializer] = state.call.arguments;
  if (
    !initializer ||
    usage.setterCallNodes.length === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.shadowed ||
    usage.escaped
  ) {
    return false;
  }
  return usage.setterCallNodes.every(
    (call) =>
      call.arguments.length === 1 &&
      call.arguments[0] !== undefined &&
      samePrimitiveLiteral(initializer, call.arguments[0]),
  );
}

function samePrimitiveLiteral(left: ts.Expression, right: ts.Expression): boolean {
  const leftValue = unwrapTransparentExpression(left);
  const rightValue = unwrapTransparentExpression(right);
  if (leftValue.kind !== rightValue.kind) {
    return false;
  }
  if (
    leftValue.kind === ts.SyntaxKind.NullKeyword ||
    leftValue.kind === ts.SyntaxKind.TrueKeyword ||
    leftValue.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return true;
  }
  return (ts.isStringLiteralLike(leftValue) && ts.isStringLiteralLike(rightValue)) ||
    (ts.isNumericLiteral(leftValue) && ts.isNumericLiteral(rightValue)) ||
    (ts.isBigIntLiteral(leftValue) && ts.isBigIntLiteral(rightValue))
    ? leftValue.text === rightValue.text
    : false;
}

function discardableExpressionConfidence(node: ts.Expression): "certain" | "probable" | null {
  if (isEvaluationInert(node)) {
    return "certain";
  }
  const value = unwrapTransparentExpression(node);
  if (ts.isPropertyAccessExpression(value)) {
    return discardableExpressionConfidence(value.expression) ? "probable" : null;
  }
  if (ts.isArrayLiteralExpression(value)) {
    return combineDiscardConfidence(
      value.elements.map((element) =>
        ts.isSpreadElement(element) ? null : discardableExpressionConfidence(element),
      ),
    );
  }
  if (ts.isObjectLiteralExpression(value)) {
    return combineDiscardConfidence(
      value.properties.map((property) => {
        if (ts.isShorthandPropertyAssignment(property)) {
          return "certain";
        }
        return ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name)
          ? discardableExpressionConfidence(property.initializer)
          : null;
      }),
    );
  }
  return null;
}

function combineDiscardConfidence(
  confidences: readonly ("certain" | "probable" | null)[],
): "certain" | "probable" | null {
  if (confidences.some((confidence) => confidence === null)) {
    return null;
  }
  return confidences.some((confidence) => confidence === "probable") ? "probable" : "certain";
}

interface StateSubtree {
  kind:
    | "direct"
    | "effect-command-projection"
    | "effect-projection"
    | "effect-split-projection"
    | "gate"
    | "projection";
  leafCount?: number;
  label: string;
  line: number;
  node: JsxSubtreeNode;
  repeated: boolean;
  uniqueRepeatedBranch: boolean;
  unstable: boolean;
}

interface StateSubtreeOptions {
  readonly childContracts: ChildContractResolver | null;
  readonly directEffectCalls: ReadonlySet<ts.CallExpression>;
  readonly effectOwnedMemoizedCommand: boolean;
  readonly projectionAllowed: boolean;
  readonly pureProjectionImports: ReadonlySet<string>;
}

function isEffectWrittenPresentation(
  usage: StateUsage,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
): boolean {
  return (
    usage.effectWrites > 0 &&
    usage.effectWrites === usage.setterCalls &&
    usage.setterReferences === usage.setterCalls &&
    usage.setterCallNodes.every((call) => hasAncestorInSet(call, directEffectCalls)) &&
    usage.deferredReads === 0 &&
    !usage.setterUsesPreviousValue
  );
}

interface SubtreeEligibility {
  readonly effectWrittenPresentation: boolean;
  readonly ownerJsx: number;
  readonly splitEffectProjection: StateSubtree | null;
}

function stateRendersFromBoundedSubtree(
  state: StateCandidate,
  usage: StateUsage,
  { effectWrittenPresentation, ownerJsx, splitEffectProjection }: SubtreeEligibility,
): boolean {
  return (
    (ownerJsx >= COMPACT_OWNER_JSX_ELEMENTS || effectWrittenPresentation) &&
    !stateMayHoldCallable(state) &&
    usage.directRenderNodes.length > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.setterCallNodes.length > 0 &&
    usage.setterReferences === usage.setterCalls &&
    usage.effectReads === 0 &&
    (usage.effectWrites === 0 || effectWrittenPresentation) &&
    (usage.deferredReads === 0 || hasOnlyEventCommandReads(state)) &&
    !usage.shadowed &&
    (!usage.escaped || splitEffectProjection !== null)
  );
}

function renderProjectionNodes(
  state: StateCandidate,
  usage: StateUsage,
  effectWrittenPresentation: boolean,
): readonly ts.Node[] {
  if (effectWrittenPresentation) {
    return (
      multipleOneHopRenderProjectionReferences(state.owner, usage.directRenderNodes) ??
      usage.directRenderNodes
    );
  }
  return (
    boundedRenderProjectionReferences(state.owner, usage.directRenderNodes) ??
    oneHopRenderProjectionReferences(state.owner, usage.directRenderNodes) ??
    usage.directRenderNodes
  );
}

function analyzeStateSubtree(
  state: StateCandidate,
  usage: StateUsage,
  options: StateSubtreeOptions,
): StateSubtree | null {
  const { directEffectCalls, pureProjectionImports } = options;
  const ownerJsx = jsxElementCount(state.owner);
  const effectWrittenPresentation = isEffectWrittenPresentation(usage, directEffectCalls);
  const splitEffectProjection = effectWrittenPresentation
    ? effectSplitProjectionSubtree(state, usage, { ownerJsx, pureProjectionImports })
    : null;
  if (
    !stateRendersFromBoundedSubtree(state, usage, {
      effectWrittenPresentation,
      ownerJsx,
      splitEffectProjection,
    })
  ) {
    return null;
  }
  return (
    splitEffectProjection ??
    renderSubtreeFor(state, usage, { ...options, effectWrittenPresentation, ownerJsx })
  );
}

interface RenderSubtreeScope extends StateSubtreeOptions {
  readonly effectWrittenPresentation: boolean;
  readonly ownerJsx: number;
}

function renderSubtreeFor(
  state: StateCandidate,
  usage: StateUsage,
  scope: RenderSubtreeScope,
): StateSubtree | null {
  const { effectWrittenPresentation, ownerJsx, projectionAllowed } = scope;
  const projectionNodes = renderProjectionNodes(state, usage, effectWrittenPresentation);
  const renderReadsInNestedCallbacks = projectionNodes.some(
    (node) => nearestNestedFunction(node, state.owner) !== null,
  );
  const allowsDirectSubtree =
    !effectWrittenPresentation &&
    usage.transportedOccurrences === 0 &&
    projectionAllowed &&
    !renderReadsInNestedCallbacks;
  return (
    (allowsDirectSubtree ? directRenderSubtree(state, usage, ownerJsx) : null) ??
    projectionSubtreeFor(state, usage, {
      ...scope,
      allowedProjectionCalls: projectionCallAllowlist(state, scope, effectWrittenPresentation),
      projectionNodes,
      renderReadsInNestedCallbacks,
      uniqueRepeatedProjection: isUniquelySelectedRepeatedProjection(projectionNodes, state.owner),
    })
  );
}

function projectionCallAllowlist(
  state: StateCandidate,
  { pureProjectionImports }: StateSubtreeOptions,
  effectWrittenPresentation: boolean,
): ReadonlySet<string> {
  if (!effectWrittenPresentation) {
    return EMPTY_BINDINGS;
  }
  return new Set(
    [...pureProjectionImports].filter((name) => !ownerDeclaresBinding(state.owner, name)),
  );
}

function directRenderSubtree(
  state: StateCandidate,
  usage: StateUsage,
  ownerJsx: number,
): StateSubtree | null {
  const directNodes = [...usage.directRenderNodes, ...usage.setterCallNodes];
  const direct = lowestCommonJsxSubtree(directNodes, state.owner);
  if (!direct) {
    return null;
  }
  const subtreeJsx = jsxElementCountIn(direct);
  if (
    ownerJsx < BROAD_OWNER_JSX_ELEMENTS ||
    subtreeJsx < MIN_LEAF_SUBTREE_ELEMENTS ||
    subtreeJsx / ownerJsx > MAX_LEAF_SUBTREE_RATIO
  ) {
    return null;
  }
  return stateSubtreeResult("direct", direct, { renderNodes: directNodes, state });
}

interface ProjectionSubtreeScope extends StateSubtreeOptions {
  readonly allowedProjectionCalls: ReadonlySet<string>;
  readonly effectWrittenPresentation: boolean;
  readonly ownerJsx: number;
  readonly projectionNodes: readonly ts.Node[];
  readonly renderReadsInNestedCallbacks: boolean;
  readonly uniqueRepeatedProjection: boolean;
}

function isSafeJsxChildProjection(
  state: StateCandidate,
  usage: StateUsage,
  { childContracts, directEffectCalls, projectionNodes }: ProjectionSubtreeScope,
): boolean {
  return (
    sharesJsxChildRenderCallback(projectionNodes, state.owner) &&
    projectionWritesAreDeferred(usage, state.owner, { childContracts, directEffectCalls })
  );
}

function projectionSubtreeFor(
  state: StateCandidate,
  usage: StateUsage,
  scope: ProjectionSubtreeScope,
): StateSubtree | null {
  const {
    effectOwnedMemoizedCommand,
    effectWrittenPresentation,
    ownerJsx,
    projectionAllowed,
    projectionNodes,
    renderReadsInNestedCallbacks,
    uniqueRepeatedProjection,
  } = scope;
  const gateProjection = renderReadsInNestedCallbacks
    ? null
    : commonRenderGateSubtree(projectionNodes, state.owner);
  if (!projectionAllowed || !projectionAcceptsNodes(state, usage, { ...scope, gateProjection })) {
    return null;
  }
  const projection = gateProjection ?? lowestCommonJsxSubtree(projectionNodes, state.owner);
  if (
    !projection ||
    !isMaterialStateSubtree(projection, ownerJsx, {
      effectWrittenPresentation,
      uniqueRepeatedProjection,
    }) ||
    (usage.transportedOccurrences > 0 &&
      !isSafeMixedProjectionTransport(state, usage, {
        allowNestedSite: effectWrittenPresentation,
        common: projection,
      }))
  ) {
    return null;
  }
  return stateSubtreeResult(
    projectionSubtreeKind(
      effectOwnedMemoizedCommand,
      effectWrittenPresentation,
      Boolean(gateProjection),
    ),
    projection,
    { renderNodes: projectionNodes, state, uniqueRepeatedBranch: uniqueRepeatedProjection },
  );
}

function projectionAcceptsNodes(
  state: StateCandidate,
  usage: StateUsage,
  scope: ProjectionSubtreeScope & { readonly gateProjection: JsxSubtreeNode | null },
): boolean {
  const { gateProjection } = scope;
  const {
    allowedProjectionCalls,
    effectWrittenPresentation,
    projectionNodes,
    renderReadsInNestedCallbacks,
    uniqueRepeatedProjection,
  } = scope;
  const safeProjectionReferences = projectionNodes.every(
    (node) =>
      isSafeJsxProjectionReference(node, state.owner, allowedProjectionCalls) ||
      (effectWrittenPresentation && isSafeEffectPresentationReference(node, state.owner)),
  );
  if (!safeProjectionReferences && !gateProjection) {
    return false;
  }
  return (
    !renderReadsInNestedCallbacks ||
    isKeyedRepeatedProjection(projectionNodes, state.owner) ||
    uniqueRepeatedProjection ||
    isSafeJsxChildProjection(state, usage, scope)
  );
}

function projectionSubtreeKind(
  effectOwnedMemoizedCommand: boolean,
  effectWrittenPresentation: boolean,
  isGateProjection: boolean,
): StateSubtree["kind"] {
  if (effectOwnedMemoizedCommand) {
    return "effect-command-projection";
  }
  if (effectWrittenPresentation) {
    return "effect-projection";
  }
  return isGateProjection ? "gate" : "projection";
}

interface DeferredProjectionScope {
  readonly childContracts: ChildContractResolver | null;
  readonly directEffectCalls: ReadonlySet<ts.CallExpression>;
}

function projectionWritesAreDeferred(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
  { childContracts, directEffectCalls }: DeferredProjectionScope,
): boolean {
  return usage.setterCallNodes.every((call) =>
    setterWriteIsDeferred(call, owner, { childContracts, directEffectCalls }),
  );
}

interface EventHandlerAttributeTarget {
  readonly prop: string;
  readonly target: string;
}

function eventHandlerAttributeTarget(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): EventHandlerAttributeTarget | null {
  const callback = nearestMutationFunction(call, owner);
  const attribute =
    callback === owner ? null : findAncestorUntil(callback, ts.isJsxAttribute, owner);
  const prop = attribute?.name.getText() ?? null;
  const target = attribute ? jsxTargetName(attribute) : null;
  if (!prop || !target || !/^on[A-Z]/u.test(prop)) {
    return null;
  }
  return { prop, target };
}

function setterWriteIsDeferred(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
  { childContracts, directEffectCalls }: DeferredProjectionScope,
): boolean {
  if (ancestorCallInSet(call, directEffectCalls, owner)) {
    return true;
  }
  const handler = eventHandlerAttributeTarget(call, owner);
  if (!handler) {
    return false;
  }
  if (!isCustomJsxTarget(handler.target)) {
    return true;
  }
  return (
    childContracts?.frameworkEventComponent(handler.target) === true ||
    childContracts?.componentCallbackPropIsDeferred(handler.target, handler.prop) === true
  );
}

function sharedNestedCallback(
  nodes: readonly ts.Node[],
  owner: RuntimeFunctionLike,
): ts.ArrowFunction | ts.FunctionExpression | null {
  let common: ts.ArrowFunction | ts.FunctionExpression | null = null;
  for (const node of nodes) {
    const callback = nearestNestedFunction(node, owner);
    if (
      !callback ||
      (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
      (common !== null && common !== callback)
    ) {
      return null;
    }
    common = callback;
  }
  return common;
}

function outermostTransparentExpression(expression: ts.Expression): ts.Expression {
  let outermost = expression;
  while (
    (ts.isParenthesizedExpression(outermost.parent) ||
      ts.isAsExpression(outermost.parent) ||
      ts.isTypeAssertionExpression(outermost.parent) ||
      ts.isSatisfiesExpression(outermost.parent) ||
      ts.isNonNullExpression(outermost.parent)) &&
    outermost.parent.expression === outermost
  ) {
    outermost = outermost.parent;
  }
  return outermost;
}

function sharesJsxChildRenderCallback(
  nodes: readonly ts.Node[],
  owner: RuntimeFunctionLike,
): boolean {
  const common = sharedNestedCallback(nodes, owner);
  if (!common) {
    return false;
  }
  const container = outermostTransparentExpression(common).parent;
  return (
    ts.isJsxExpression(container) &&
    (ts.isJsxElement(container.parent) || ts.isJsxFragment(container.parent))
  );
}

/**
 * Keeps an effect-owned numeric source at owner lifetime while proving that
 * all of its render flow terminates in a small set of stable presentation
 * leaves. Local helper calls qualify only when their implementation is pure
 * and closes over inert module constants.
 */
function terminalPresentationLeaves(
  terminals: readonly ts.Identifier[],
  owner: RuntimeFunctionLike,
  allowedCalls: ReadonlySet<string>,
): JsxSubtreeNode[] | null {
  const leaves: JsxSubtreeNode[] = [];
  for (const terminal of terminals) {
    const leaf = presentationLeafFor(terminal, owner, allowedCalls);
    if (!leaf) {
      return null;
    }
    leaves.push(leaf);
  }
  return leaves;
}

function presentationLeafFor(
  terminal: ts.Identifier,
  owner: RuntimeFunctionLike,
  allowedCalls: ReadonlySet<string>,
): JsxSubtreeNode | null {
  const repeated = nearestRepeatedRenderCall(terminal, owner);
  const leaf = nearestJsxElement(repeated ?? terminal, owner);
  if (!repeated) {
    return isSafeJsxProjectionReference(terminal, owner, allowedCalls) ? leaf : null;
  }
  const [callback] = repeated.arguments;
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !repeatedRenderHasStableItemKey(callback) ||
    !leaf ||
    jsxElementCountIn(leaf) > MAX_LEAF_ELEMENTS ||
    !nodeWithin(terminal, leaf)
  ) {
    return null;
  }
  return leaf;
}

function boundedUniquePresentationLeaves(
  leaves: readonly JsxSubtreeNode[],
  ownerJsx: number,
): readonly JsxSubtreeNode[] | null {
  const uniqueLeaves = [...new Map(leaves.map((leaf) => [leaf.getStart(), leaf])).values()];
  if (uniqueLeaves.length < MIN_TERMINAL_LEAVES || uniqueLeaves.length > MAX_TERMINAL_LEAVES) {
    return null;
  }
  const leafElements = uniqueLeaves.reduce((total, leaf) => total + jsxElementCountIn(leaf), 0);
  return leafElements / ownerJsx > MAX_LEAF_SUBTREE_RATIO ? null : uniqueLeaves;
}

function effectSplitTerminals(
  state: StateCandidate,
  usage: StateUsage,
  allowedCalls: ReadonlySet<string>,
): readonly ts.Identifier[] | null {
  const renderRoots = effectSplitRenderRoots(state, usage, allowedCalls);
  const terminals = renderRoots
    ? terminalRenderProjectionReferences(state.owner, renderRoots, allowedCalls)
    : null;
  return terminals && terminals.length >= MIN_TERMINAL_LEAVES ? terminals : null;
}

function effectSplitProjectionSubtree(
  state: StateCandidate,
  usage: StateUsage,
  { ownerJsx, pureProjectionImports }: EffectSplitProjectionScope,
): StateSubtree | null {
  if (
    ownerJsx < BROAD_OWNER_JSX_ELEMENTS ||
    !hasDirectNumericInitializer(state) ||
    usage.transportedOccurrences !== 0 ||
    usage.setterUsesPreviousValue
  ) {
    return null;
  }

  const allowedCalls = new Set([
    ...pureProjectionImports,
    ...localPureProjectionBindings(state.owner.getSourceFile()),
  ]);
  const terminals = effectSplitTerminals(state, usage, allowedCalls);
  const leaves = terminals
    ? terminalPresentationLeaves(terminals, state.owner, allowedCalls)
    : null;
  const uniqueLeaves = leaves ? boundedUniquePresentationLeaves(leaves, ownerJsx) : null;
  const common = uniqueLeaves ? lowestCommonJsxSubtree(uniqueLeaves, state.owner) : null;
  if (!terminals || !uniqueLeaves || !common) {
    return null;
  }
  return splitProjectionResult(common, terminals, { leafCount: uniqueLeaves.length, state });
}

interface SplitProjectionOwner {
  readonly leafCount: number;
  readonly state: StateCandidate;
}

function splitProjectionResult(
  common: JsxSubtreeNode,
  terminals: readonly ts.Node[],
  { leafCount, state }: SplitProjectionOwner,
): StateSubtree {
  const result = stateSubtreeResult("effect-split-projection", common, {
    renderNodes: terminals,
    state,
  });
  result.leafCount = leafCount;
  return result;
}

function effectSplitRenderRoots(
  state: StateCandidate,
  usage: StateUsage,
  allowedCalls: ReadonlySet<string>,
): readonly ts.Identifier[] | null {
  if (!state.owner.body) {
    return null;
  }
  const direct = new Set(usage.directRenderNodes);
  const roots: ts.Identifier[] = [];
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (direct.has(node)) {
      roots.push(node);
      return;
    }
    const call = findAncestorUntil(node, ts.isCallExpression, state.owner);
    if (
      call &&
      ts.isIdentifier(call.expression) &&
      allowedCalls.has(call.expression.text) &&
      call.arguments.some((argument) => nodeWithin(node, argument)) &&
      nearestNestedFunction(node, state.owner) === null
    ) {
      roots.push(node);
      return;
    }
    safe = false;
  });
  return safe && roots.length > 0 ? roots : null;
}

function hasDirectNumericInitializer(state: StateCandidate): boolean {
  const [initializer] = state.call.arguments;
  if (!initializer) {
    return false;
  }
  const value = unwrapTransparentExpression(initializer);
  return (
    ts.isNumericLiteral(value) ||
    (ts.isPrefixUnaryExpression(value) &&
      (value.operator === ts.SyntaxKind.PlusToken || value.operator === ts.SyntaxKind.MinusToken) &&
      ts.isNumericLiteral(unwrapTransparentExpression(value.operand)))
  );
}

interface ProjectionHopScope {
  readonly allowedCalls: ReadonlySet<string>;
  readonly owner: RuntimeFunctionLike;
}

function projectionHopIsSafe(
  declaration: ts.VariableDeclaration,
  current: { readonly depth: number; readonly reference: ts.Identifier },
  { allowedCalls, owner }: ProjectionHopScope,
): boolean {
  return (
    declaration.initializer !== undefined &&
    current.depth < MAX_PROJECTION_HOPS &&
    ts.isIdentifier(declaration.name) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    bindingDeclarationCount(owner, declaration.name.text) === 1 &&
    isSafeProjectionExpression(
      declaration.initializer,
      current.reference,
      allowedCalls,
      projectionMathCalls(owner),
    )
  );
}

function terminalRenderProjectionReferences(
  owner: RuntimeFunctionLike,
  roots: readonly ts.Node[],
  allowedCalls: ReadonlySet<string>,
): readonly ts.Identifier[] | null {
  if (!owner.body || roots.some((root) => !ts.isIdentifier(root))) {
    return null;
  }
  // SAFETY: the guard above returns null unless every root satisfies ts.isIdentifier.
  const pending = roots.map((root) => ({ depth: 0, reference: root as ts.Identifier }));
  const terminals = walkProjectionHops(pending, { allowedCalls, owner });
  return terminals && terminals.length > 0 ? terminals : null;
}

function walkProjectionHops(
  pending: ProjectionReferenceHop[],
  scope: ProjectionHopScope,
): ts.Identifier[] | null {
  const terminals: ts.Identifier[] = [];
  const visited = new Set<number>();
  for (let current = nextUnvisitedHop(pending, visited); current;) {
    const next = projectionHopReferences(current, scope);
    if (!next) {
      return null;
    }
    pushHopOrTerminal(current, next, { pending, terminals });
    current = nextUnvisitedHop(pending, visited);
  }
  return terminals;
}

function nextUnvisitedHop(
  pending: ProjectionReferenceHop[],
  visited: Set<number>,
): ProjectionReferenceHop | null {
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (markVisited(visited, current.reference)) {
      return current;
    }
  }
  return null;
}

function markVisited(visited: Set<number>, reference: ts.Identifier): boolean {
  const start = reference.getStart();
  if (visited.has(start)) {
    return false;
  }
  visited.add(start);
  return true;
}

interface ProjectionHopFrontier {
  readonly pending: ProjectionReferenceHop[];
  readonly terminals: ts.Identifier[];
}

function pushHopOrTerminal(
  current: ProjectionReferenceHop,
  next: readonly ProjectionReferenceHop[],
  { pending, terminals }: ProjectionHopFrontier,
): void {
  if (next.length === 0) {
    terminals.push(current.reference);
    return;
  }
  pending.push(...next);
}

interface ProjectionReferenceHop {
  readonly depth: number;
  readonly reference: ts.Identifier;
}

function projectionHopReferences(
  current: ProjectionReferenceHop,
  { allowedCalls, owner }: ProjectionHopScope,
): readonly ProjectionReferenceHop[] | null {
  const declaration = findAncestorUntil(current.reference, ts.isVariableDeclaration, owner);
  if (
    !declaration ||
    !declaration.initializer ||
    !nodeWithin(current.reference, declaration.initializer)
  ) {
    return [];
  }
  if (!projectionHopIsSafe(declaration, current, { allowedCalls, owner })) {
    return null;
  }
  const references = owner.body ? bindingReferencesIn(owner.body, declaration) : [];
  if (references.length === 0) {
    return null;
  }
  return references.map((reference) => ({ depth: current.depth + 1, reference }));
}

function projectionMathCalls(owner: RuntimeFunctionLike): ReadonlySet<string> {
  if (sourceHasRuntimeBinding(owner.getSourceFile(), "Math")) {
    return EMPTY_BINDINGS;
  }
  return new Set([
    "Math.abs",
    "Math.ceil",
    "Math.exp",
    "Math.floor",
    "Math.max",
    "Math.min",
    "Math.round",
    "Math.trunc",
  ]);
}

function localPureProjectionBindings(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const bindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        (!ts.isArrowFunction(declaration.initializer) &&
          !ts.isFunctionExpression(declaration.initializer)) ||
        !localProjectionFunctionIsPure(declaration.initializer, sourceFile)
      ) {
        continue;
      }
      bindings.add(declaration.name.text);
    }
  }
  return bindings;
}

function localProjectionFunctionIsPure(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  sourceFile: ts.SourceFile,
): boolean {
  if (
    fn.asteriskToken ||
    fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    fn.parameters.length === 0 ||
    fn.parameters.some((parameter) => !ts.isIdentifier(parameter.name) || parameter.initializer)
  ) {
    return false;
  }
  const expression = ts.isBlock(fn.body)
    ? fn.body.statements.length === 1 &&
      ts.isReturnStatement(fn.body.statements[0]!) &&
      fn.body.statements[0]!.expression
    : fn.body;
  if (!expression) {
    return false;
  }
  if (
    !isSafeProjectionExpression(expression, expression, EMPTY_BINDINGS, projectionMathCalls(fn))
  ) {
    return false;
  }

  let safe = true;
  visit(fn.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      identifierIsProjectionParameter(node, fn) ||
      node.text === "Math"
    ) {
      return;
    }
    safe = moduleConstIsEvaluationInert(sourceFile, node.text);
  });
  return safe;
}

function identifierIsProjectionParameter(
  node: ts.Identifier,
  boundary: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (isRuntimeFunctionLike(current)) {
      const names = new Set<string>();
      for (const parameter of current.parameters) {
        collectBindingNames(parameter.name, names);
      }
      if (names.has(node.text)) {
        return true;
      }
    }
    if (current === boundary) {
      return false;
    }
  }
  return false;
}

function moduleConstIsEvaluationInert(sourceFile: ts.SourceFile, name: string): boolean {
  const matches: ts.VariableDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        matches.push(declaration);
      }
    }
  }
  const [match] = matches;
  return (
    match !== undefined && match.initializer !== undefined && isEvaluationInert(match.initializer)
  );
}

function nearestJsxElement(node: ts.Node, boundary: ts.Node): JsxSubtreeNode | null {
  return findAncestorUntil(
    node,
    (candidate): candidate is JsxSubtreeNode =>
      ts.isJsxElement(candidate) ||
      ts.isJsxSelfClosingElement(candidate) ||
      ts.isJsxFragment(candidate),
    boundary,
  );
}

interface EffectSplitProjectionScope {
  readonly ownerJsx: number;
  readonly pureProjectionImports: ReadonlySet<string>;
}

interface SubtreeMaterialityEvidence {
  readonly effectWrittenPresentation: boolean;
  readonly uniqueRepeatedProjection: boolean;
}

function isMaterialStateSubtree(
  subtree: JsxSubtreeNode,
  ownerJsx: number,
  { effectWrittenPresentation, uniqueRepeatedProjection }: SubtreeMaterialityEvidence,
): boolean {
  const subtreeJsx = jsxElementCountIn(subtree);
  return (
    (ownerJsx >= BROAD_OWNER_JSX_ELEMENTS && subtreeJsx / ownerJsx <= MAX_LEAF_SUBTREE_RATIO) ||
    (uniqueRepeatedProjection &&
      ownerJsx >= COMPACT_OWNER_JSX_ELEMENTS &&
      subtreeJsx / ownerJsx <= MAX_REPEATED_PROJECTION_RATIO) ||
    (effectWrittenPresentation &&
      ownerJsx < BROAD_OWNER_JSX_ELEMENTS &&
      ownerJsx - subtreeJsx >= MIN_OWNER_RENDER_CUT_ELEMENTS)
  );
}

function multipleOneHopRenderProjectionReferences(
  owner: RuntimeFunctionLike,
  renderNodes: readonly ts.Node[],
): readonly ts.Identifier[] | null {
  const references = new Set<ts.Identifier>();
  for (const renderNode of renderNodes) {
    const projected = oneHopRenderProjectionReferences(owner, [renderNode]);
    if (!projected) {
      return null;
    }
    for (const reference of projected) {
      references.add(reference);
    }
  }
  return references.size > 0 ? [...references] : null;
}

function isSafeEffectPresentationReference(node: ts.Node, owner: RuntimeFunctionLike): boolean {
  if (!findAncestorUntil(node, isJsxNode, owner)) {
    return false;
  }
  if (commonRenderGateSubtree([node], owner)) {
    return true;
  }
  const repeated = nearestRepeatedRenderCall(node, owner);
  if (
    !repeated ||
    !ts.isPropertyAccessExpression(repeated.expression) ||
    repeated.expression.expression !== node
  ) {
    return false;
  }
  const [callback] = repeated.arguments;
  return (
    callback !== undefined &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    repeatedRenderHasStableItemKey(callback)
  );
}

function isKeyedRepeatedProjection(nodes: readonly ts.Node[], owner: RuntimeFunctionLike): boolean {
  const repeated = commonRepeatedRender(nodes, owner);
  const callback = repeated?.arguments[0];
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !repeatedRenderHasStableItemKey(callback)
  ) {
    return false;
  }
  const binding = callback.parameters[0]?.name;
  if (binding === undefined) {
    return false;
  }
  return nodes.every((node) => {
    const expression = jsxProjectionExpression(node, owner);
    return expression !== null && expressionDependsOnBinding(expression, binding, callback);
  });
}

function jsxProjectionExpression(
  node: ts.Node,
  boundary: RuntimeFunctionLike,
): ts.Expression | null {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, boundary);
  if (attribute?.initializer && ts.isJsxExpression(attribute.initializer)) {
    return attribute.initializer.expression ?? null;
  }
  return findAncestorUntil(node, ts.isJsxExpression, boundary)?.expression ?? null;
}

interface StateSubtreeResultInputs {
  readonly renderNodes: readonly ts.Node[];
  readonly state: StateCandidate;
  readonly uniqueRepeatedBranch?: boolean;
}

function stateSubtreeResult(
  kind: StateSubtree["kind"],
  node: JsxSubtreeNode,
  inputs: StateSubtreeResultInputs,
): StateSubtree {
  const { renderNodes, state, uniqueRepeatedBranch = false } = inputs;
  const lineNode =
    kind === "gate" && nearestNestedFunction(node, state.owner) ? (renderNodes[0] ?? node) : node;
  return {
    kind,
    label: jsxSubtreeLabel(node),
    line: lineNode.getSourceFile().getLineAndCharacterOfPosition(lineNode.getStart()).line + 1,
    node,
    repeated: commonRepeatedRender(renderNodes, state.owner) !== null,
    uniqueRepeatedBranch,
    unstable: hasUnstableSubtreeLifetime(node, state.owner),
  };
}

interface MixedProjectionScope {
  readonly allowNestedSite?: boolean;
  readonly common: JsxSubtreeNode;
}

function isSafeMixedProjectionTransport(
  state: StateCandidate,
  usage: StateUsage,
  scope: MixedProjectionScope,
): boolean {
  const { allowNestedSite = false, common } = scope;
  const [site] = [...usage.valueTransportSites];
  const [target] = [...usage.valueTargets];
  if (
    usage.valueTransportSites.size !== 1 ||
    usage.setterTransportSites.size > 0 ||
    usage.valueTargets.size !== 1 ||
    usage.repeatedTransport ||
    !hasStateInitializer(state, ts.SyntaxKind.NullKeyword) ||
    site === undefined ||
    (site !== common.getStart() &&
      !(allowNestedSite && common.getStart() <= site && site < common.end)) ||
    !target
  ) {
    return false;
  }
  const props = usage.valueProps.get(target);
  return (
    props !== undefined &&
    props.size > 0 &&
    [...props].every((prop) => !/^(?:children|key|ref|render|on[A-Z])/u.test(prop))
  );
}

interface ReactiveMutationPathCoverage {
  readonly all: boolean;
  readonly any: boolean;
}

function setterReactiveMutationPaths(
  state: StateCandidate,
  usage: StateUsage,
  mutationBindings: ReadonlySet<string>,
): ReactiveMutationPathCoverage {
  let any = false;
  let all = mutationBindings.size > 0 && usage.setterCallNodes.length > 0;
  for (const call of usage.setterCallNodes) {
    const pathHasMutation =
      mutationBindings.size > 0 &&
      functionAncestors(call, state.owner).some((ancestor) =>
        functionDirectlyCallsBinding(ancestor, mutationBindings),
      );
    any ||= pathHasMutation;
    all &&= pathHasMutation;
  }
  return { all, any };
}

function functionAncestors(node: ts.Node, owner: RuntimeFunctionLike): RuntimeFunctionLike[] {
  const ancestors: RuntimeFunctionLike[] = [];
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (isRuntimeFunctionLike(current)) {
      ancestors.push(current);
    }
    if (current === owner) {
      break;
    }
  }
  return ancestors;
}

function functionDirectlyCallsBinding(
  fn: RuntimeFunctionLike,
  bindings: ReadonlySet<string>,
): boolean {
  if (!fn.body) {
    return false;
  }
  let calls = false;
  visitSkippingNestedFunctions(fn.body, fn, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const { expression } = node;
    if (ts.isIdentifier(expression) && bindings.has(expression.text)) {
      calls = true;
    }
    if (
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      bindings.has(`${expression.expression.text}.${expression.name.text}`)
    ) {
      calls = true;
    }
  });
  return calls;
}

function setterCallbackEscapesThroughUnknownHook(
  state: StateCandidate,
  usage: StateUsage,
): boolean {
  return usage.setterCallNodes.some((call) => {
    for (
      let current: ts.Node | undefined = call.parent;
      current && current !== state.owner;
      current = current.parent
    ) {
      const hookName = ts.isCallExpression(current) ? calleeName(current.expression) : null;
      if (
        hookName &&
        /^use[A-Z0-9]/u.test(hookName) &&
        !["useCallback", "useEffect"].includes(hookName) &&
        ts.isCallExpression(current) &&
        current.arguments.some((argument) => nodeWithin(call, argument))
      ) {
        return true;
      }
    }
    return false;
  });
}

interface SourceMemoScope {
  readonly childContracts: ChildContractResolver;
  readonly imports: HookImports;
}

function stateIsTransportedBooleanCommand(state: StateCandidate, usage: StateUsage): boolean {
  return (
    hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) &&
    usage.localRenderReads === 0 &&
    stateHasNoEffectOrDeferredUse(usage) &&
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1 &&
    usage.setterCallNodes.length > 0 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped &&
    setterCallsAssignBooleanLiterals(usage)
  );
}

function isSourceProvenMemoizedOptionCommand(
  state: StateCandidate,
  usage: StateUsage,
  { childContracts, imports }: SourceMemoScope,
): boolean {
  if (!state.owner.body || !stateIsTransportedBooleanCommand(state, usage)) {
    return false;
  }

  const option = sharedMemoizedOptionCallback(state, usage, imports);
  const declaration = option
    ? findAncestorUntil(option.memoCall, ts.isVariableDeclaration, state.owner)
    : null;
  if (
    !option ||
    !declaration ||
    !isUniqueConstBindingOf(declaration, option.memoCall, state.owner)
  ) {
    return false;
  }
  const transport = soleMemoTransportSite(state.owner, declaration.name.getText(), declaration);
  return (
    transport !== null &&
    childContracts.componentArrayItemCallbackIsDeferred(
      transport.target,
      transport.prop,
      option.callbackProp,
    )
  );
}

interface MemoizedOptionCallback {
  readonly callbackProp: string;
  readonly memoCall: ts.CallExpression;
}

function memoizedOptionCallbackFor(
  setter: ts.CallExpression,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): MemoizedOptionCallback | null {
  const containingMemo = findAncestorUntil(
    setter,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      isImportedHookCall(node, imports.useMemo, imports.reactNamespaces, "useMemo"),
    owner,
  );
  const factory = containingMemo?.arguments[0];
  const property = factory ? findAncestorUntil(setter, ts.isPropertyAssignment, factory) : null;
  const propertyName = property ? staticPropertyName(property.name) : null;
  const callback = property ? nearestNestedFunction(setter, owner) : null;
  if (
    !containingMemo ||
    !factory ||
    (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) ||
    !property ||
    !propertyName ||
    !callback ||
    callback === factory ||
    !nodeWithin(callback, property)
  ) {
    return null;
  }
  return { callbackProp: propertyName, memoCall: containingMemo };
}

function sharedMemoizedOptionCallback(
  state: StateCandidate,
  usage: StateUsage,
  imports: HookImports,
): MemoizedOptionCallback | null {
  const deferredSetters = usage.setterCallNodes.filter(
    (call) => !isInsideJsxEventCallback(call, state.owner),
  );
  if (deferredSetters.length === 0) {
    return null;
  }
  const options = deferredSetters.map((setter) =>
    memoizedOptionCallbackFor(setter, state.owner, imports),
  );
  const [first] = options;
  if (!first) {
    return null;
  }
  return options.every(
    (option) =>
      option !== null &&
      option.memoCall === first.memoCall &&
      option.callbackProp === first.callbackProp,
  )
    ? first
    : null;
}

interface MemoTransportSite {
  readonly prop: string;
  readonly target: string;
}

function soleMemoTransportSite(
  owner: RuntimeFunctionLike,
  memoBinding: string,
  declaration: ts.VariableDeclaration,
): MemoTransportSite | null {
  const sites: MemoTransportSite[] = [];
  let safe = true;
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== memoBinding ||
      node === declaration.name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      isLengthAccess(node)
    ) {
      return;
    }
    const site = jsxTransportSiteFor(node, owner);
    if (!site || sites.length > 0) {
      safe = false;
      return;
    }
    sites.push(site);
  });
  return safe && sites.length === 1 ? (sites[0] ?? null) : null;
}

function isLengthAccess(node: ts.Identifier): boolean {
  return (
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node &&
    node.parent.name.text === "length"
  );
}

function jsxTransportSiteFor(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
): MemoTransportSite | null {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
  if (!attribute || !isDirectJsxAttributeExpression(attribute, node)) {
    return null;
  }
  const target = jsxOpeningForAttribute(attribute)?.tagName.getText() ?? null;
  return target ? { prop: attribute.name.getText(), target } : null;
}

function staticPropertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

interface EffectOwnedCommandScope {
  readonly directEffectCalls: ReadonlySet<ts.CallExpression>;
  readonly imports: HookImports;
}

function sharedContainingMemoCall(
  setterCalls: readonly ts.CallExpression[],
  owner: RuntimeFunctionLike,
  imports: HookImports,
): ts.CallExpression | null {
  let memoCall: ts.CallExpression | null = null;
  for (const setterCall of setterCalls) {
    const containingMemo = findAncestorUntil(
      setterCall,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        isImportedHookCall(node, imports.useMemo, imports.reactNamespaces, "useMemo"),
      owner,
    );
    if (!containingMemo || (memoCall !== null && memoCall !== containingMemo)) {
      return null;
    }
    memoCall = containingMemo;
  }
  return memoCall;
}

function isUniqueConstBindingOf(
  declaration: ts.VariableDeclaration | null,
  initializer: ts.Expression,
  owner: RuntimeFunctionLike,
): boolean {
  return (
    declaration?.initializer !== undefined &&
    unwrapTransparentExpression(declaration.initializer) === initializer &&
    ts.isIdentifier(declaration.name) &&
    bindingDeclarationCount(owner, declaration.name.text) === 1
  );
}

function isEffectOwnedMemoizedPresentationState(
  state: StateCandidate,
  usage: StateUsage,
  { directEffectCalls, imports }: EffectOwnedCommandScope,
): boolean {
  if (
    !state.owner.body ||
    usage.setterCallNodes.length === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.effectWrites !== 0 ||
    usage.setterUsesPreviousValue
  ) {
    return false;
  }

  const memoCall = sharedContainingMemoCall(usage.setterCallNodes, state.owner, imports);
  const [factory] = memoCall?.arguments ?? [];
  const declaration = memoCall
    ? findAncestorUntil(memoCall, ts.isVariableDeclaration, state.owner)
    : null;
  if (
    !memoCall ||
    !factory ||
    (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) ||
    !isUniqueConstBindingOf(declaration, memoCall, state.owner) ||
    !declaration ||
    !usage.setterCallNodes.every((call) => nodeWithin(call, factory))
  ) {
    return false;
  }
  return memoBindingIsInvokedByEffect(state.owner, declaration, directEffectCalls);
}

function memoBindingIsInvokedByEffect(
  owner: RuntimeFunctionLike,
  declaration: ts.VariableDeclaration,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
): boolean {
  const binding = declaration.name.getText();
  let invokedByEffect = false;
  let safe = true;
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== binding ||
      node === declaration.name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const use = classifyMemoizedBindingReference(node, directEffectCalls);
    safe = use !== "unsafe";
    invokedByEffect ||= use === "invocation";
  });
  return safe && invokedByEffect;
}

type MemoizedBindingReference = "invocation" | "passive" | "unsafe";

function classifyMemoizedBindingReference(
  node: ts.Identifier,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
): MemoizedBindingReference {
  const effectCall = [...directEffectCalls].find((effect) => nodeWithin(node, effect));
  if (!effectCall) {
    return "unsafe";
  }
  if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
    return "invocation";
  }
  const memberCall =
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node &&
    ts.isCallExpression(node.parent.parent) &&
    node.parent.parent.expression === node.parent;
  const [, dependencies] = effectCall.arguments;
  return memberCall || (dependencies !== undefined && nodeWithin(node, dependencies))
    ? "passive"
    : "unsafe";
}

function stateHasSoleCommandWrite(usage: StateUsage): boolean {
  return (
    usage.setterCallNodes.length === 1 &&
    usage.setterReferences === 1 &&
    usage.effectWrites === 0 &&
    !usage.setterUsesPreviousValue &&
    usage.localRenderReads === 0 &&
    usage.transportedOccurrences === 0
  );
}

interface MemoizedCommandScope {
  readonly factory: ts.ArrowFunction | ts.FunctionExpression;
  readonly owner: RuntimeFunctionLike;
}

interface MemoizedCommandFactory {
  readonly factory: ts.ArrowFunction | ts.FunctionExpression;
  readonly memoCall: ts.CallExpression;
}

interface MemoizedSnapshotReads {
  readonly reads: readonly ts.Identifier[];
}

function memoizedSnapshotReads(
  state: StateCandidate,
  { factory, memoCall }: MemoizedCommandFactory,
): MemoizedSnapshotReads | null {
  let bodyReads = 0;
  let dependencyReads = 0;
  let unsafe = false;
  const reads: ts.Identifier[] = [];
  visit(state.owner.body, (node) => {
    if (unsafe || ts.isAwaitExpression(node) || ts.isYieldExpression(node)) {
      unsafe ||= nodeWithin(node, factory);
      return;
    }
    const site = snapshotReadSite(node, state, { factory, memoCall });
    dependencyReads += site === "dependency" ? 1 : 0;
    bodyReads += site === "body" ? 1 : 0;
    unsafe ||= site === "outside";
    if (site === "body" && ts.isIdentifier(node)) {
      reads.push(node);
    }
  });
  return unsafe || bodyReads === 0 || dependencyReads === 0 ? null : { reads };
}

function snapshotReadSite(
  node: ts.Node,
  state: StateCandidate,
  command: MemoizedCommandFactory,
): MemoizedReadSite | "ignored" {
  if (
    !ts.isIdentifier(node) ||
    node.text !== state.valueName ||
    node.parent === state.call.parent ||
    isDeclarationName(node) ||
    isNonValueIdentifier(node)
  ) {
    return "ignored";
  }
  return memoizedReadSite(node, command);
}

type MemoizedReadSite = "body" | "dependency" | "outside";

function memoizedReadSite(
  node: ts.Identifier,
  { factory, memoCall }: MemoizedCommandFactory,
): MemoizedReadSite {
  const [, dependencies] = memoCall.arguments;
  if (dependencies && nodeWithin(node, dependencies)) {
    return "dependency";
  }
  return nodeWithin(node, factory.body) ? "body" : "outside";
}

function snapshotWritesPrecedeReads(
  setterCall: ts.CallExpression,
  reads: readonly ts.Identifier[],
  { factory, owner }: MemoizedCommandScope,
): boolean {
  const writeSites = memoizedCommandWriteSites(setterCall, factory, owner);
  return (
    writeSites !== null &&
    !writeSites.some((write) =>
      reads.some(
        (read) =>
          write.getStart() < read.getStart() &&
          !writeIsFollowedByReturnBeforeRead(write, read, factory),
      ),
    )
  );
}

function commandBindingIsInvokedByEffect(
  owner: RuntimeFunctionLike,
  declaration: ts.VariableDeclaration,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
): boolean {
  const binding = declaration.name.getText();
  let invokedByEffect = false;
  let unsafe = false;
  visit(owner.body, (node) => {
    if (
      unsafe ||
      !ts.isIdentifier(node) ||
      node.text !== binding ||
      node === declaration.name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const use = classifyEffectBindingReference(node, directEffectCalls);
    unsafe = use === "unsafe";
    invokedByEffect ||= use === "invocation";
  });
  return !unsafe && invokedByEffect;
}

interface SyncCallbackCommand extends MemoizedCommandFactory {
  readonly declaration: ts.VariableDeclaration;
}

function syncUseCallbackCommand(
  setterCall: ts.CallExpression,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): SyncCallbackCommand | null {
  const memoCall = findAncestorUntil(
    setterCall,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      isImportedHookCall(node, imports.useCallback, imports.reactNamespaces, "useCallback"),
    owner,
  );
  const factory = memoCall?.arguments[0];
  const declaration = memoCall
    ? findAncestorUntil(memoCall, ts.isVariableDeclaration, owner)
    : null;
  if (
    !memoCall ||
    !factory ||
    (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) ||
    !declaration ||
    !isUniqueConstBindingOf(declaration, memoCall, owner) ||
    factory.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  ) {
    return null;
  }
  return { declaration, factory, memoCall };
}

function isEffectOwnedSelfRefreshingCommandState(
  state: StateCandidate,
  usage: StateUsage,
  { directEffectCalls, imports }: EffectOwnedCommandScope,
): boolean {
  const [setterCall] = usage.setterCallNodes;
  if (!state.owner.body || !setterCall || !stateHasSoleCommandWrite(usage)) {
    return false;
  }
  const command = syncUseCallbackCommand(setterCall, state.owner, imports);
  if (!command) {
    return false;
  }
  const { declaration, factory, memoCall } = command;
  const snapshot = memoizedSnapshotReads(state, { factory, memoCall });
  return (
    snapshot !== null &&
    snapshotWritesPrecedeReads(setterCall, snapshot.reads, { factory, owner: state.owner }) &&
    commandBindingIsInvokedByEffect(state.owner, declaration, directEffectCalls)
  );
}

type EffectBindingReference = "dependency" | "invocation" | "unsafe";

function classifyEffectBindingReference(
  node: ts.Identifier,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
): EffectBindingReference {
  const effectCall = [...directEffectCalls].find((effect) => nodeWithin(node, effect));
  if (!effectCall) {
    return "unsafe";
  }
  if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
    return "invocation";
  }
  const [, dependencies] = effectCall.arguments;
  return dependencies && nodeWithin(node, dependencies) ? "dependency" : "unsafe";
}

function memoizedCommandWriteSites(
  setterCall: ts.CallExpression,
  factory: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
): readonly ts.CallExpression[] | null {
  const region = nearestMutationFunction(setterCall, owner);
  if (region === factory) {
    return [setterCall];
  }
  if (
    !ts.isArrowFunction(region) &&
    !ts.isFunctionDeclaration(region) &&
    !ts.isFunctionExpression(region)
  ) {
    return null;
  }
  const name = localCallbackBindingName(region);
  if (!name || bindingDeclarationCount(factory, name) !== 1) {
    return null;
  }

  return localBindingInvocationSites(factory, name);
}

function localBindingInvocationSites(
  factory: ts.ArrowFunction | ts.FunctionExpression,
  name: string,
): readonly ts.CallExpression[] | null {
  const calls: ts.CallExpression[] = [];
  let safe = true;
  visit(factory.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      calls.push(node.parent);
    } else {
      safe = false;
    }
  });
  return safe && calls.length > 0 ? calls : null;
}

function writeIsFollowedByReturnBeforeRead(
  write: ts.CallExpression,
  read: ts.Identifier,
  boundary: ts.Node,
): boolean {
  for (
    let current: ts.Node | undefined = write.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (!ts.isBlock(current) || nodeWithin(read, current)) {
      continue;
    }
    const writeIndex = current.statements.findIndex((statement) => nodeWithin(write, statement));
    if (
      writeIndex !== -1 &&
      current.statements.slice(writeIndex + 1).some((statement) => ts.isReturnStatement(statement))
    ) {
      return true;
    }
  }
  return false;
}

function commonRepeatedRender(
  nodes: readonly ts.Node[],
  boundary: ts.Node,
): ts.CallExpression | null {
  const calls = nodes.map((node) => nearestRepeatedRenderCall(node, boundary));
  const [first] = calls;
  return first && calls.every((call) => call === first) ? first : null;
}

function jsxSubtreeLabel(node: JsxSubtreeNode): string {
  if (ts.isJsxFragment(node)) {
    return "fragment";
  }
  return ts.isJsxElement(node)
    ? `<${node.openingElement.tagName.getText()}>`
    : `<${node.tagName.getText()}>`;
}

interface FindingContext {
  readonly evidence?: readonly string[];
  readonly fileName: string;
  readonly hook: "useEffect" | "useState";
  readonly name: string | null;
  readonly sourceFile: ts.SourceFile;
}

function findingFor(
  call: ts.CallExpression,
  classification: ClassifiedState | ClassifiedEffect,
  context: FindingContext,
): HookFinding {
  const { evidence = [], fileName, hook, name, sourceFile } = context;
  const position = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
  const finding: HookFinding = {
    action: classification.action,
    confidence: classification.confidence,
    disposition: dispositionFor(classification.action),
    evidence,
    hook,
    location: {
      column: position.character + 1,
      file: path.normalize(fileName),
      line: position.line + 1,
    },
    message: classification.message,
    name,
  };
  if (hook !== "useState") {
    return finding;
  }
  // SAFETY: a "useState" hook is only ever classified by classifyState, whose action is a StateAction.
  return { ...finding, stateModel: stateModelFor(classification.action as StateAction) };
}

function dispositionFor(action: HookFinding["action"]): HookFinding["disposition"] {
  if (action === "keep-effect" || action === "keep-state") {
    return "keep";
  }
  if (
    action === "review-effect" ||
    action === "review-state" ||
    action === "use-mount" ||
    action === "use-unmount"
  ) {
    return "candidate";
  }
  return "change";
}

function isStructuralLegendCandidate(
  state: StateCandidate,
  usage: StateUsage,
  sourceFile: ts.SourceFile,
): boolean {
  return (
    ownerLineSpan(state.owner, sourceFile) >= WIDE_OWNER_LINE_SPAN &&
    jsxElementCount(state.owner) >= BROAD_OWNER_JSX_ELEMENTS &&
    usage.localRenderReads === 0 &&
    usage.transportedOccurrences > 0
  );
}

function legendCandidateMessage(
  state: StateCandidate,
  usage: StateUsage,
  sourceComponents: ReadonlySet<string> = new Set(),
): string {
  const targets = [...usage.jsxTargets].toSorted().join(", ") || "the receiving descendants";
  const resolved = [...usage.jsxTargets].filter((target) => sourceComponents.has(target));
  const proof =
    resolved.length > 0
      ? ` Source declarations resolved for ${resolved.toSorted().join(", ")}, but their prop contracts and mount identity still need verification.`
      : "";
  return `Legend-first restructuring candidate: keep \`${state.valueName}\` in a stable observable owner and subscribe only inside ${targets}; verify the child contract before changing it.${proof}`;
}

const STATE_MODEL_BY_ACTION = {
  "delete-derived-state": { ownership: "delete", subscription: "none" },
  "delete-unused-state": { ownership: "delete", subscription: "none" },
  "keep-state": { ownership: "react", subscription: "owner-react" },
  "move-state-down": { ownership: "react", subscription: "leaf-react" },
  "review-state": { ownership: "review", subscription: "review" },
  "use-observable": { ownership: "local-observable", subscription: "leaf-use-value" },
  "use-ref": { ownership: "ref", subscription: "none" },
  "use-value": { ownership: "existing-observable", subscription: "owner-use-value" },
} satisfies Record<StateAction, NonNullable<HookFinding["stateModel"]>>;

function stateModelFor(action: StateAction): NonNullable<HookFinding["stateModel"]> {
  return { ...STATE_MODEL_BY_ACTION[action] };
}

function stateEvidence(
  state: StateCandidate,
  usage: StateUsage,
  sourceFile: ts.SourceFile,
): readonly string[] {
  return [
    `${ownerEvidence(state.owner, sourceFile)}, JSX elements ${jsxElementCount(state.owner)}`,
    `reads: render ${usage.localRenderReads}, effects ${usage.effectReads}, deferred ${usage.deferredReads}, transported ${usage.transportedOccurrences}`,
    `writes: setter calls ${usage.setterCalls}, effect writes ${usage.effectWrites}`,
    `transport targets: ${[...usage.jsxTargets].toSorted().join(", ") || "none"}`,
  ];
}

function effectEvidence(
  effect: EffectCandidate,
  sourceFile: ts.SourceFile,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): readonly string[] {
  return [
    effect.owner ? ownerEvidence(effect.owner, sourceFile) : "owner: unresolved",
    `dependencies: ${effect.dependencies?.elements.length ?? "unresolved"}`,
    `cleanup: ${effect.callback ? callbackHasCleanup(effect.callback, stateBySetter) : "unresolved"}`,
  ];
}

function ownerEvidence(owner: RuntimeFunctionLike, sourceFile: ts.SourceFile): string {
  const start = sourceFile.getLineAndCharacterOfPosition(owner.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(owner.end).line + 1;
  return `owner: ${runtimeFunctionName(owner) ?? "anonymous"}, lines ${start}-${end}`;
}

function ownerLineSpan(owner: RuntimeFunctionLike, sourceFile: ts.SourceFile): number {
  const start = sourceFile.getLineAndCharacterOfPosition(owner.getStart(sourceFile)).line;
  const end = sourceFile.getLineAndCharacterOfPosition(owner.end).line;
  return end - start + 1;
}

function runtimeFunctionName(owner: RuntimeFunctionLike): string | null {
  if (owner.name && ts.isIdentifier(owner.name)) {
    return owner.name.text;
  }
  const { parent } = owner;
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : null;
}

function isCustomHookOwner(owner: RuntimeFunctionLike): boolean {
  const name = runtimeFunctionName(owner);
  return name !== null && /^use[A-Z0-9]/u.test(name);
}

interface EffectCursorScope {
  readonly childContracts: ChildContractResolver;
  readonly directEffectCalls: ReadonlySet<ts.CallExpression>;
}

function isEffectOwnedReturnedKeyedCursor(
  state: StateCandidate,
  usage: StateUsage,
  { childContracts, directEffectCalls }: EffectCursorScope,
): boolean {
  const hookName = runtimeFunctionName(state.owner);
  if (
    !hookName ||
    !isCustomHookOwner(state.owner) ||
    jsxElementCount(state.owner) !== 0 ||
    !hasNumericStateInitializer(state) ||
    usage.localRenderReads !== 1 ||
    usage.effectReads < 1 ||
    usage.deferredReads !== 0 ||
    usage.transportedOccurrences !== 0 ||
    usage.setterCalls < 1 ||
    usage.effectWrites !== usage.setterCalls ||
    usage.setterReferences !== usage.setterCalls + 1 ||
    usage.shadowed ||
    stateMayHoldCallable(state) ||
    !primitiveSetterUpdatersArePure(state, usage) ||
    !returnsStateAndSetter(state) ||
    !effectCursorReadsAreDeferred(state, directEffectCalls, childContracts)
  ) {
    return false;
  }
  return (
    state.setterName !== null &&
    childContracts.hookStateHasKeyedRowConsumer(hookName, state.valueName, state.setterName)
  );
}

function hasNumericStateInitializer(state: StateCandidate): boolean {
  const [initializer] = state.call.arguments;
  if (!initializer) {
    return false;
  }
  const value = unwrapTransparentExpression(initializer);
  return (
    ts.isNumericLiteral(value) ||
    (ts.isPrefixUnaryExpression(value) &&
      value.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(value.operand))
  );
}

function returnsStateAndSetter(state: StateCandidate): boolean {
  if (!state.owner.body || !state.setterName) {
    return false;
  }
  let matched = false;
  let returns = 0;
  visitSkippingNestedRuntimeFunctions(state.owner.body, (node) => {
    if (!ts.isReturnStatement(node) || !node.expression) {
      return;
    }
    returns += 1;
    const value = unwrapTransparentExpression(node.expression);
    if (!ts.isObjectLiteralExpression(value)) {
      return;
    }
    const names = new Set(
      value.properties.flatMap((property) => {
        if (ts.isShorthandPropertyAssignment(property)) {
          return [property.name.text];
        }
        if (!ts.isPropertyAssignment(property)) {
          return [];
        }
        const initializer = unwrapTransparentExpression(property.initializer);
        return ts.isIdentifier(property.name) &&
          ts.isIdentifier(initializer) &&
          property.name.text === initializer.text
          ? [initializer.text]
          : [];
      }),
    );
    matched = names.has(state.valueName) && names.has(state.setterName!);
  });
  return returns === 1 && matched;
}

interface CursorReadScope {
  readonly childContracts: ChildContractResolver;
  readonly directEffectCalls: ReadonlySet<ts.CallExpression>;
}

function deferredCursorReadEffect(
  node: ts.Identifier,
  state: StateCandidate,
  { childContracts, directEffectCalls }: CursorReadScope,
): ts.CallExpression | "unsafe" | null {
  const returned = findAncestorUntil(node, ts.isReturnStatement, state.owner);
  if (
    returned?.expression &&
    ts.isObjectLiteralExpression(unwrapTransparentExpression(returned.expression))
  ) {
    return null;
  }
  const effect = ancestorCallInSet(node, directEffectCalls, state.owner);
  if (!effect) {
    return "unsafe";
  }
  const [callback, dependencies] = effect.arguments;
  if (dependencies && nodeWithin(node, dependencies)) {
    return null;
  }
  return readIsRegisteredWithCleanup(node, callback, { childContracts, owner: state.owner })
    ? effect
    : "unsafe";
}

interface RegisteredCleanupScope {
  readonly childContracts: ChildContractResolver;
  readonly owner: RuntimeFunctionLike;
}

function readIsRegisteredWithCleanup(
  node: ts.Identifier,
  callback: ts.Expression | undefined,
  { childContracts, owner }: RegisteredCleanupScope,
): boolean {
  const nested = nearestNestedFunction(node, owner);
  return (
    callback !== undefined &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    nested !== null &&
    nested !== callback &&
    (ts.isArrowFunction(nested) || ts.isFunctionExpression(nested)) &&
    registeredCallbackHasEffectCleanup(nested, callback, childContracts)
  );
}

function effectCursorReadsAreDeferred(
  state: StateCandidate,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
  childContracts: ChildContractResolver,
): boolean {
  if (!state.owner.body) {
    return false;
  }
  const nestedReadEffects = new Set<ts.CallExpression>();
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      node.parent === state.call.parent ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const deferred = deferredCursorReadEffect(node, state, {
      childContracts,
      directEffectCalls,
    });
    if (deferred === "unsafe") {
      safe = false;
      return;
    }
    if (deferred !== null) {
      nestedReadEffects.add(deferred);
    }
  });
  return (
    safe &&
    nestedReadEffects.size > 0 &&
    [...nestedReadEffects].every((effect) => effectCleansUpAndDependsOn(effect, state.valueName))
  );
}

function effectCleansUpAndDependsOn(effect: ts.CallExpression, valueName: string): boolean {
  const [callback, dependencies] = effect.arguments;
  if (
    callback === undefined ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    dependencies === undefined ||
    !ts.isArrayLiteralExpression(dependencies)
  ) {
    return false;
  }
  return (
    callbackHasCleanup(callback, EMPTY_STATE_CANDIDATES) &&
    dependencies.elements.some((element) => {
      const value = unwrapTransparentExpression(element);
      return ts.isIdentifier(value) && value.text === valueName;
    })
  );
}

interface CallbackRegistrationScope {
  readonly childContracts: ChildContractResolver;
  readonly effect: ts.ArrowFunction | ts.FunctionExpression;
}

function isDeferredCallbackRegistration(
  call: ts.Node,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  { childContracts, effect }: CallbackRegistrationScope,
): call is ts.CallExpression {
  const owner = findAncestor(effect, isRuntimeFunctionLike);
  return (
    owner !== null &&
    ts.isCallExpression(call) &&
    call.arguments.includes(callback) &&
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    bindingDeclarationCount(owner, call.expression.expression.text) === 0 &&
    childContracts.callbackRegistrationIsDeferred(
      call.expression.expression.text,
      call.expression.name.text,
      call.arguments.indexOf(callback),
    )
  );
}

function constDisposerDeclaration(
  call: ts.CallExpression,
  effect: ts.ArrowFunction | ts.FunctionExpression,
): ts.VariableDeclaration | null {
  const declaration = findAncestorUntil(call, ts.isVariableDeclaration, effect);
  if (
    !declaration ||
    !declaration.initializer ||
    unwrapTransparentExpression(declaration.initializer) !== call ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(effect, declaration.name.text) !== 1
  ) {
    return null;
  }
  return declaration;
}

function bindingReferencesIn(
  body: ts.Node,
  declaration: ts.VariableDeclaration,
): readonly ts.Identifier[] {
  const name = declaration.name.getText();
  const references: ts.Identifier[] = [];
  visit(body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      node !== declaration.name &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references;
}

function registeredCallbackHasEffectCleanup(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  effect: ts.ArrowFunction | ts.FunctionExpression,
  childContracts: ChildContractResolver,
): boolean {
  const call = callback.parent;
  if (!isDeferredCallbackRegistration(call, callback, { childContracts, effect })) {
    return false;
  }
  const declaration = constDisposerDeclaration(call, effect);
  if (!declaration) {
    return false;
  }
  const references = bindingReferencesIn(effect.body, declaration);
  return (
    references.length > 0 &&
    references.every((reference) => {
      const returned = findAncestorUntil(reference, ts.isReturnStatement, effect);
      if (!returned?.expression) {
        return false;
      }
      const cleanup = unwrapTransparentExpression(returned.expression);
      if (cleanup === reference) {
        return true;
      }
      if (!ts.isArrowFunction(cleanup) && !ts.isFunctionExpression(cleanup)) {
        return false;
      }
      return (
        ts.isCallExpression(reference.parent) &&
        reference.parent.expression === reference &&
        nearestNestedFunction(reference, effect) === cleanup
      );
    })
  );
}

function ancestorCallInSet(
  node: ts.Node,
  calls: ReadonlySet<ts.CallExpression>,
  boundary: ts.Node,
): ts.CallExpression | null {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (ts.isCallExpression(current) && calls.has(current)) {
      return current;
    }
  }
  return null;
}

function jsxTargetName(attribute: ts.JsxAttribute): string | null {
  const properties = attribute.parent;
  const opening = properties.parent;
  if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) {
    return null;
  }
  return opening.tagName.getText();
}

function isCustomJsxTarget(name: string): boolean {
  const [first] = name;
  return first !== undefined && (first === first.toUpperCase() || name.includes("."));
}

function jsxTransportSite(attribute: ts.JsxAttribute): number {
  return attribute.parent.parent.getStart();
}

function isInsideJsxCallback(node: ts.Node, boundary: RuntimeFunctionLike): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (!isRuntimeFunctionLike(current)) {
      continue;
    }
    const attribute = findAncestorUntil(current, ts.isJsxAttribute, boundary);
    if (attribute && isInsideJsxAttribute(current, attribute)) {
      return true;
    }
  }
  return false;
}

function hasUnstableJsxLifetime(node: ts.Node, boundary: ts.Node): boolean {
  const opening = node.parent.parent;
  if (
    (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) &&
    opening.attributes.properties.some(
      (property) => ts.isJsxAttribute(property) && property.name.getText() === "key",
    )
  ) {
    return true;
  }
  for (
    let current: ts.Node | undefined = opening.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (
      ts.isConditionalExpression(current) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
    ) {
      return true;
    }
  }
  return nearestRepeatedRenderCall(opening, boundary) !== null;
}

function isDirectArgumentToUnknownCall(node: ts.Identifier): boolean {
  const { parent } = node;
  return (
    ts.isCallExpression(parent) && parent.expression !== node && parent.arguments.includes(node)
  );
}

function isOriginalStateBinding(node: ts.Identifier, call: ts.CallExpression): boolean {
  const declaration = call.parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    declaration.name.getStart() <= node.getStart() &&
    node.end <= declaration.name.end
  );
}

function hasAncestorInSet(node: ts.Node, ancestors: ReadonlySet<ts.Node>): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ancestors.has(current)) {
      return true;
    }
  }
  return false;
}

function isInsideImportedCallback(node: ts.Node, hookNames: ReadonlySet<string>): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      hookNames.has(current.expression.text) &&
      current.arguments.some(
        (argument) => argument.getStart() <= node.getStart() && node.end <= argument.end,
      )
    ) {
      return true;
    }
  }
  return false;
}

function collectLocalComponents(
  sourceFile: ts.SourceFile,
  imports: HookImports,
): ReadonlySet<string> {
  const names = new Set<string>();
  visit(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && isComponentName(node.name.text)) {
      names.add(node.name.text);
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isComponentName(node.name.text) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer) ||
        isImportedReactLazyCall(node.initializer, imports))
    ) {
      names.add(node.name.text);
    }
  });
  return names;
}

function isImportedReactLazyCall(node: ts.Expression, imports: HookImports): boolean {
  const value = unwrapTransparentExpression(node);
  if (!ts.isCallExpression(value)) {
    return false;
  }
  if (ts.isIdentifier(value.expression)) {
    return imports.lazy.has(value.expression.text);
  }
  return (
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === "lazy" &&
    ts.isIdentifier(value.expression.expression) &&
    imports.reactNamespaces.has(value.expression.expression.text)
  );
}

function collectPureProjectionImports(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    const clause = clsxImportClause(statement);
    if (clause) {
      addClsxBindingNames(clause, names);
    }
  }
  return names;
}

function clsxImportClause(statement: ts.Statement): ts.ImportClause | null {
  if (
    !ts.isImportDeclaration(statement) ||
    !ts.isStringLiteral(statement.moduleSpecifier) ||
    statement.moduleSpecifier.text !== "clsx" ||
    statement.importClause?.isTypeOnly
  ) {
    return null;
  }
  return statement.importClause ?? null;
}

function addClsxBindingNames(clause: ts.ImportClause, names: Set<string>): void {
  if (clause.name) {
    names.add(clause.name.text);
  }
  if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    return;
  }
  for (const specifier of clause.namedBindings.elements) {
    if (!specifier.isTypeOnly && (specifier.propertyName?.text ?? specifier.name.text) === "clsx") {
      names.add(specifier.name.text);
    }
  }
}

function ownerDeclaresBinding(owner: RuntimeFunctionLike, name: string): boolean {
  let declared = false;
  visit(owner, (node) => {
    if (node !== owner && ts.isIdentifier(node) && node.text === name && isDeclarationName(node)) {
      declared = true;
    }
  });
  return declared;
}

function isComponentName(name: string): boolean {
  const [first] = name;
  return first !== undefined && first === first.toUpperCase();
}

function firstJsxOpeningAt(
  body: ts.Node,
  position: number,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const openings: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  visit(body, (node) => {
    if (
      openings.length === 0 &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.getStart() === position
    ) {
      openings.push(node);
    }
  });
  return openings[0] ?? null;
}

function isOwnerLevelNode(node: ts.Node, owner: RuntimeFunctionLike): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (isRuntimeFunctionLike(current)) {
      return false;
    }
  }
  return true;
}

function stableOwnerLevelCallSite(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const [valueSite] = [...usage.valueTransportSites];
  if (valueSite === undefined || !owner.body) {
    return null;
  }
  const opening = firstJsxOpeningAt(owner.body, valueSite);
  return opening && isOwnerLevelNode(opening, owner) ? opening : null;
}

function callSiteIsKeyed(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement | null): boolean {
  if (!opening) {
    return true;
  }
  return opening.attributes.properties.some(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === "key",
  );
}
