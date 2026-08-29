import path from "node:path";

import ts from "typescript";

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
  findAncestor,
  findAncestorUntil,
  identifiersNamed,
  isNonProductionHarness,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  nodeWithin,
  type RuntimeFunctionLike,
  scriptKindForFile,
  visit,
  visitSkippingNestedFunctions,
  visitSkippingNestedRuntimeFunctions,
} from "./ast.js";
import { collectHookImports, isImportedHookCall, isLocalHookCall, type HookImports } from "./imports.js";
import type { AnalysisFile } from "./analysis-project.js";
import {
  directReactHookFormEventCallbacks,
  findAsyncLeafStatuses,
} from "./rules/async-leaf-status.js";
import {
  type ChildContractResolver,
  propIsLeafRenderConsumer,
} from "./rules/child-contract.js";
import {
  collectCommandOnlyCallableReads,
  functionalCounterUpdaterPreservesSnapshot,
  functionalUpdaterPrecedesSnapshotRead,
  refWouldChangeCommandSnapshot,
  stateFeedsReturnedSwitchCommand,
  statePublishesReadOnlyGetter,
  stateReadCallbackEscapesThroughUnknownHook,
} from "./rules/command-only-state.js";
import {
  commonRenderGateSubtree,
  findDeferredRevealStates,
  hasStateInitializer,
  isRenderGateReference,
  isSafeProjectionExpression,
  jsxSubtreeAncestors,
  type JsxSubtreeNode,
} from "./rules/deferred-reveal.js";
import {
  findEffectSynchronizedDrafts,
  hasLazyStateInitializer,
  mutationRegionOnlyCallsStateSetters,
  type EffectDraftProofs,
} from "./rules/effect-drafts.js";
import { callbackHasCleanup, classifyEffect } from "./rules/effects.js";
import {
  isReactiveHostPropScalarState,
  isSourceEventScalarLeafState,
} from "./rules/event-scalar-leaf.js";
import {
  analyzeKeyedSelections,
  isSelectionStateName,
  isSetOrMapState,
} from "./rules/keyed-selection.js";
import {
  isAdjacentEffectBooleanLeafState,
  isAdjacentEventBooleanLeafState,
  isLiteralBooleanLeafState,
  isMultiSurfaceLiteralBooleanState,
} from "./rules/literal-boolean-leaf.js";
import { findListenerRefStateClusters } from "./rules/listener-ref-state.js";
import { isPropertyLocalObjectDraftState } from "./rules/object-draft.js";
import {
  collectReactCommitContext,
} from "./rules/react-commit-sensitivity.js";
import {
  findLazyCallbackLeaf,
  type LazyCallbackLeafProofs,
} from "./rules/lazy-callback-leaf.js";
import {
  callbackIsEventRooted,
  boundedRenderProjectionReferences,
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
  isUniquelySelectedRepeatedProjection,
  isSafeJsxProjectionReference,
  isSynchronousRenderCallback,
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
import { StateFlowIndex } from "./state-flow.js";
import type { EffectAction, HookFinding, StateAction } from "./types.js";

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
      mutationsAreProvenCoexecuting(left, right, region, stateFlow),
    uniqueReturnedExpression,
  };
}

export function analyzeSource(
  sourceText: string,
  fileName: string,
  sourceComponents: ReadonlySet<string> = new Set()
): HookFinding[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(fileName)
  );
  return analyzeParsedSource(
    sourceFile,
    fileName,
    sourceComponents,
    new StateFlowIndex(),
    null,
    new Map(),
    new Map()
  );
}

export function analyzeSourceFile(
  file: AnalysisFile,
  reportFileName: string,
  sourceComponents: ReadonlySet<string> = new Set(),
  stateFlow: StateFlowIndex = new StateFlowIndex(),
  childContracts: ChildContractResolver | null = null,
  legendValueBridges: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
  hookImports: HookImports = collectHookImports(file.sourceFile)
): HookFinding[] {
  return analyzeParsedSource(
    file.sourceFile,
    reportFileName,
    sourceComponents,
    stateFlow,
    childContracts,
    legendValueBridges,
    deferredCallbackHooks,
    hookImports
  );
}

export function findingHookImports(file: AnalysisFile): HookImports | null {
  const imports = collectHookImports(file.sourceFile);
  return containsFindingHookCall(file.sourceFile, imports) ? imports : null;
}

function containsFindingHookCall(node: ts.Node, imports: HookImports): boolean {
  if (
    ts.isCallExpression(node) &&
    (
      isImportedHookCall(node, imports.useState, imports.reactNamespaces, "useState") ||
      isImportedHookCall(node, imports.useEffect, imports.reactNamespaces, "useEffect")
    )
  ) {
    return true;
  }
  return node.forEachChild(child => containsFindingHookCall(child, imports) || undefined) === true;
}

function analyzeParsedSource(
  sourceFile: ts.SourceFile,
  fileName: string,
  sourceComponents: ReadonlySet<string>,
  stateFlow: StateFlowIndex,
  childContracts: ChildContractResolver | null,
  legendValueBridges: ReadonlyMap<string, ReadonlySet<string>>,
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>,
  imports: HookImports = collectHookImports(sourceFile)
): HookFinding[] {
  const pureProjectionImports = new Set([
    ...collectPureProjectionImports(sourceFile),
    ...(childContracts?.pureProjectionBindings() ?? EMPTY_BINDINGS),
  ]);
  const reactCommit = collectReactCommitContext(sourceFile, imports);
  const localComponents = collectLocalComponents(sourceFile, imports);
  const states: StateCandidate[] = [];
  const unmatchedStateCalls: ts.CallExpression[] = [];
  const effects = reactCommit.effectCalls.map(call => effectCandidate(call, imports));
  const useValueBindingsByOwner = collectUseValueBindings(sourceFile, imports);
  const observableSubscriptionsByOwner = collectObservableSubscriptionCounts(sourceFile, imports);
  const useObservableBindingsByOwner = collectStableUseObservableBindings(sourceFile, imports);
  const moduleScopeBindings = collectModuleScopeBindings(sourceFile);
  const reactiveMutationsByOwner = collectReactiveMutationBindings(sourceFile);
  const nonProductionHarness = isNonProductionHarness(fileName);
  const commitSensitiveOwners = reactCommit.sensitiveOwners;

  visit(sourceFile, node => {
    if (!ts.isCallExpression(node)) return;
    if (isImportedHookCall(node, imports.useState, imports.reactNamespaces, "useState")) {
      const state = stateCandidate(node);
      if (state) states.push(state);
      else unmatchedStateCalls.push(node);
      return;
    }
  });

  const lifecycleRegions = reactCommit.lifecycleRegions;
  const directEffectCalls = new Set(reactCommit.effectCalls);
  const directEffectCallbacks = new Set<RuntimeFunctionLike>(
    effects.flatMap(effect => effect.callback ? [effect.callback] : []),
  );
  const knownComponents = new Set([...localComponents, ...sourceComponents]);
  const usageByState = new Map(states.map(state => [state, collectStateUsage(state, lifecycleRegions, imports)]));
  const eventCallbacksByOwner = new Map<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>();
  const sourceEventCallbacksByOwner = new Map<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>();
  const statesByOwner = new Map<RuntimeFunctionLike, StateCandidate[]>();
  for (const state of states) {
    const owned = statesByOwner.get(state.owner) ?? [];
    owned.push(state);
    statesByOwner.set(state.owner, owned);
  }
  for (const [owner, ownedStates] of statesByOwner) {
    const callbacks = new Set(reactCommit.eventTransitionCallbacks.get(owner) ?? EMPTY_RUNTIME_FUNCTIONS);
    if (ownedStates.some(state => (usageByState.get(state)?.deferredReads ?? 0) > 0)) {
      for (const callback of directReactHookFormEventCallbacks(owner)) {
        callbacks.add(callback);
      }
    }
    const needsDeferredCallbackProof = ownedStates.some(state => {
      const usage = usageByState.get(state);
      return usage !== undefined &&
        (
          (
            usage.localRenderReads === 0 &&
            usage.effectReads === 0 &&
            usage.deferredReads > 0 &&
            usage.transportedOccurrences === 0 &&
            (usage.eventReads > 0 || usage.effectWrites > 0) &&
            !hasOnlyEventCommandReads(state, EMPTY_NODES, callbacks)
          ) ||
          (
            hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) &&
            usage.effectReads === 0 &&
            usage.effectWrites === 0 &&
            usage.setterCallNodes.length >= 2 &&
            (usage.localRenderReads > 0 || usage.valueTransportSites.size >= 1)
          )
        );
    });
    if (needsDeferredCallbackProof) {
      for (const callback of directReactHookFormEventCallbacks(owner)) {
        callbacks.add(callback);
      }
      const sourceCallbacks = sourceProvenDirectEventCallbacks(owner, imports, childContracts);
      sourceEventCallbacksByOwner.set(owner, sourceCallbacks);
      for (const callback of sourceCallbacks) {
        callbacks.add(callback);
      }
      if (childContracts) {
        for (const callback of sourceProvenOptionEventCallbacks(owner, imports, childContracts)) {
          callbacks.add(callback);
          if (callback.body) {
            visit(callback.body, node => {
              if (isRuntimeFunctionLike(node)) callbacks.add(node);
            });
          }
        }
      }
    }
    eventCallbacksByOwner.set(owner, callbacks);
  }
  const subtreeByState = new Map<StateCandidate, StateSubtree>();
  const safeCommandStates = new Set<StateCandidate>();
  const selfRefreshingCommandStates = new Set<StateCandidate>();
  const memoizedOptionCommandStates = new Set<StateCandidate>();
  const returnedKeyedCursorStates = new Set<StateCandidate>();
  const reactiveMutationAffectedStates = new Set<StateCandidate>();
  for (const state of states) {
    const usage = usageByState.get(state);
    if (!usage) continue;
    const reactiveMutationPaths = setterReactiveMutationPaths(
      state,
      usage,
      reactiveMutationsByOwner.get(state.owner) ?? EMPTY_BINDINGS
    );
    if (reactiveMutationPaths.any) reactiveMutationAffectedStates.add(state);
    const effectOwnedMemoizedCommand = isEffectOwnedMemoizedPresentationState(
      state,
      usage,
      directEffectCalls,
      imports
    );
    if (
      isEffectOwnedSelfRefreshingCommandState(
        state,
        usage,
        directEffectCalls,
        imports
      )
    ) {
      selfRefreshingCommandStates.add(state);
    }
    const memoizedOptionCommand = childContracts !== null &&
      isSourceProvenMemoizedOptionCommand(
        state,
        usage,
        imports,
        childContracts
      );
    if (memoizedOptionCommand) memoizedOptionCommandStates.add(state);
    const projectionAllowed = !reactiveMutationPaths.all &&
      (!setterCallbackEscapesThroughUnknownHook(state, usage) ||
        effectOwnedMemoizedCommand ||
        memoizedOptionCommand) &&
      primitiveSetterUpdatersArePure(state, usage);
    if (projectionAllowed) safeCommandStates.add(state);
    const subtree = analyzeStateSubtree(
      state,
      usage,
      projectionAllowed,
      pureProjectionImports,
      directEffectCalls,
      effectOwnedMemoizedCommand,
      childContracts
    );
    if (subtree) subtreeByState.set(state, subtree);
    if (
      childContracts &&
      isEffectOwnedReturnedKeyedCursor(state, usage, directEffectCalls, childContracts)
    ) {
      returnedKeyedCursorStates.add(state);
    }
  }
  const effectStateScopes = collectEffectStateScopes(states, usageByState);
  const observableSelectionOwners = new Set(
    states
      .filter(state => {
        const usage = usageByState.get(state);
        return (
          isSetOrMapState(state.call) &&
          isCustomHookOwner(state.owner) &&
          isSelectionStateName(state.valueName) &&
          usage !== undefined &&
          usage.effectWrites === 0
        );
      })
      .map(state => state.owner)
  );
  const deferredRevealStates = findDeferredRevealStates(
    effects,
    states,
    usageByState
  );
  const companionWrites = findStateCompanionWrites(states, stateFlow);
  const statesWithCompanionWrites = companionWrites.all;
  const propertyLocalObjectDrafts = new Set(
    states.filter(state => {
      const usage = usageByState.get(state);
      return usage !== undefined && isPropertyLocalObjectDraftState(state, usage, {
        childContracts,
        eventCallbacks: eventCallbacksByOwner.get(state.owner) ?? EMPTY_RUNTIME_FUNCTIONS,
        hasCompanionWrites: statesWithCompanionWrites.has(state),
        hasReactiveMutationPath: reactiveMutationAffectedStates.has(state),
        hasSafeCommands: safeCommandStates.has(state),
        localComponents,
        sourceComponents,
      });
    })
  );
  const dialogPayloadCuts = new Map<StateCandidate, DialogPayloadCut>();
  for (const state of states) {
    const usage = usageByState.get(state);
    if (
      !usage ||
      statesWithCompanionWrites.has(state) ||
      !safeCommandStates.has(state)
    ) {
      continue;
    }
    const cut = nullableDialogPayloadCut(
      state,
      usage,
      knownComponents,
      childContracts,
      imports
    );
    if (cut) dialogPayloadCuts.set(state, cut);
  }
  const multiSurfaceBooleanStates = new Set(
    states.filter(state => {
      const usage = usageByState.get(state);
      return usage !== undefined && isMultiSurfaceLiteralBooleanState(state, usage, {
        hasCompanionWrites: statesWithCompanionWrites.has(state),
        hasReactiveMutationPath: reactiveMutationAffectedStates.has(state),
        hasSafeCommands: safeCommandStates.has(state),
        isCustomHookOwner: isCustomHookOwner(state.owner),
        pureProjectionImports,
      });
    })
  );
  const sourceEventScalarStates = new Set(
    states.filter(state => {
      const usage = usageByState.get(state);
      if (!usage || !childContracts || isCustomHookOwner(state.owner)) return false;
      let callbacks = sourceEventCallbacksByOwner.get(state.owner);
      if (!callbacks) {
        callbacks = sourceProvenDirectEventCallbacks(state.owner, imports, childContracts);
        sourceEventCallbacksByOwner.set(state.owner, callbacks);
      }
      return isSourceEventScalarLeafState(state, usage, {
        eventCallbacks: callbacks,
        hasCompanionWrites: statesWithCompanionWrites.has(state),
        hasReactiveMutationPath: reactiveMutationAffectedStates.has(state),
        hasSafeCommands: safeCommandStates.has(state),
        localComponents,
        pureProjectionImports,
        sourceComponents,
        useCallbackNames: imports.useCallback,
      });
    })
  );
  const reactiveHostPropScalarStates = new Set(
    states.filter(state => {
      const usage = usageByState.get(state);
      if (!usage || !childContracts || isCustomHookOwner(state.owner)) return false;
      let callbacks = sourceEventCallbacksByOwner.get(state.owner);
      if (!callbacks) {
        callbacks = sourceProvenDirectEventCallbacks(state.owner, imports, childContracts);
        sourceEventCallbacksByOwner.set(state.owner, callbacks);
      }
      return isReactiveHostPropScalarState(state, usage, {
        eventCallbacks: callbacks,
        hasCompanionWrites: statesWithCompanionWrites.has(state),
        hasReactiveMutationPath: reactiveMutationAffectedStates.has(state),
        hasSafeCommands: safeCommandStates.has(state),
        hostComponents: imports.hostComponents,
        pureProjectionImports,
        useCallbackNames: imports.useCallback,
      });
    })
  );
  const adjacentEventBooleanStates = new Set(
    states.filter(state => {
      const usage = usageByState.get(state);
      return usage !== undefined && isAdjacentEventBooleanLeafState(state, usage, {
        hasCompanionWrites: statesWithCompanionWrites.has(state),
        hasReactiveMutationPath: reactiveMutationAffectedStates.has(state),
        hasSafeCommands: safeCommandStates.has(state),
        isCustomHookOwner: isCustomHookOwner(state.owner),
        pureProjectionImports,
      });
    })
  );
  const adjacentEffectBooleanStates = new Set(
    states.filter(state => {
      const usage = usageByState.get(state);
      return usage !== undefined && isAdjacentEffectBooleanLeafState(state, usage, {
        effectWritesAreDirect: usage.setterCallNodes.every(call => {
          const callback = nearestNestedFunction(call, state.owner);
          return callback !== null && directEffectCallbacks.has(callback);
        }),
        hasCompanionWrites: statesWithCompanionWrites.has(state),
        hasReactiveMutationPath: reactiveMutationAffectedStates.has(state),
        hasSafeCommands: safeCommandStates.has(state),
        isCustomHookOwner: isCustomHookOwner(state.owner),
        pureProjectionImports,
      });
    })
  );
  const independentStateWrites = findIndependentStateWrites(states);
  const branchUnmountMoves = findBranchUnmountMoves(
    states,
    usageByState,
    safeCommandStates,
    stateFlow
  );
  const asyncLeafStatuses = findAsyncLeafStatuses(
    states,
    usageByState,
    safeCommandStates,
    reactiveMutationAffectedStates,
    localComponents,
    sourceComponents,
    childContracts,
    eventCallbacksByOwner
  );
  const siblingRenderCuts = new Map<StateCandidate, SiblingRenderCut>();
  for (const state of states) {
    const usage = usageByState.get(state);
    if (
      !usage ||
      !safeCommandStates.has(state) ||
      statesWithCompanionWrites.has(state)
    ) {
      continue;
    }
    const cut = siblingProducerConsumerCut(state, usage, lifecycleRegions);
    if (cut) siblingRenderCuts.set(state, cut);
  }
  const effectDrafts = findEffectSynchronizedDrafts(
    effects,
    states,
    effectStateScopes,
    usageByState,
    siblingRenderCuts,
    localComponents,
    sourceComponents,
    effectDraftProofs(stateFlow)
  );
  const keyedSelections = analyzeKeyedSelections(
    states,
    usageByState,
    safeCommandStates,
    statesWithCompanionWrites,
    imports,
    childContracts
  );
  const observableClusters = findObservableStateClusters(
    states,
    usageByState,
    knownComponents,
    sourceFile,
    stateFlow,
    childContracts
  );
  const subtreeClusters = findStateSubtreeClusters(
    subtreeByState,
    statesWithCompanionWrites
  );
  const listenerRefClusters = findListenerRefStateClusters(
    states,
    usageByState,
    effects,
    imports,
  );
  const effectClassifications = new Map<EffectCandidate, ClassifiedEffect>();
  const derivedStates = new Set<StateCandidate>();
  for (const effect of effects) {
    const scope = effect.owner ? effectStateScopes.get(effect.owner) : undefined;
    const classification = classifyEffect(
      effect,
      scope?.bySetter ?? EMPTY_STATE_CANDIDATES,
      scope?.byValue ?? EMPTY_STATE_CANDIDATES,
      scope?.usageBySetter ?? EMPTY_STATE_USAGES,
      effect.owner ? useValueBindingsByOwner.get(effect.owner) ?? EMPTY_BINDINGS : EMPTY_BINDINGS,
      effect.owner ? useObservableBindingsByOwner.get(effect.owner) ?? EMPTY_BINDINGS : EMPTY_BINDINGS,
      imports.useRef,
      imports.reactNamespaces,
      moduleScopeBindings,
      nonProductionHarness,
      childContracts
    );
    effectClassifications.set(effect, classification);
    if (classification.derivedState) derivedStates.add(classification.derivedState);
  }
  const legendValueMirrors = findLegendValueMirrors(
    states,
    usageByState,
    legendValueBridges
  );

  const findings: HookFinding[] = [];
  for (const state of states) {
    const usage = usageByState.get(state);
    if (!usage) continue;
    const cluster = effectDrafts.clusters.get(state) ??
      listenerRefClusters.get(state) ??
      observableClusters.get(state) ??
      subtreeClusters.get(state);
    const siblingCut = siblingRenderCuts.get(state);
    const directTransitionCallbacks = reactCommit.directTransitionCallbacks.get(state.owner);
    const transitionTouchesState = directTransitionCallbacks?.some(callback =>
      usage.setterCallNodes.some(call => nodeWithin(call, callback))
    ) ?? true;
    const commitSensitive = commitSensitiveOwners.has(state.owner) &&
      transitionTouchesState &&
      state.setterName !== null &&
      !nonProductionHarness;
    const baseClassification = nonProductionHarness
      ? {
          action: "keep-state" as const,
          confidence: "certain" as const,
          message: `Keep \`${state.valueName}\` in this test, story, or demo harness; production render-boundary migrations do not apply here.`,
        }
      : cluster
      ? {
          action: cluster.action,
          confidence: "probable" as const,
          message: cluster.message,
        }
      : effectDrafts.singletons.has(state)
      ? {
          action: "use-observable" as const,
          confidence: "probable" as const,
          message: (siblingCut
            ? `Replace effect-synchronized React draft \`${state.valueName}\` with one component-lifetime observable; preserve the React synchronization effect and its dependencies, keep producer commands non-tracking, subscribe only in the sibling ${siblingCut.consumerLabel} boundary at line ${siblingCut.consumerLine}, and pass state-independent fallback inputs as ordinary snapshots.`
            : `Replace effect-synchronized React draft \`${state.valueName}\` with one component-lifetime observable; preserve the React synchronization effect and its dependencies, mutate from edit commands, snapshot once at command entry before deferred work, and subscribe only in rendered leaves.`) +
            (hasLazyStateInitializer(state)
              ? " Preserve its lazy initializer as a once-only owner snapshot; do not pass it to Legend as a computed function."
              : ""),
        }
      : derivedStates.has(state)
      ? {
          action: "delete-derived-state" as const,
          confidence: "certain" as const,
          message: `Delete React state \`${state.valueName}\`; it is assigned only by a derivation effect and should be calculated directly.`,
        }
      : legendValueMirrors.get(state) ??
        classifyState(
          state,
          usage,
          localComponents,
          sourceComponents,
          sourceFile,
          propertyLocalObjectDrafts.has(state),
          subtreeByState.get(state) ?? null,
          dialogPayloadCuts.get(state) ?? null,
          safeCommandStates.has(state),
          selfRefreshingCommandStates.has(state),
          observableSelectionOwners.has(state.owner),
          statesWithCompanionWrites.has(state),
          companionWrites.nonClosing.has(state),
          independentStateWrites.directEventWrites.has(state),
          independentStateWrites.visibilitySetterTransports.has(state),
          reactiveMutationAffectedStates.has(state),
          asyncLeafStatuses.isolated.has(state),
          asyncLeafStatuses.cohesive.has(state),
          asyncLeafStatuses.unproven.has(state),
          deferredRevealStates.has(state),
          keyedSelections.collectionStates.has(state),
          keyedSelections.recordStates.has(state),
          keyedSelections.scalarStates.has(state),
          keyedSelections.secondaryLeafStates.has(state),
          observableSubscriptionsByOwner.get(state.owner) ?? 0,
          siblingCut ?? null,
          branchUnmountMoves.get(state) ?? null,
          childContracts,
          deferredCallbackHooks,
          eventCallbacksByOwner.get(state.owner) ?? EMPTY_RUNTIME_FUNCTIONS,
          memoizedOptionCommandStates.has(state),
          returnedKeyedCursorStates.has(state),
          adjacentEventBooleanStates.has(state),
          adjacentEffectBooleanStates.has(state),
          multiSurfaceBooleanStates.has(state),
          sourceEventScalarStates.has(state),
          reactiveHostPropScalarStates.has(state)
        );
    const commitSensitiveOverride = commitSensitive &&
      baseClassification.action !== "review-state" &&
      baseClassification.action !== "keep-state";
    const classification = commitSensitiveOverride
      ? commitSensitiveStateClassification(state)
      : baseClassification;
    const finding = findingFor(
      state.call,
      sourceFile,
      fileName,
      "useState",
      state.valueName,
      classification,
      stateEvidence(state, usage, sourceFile)
    );
    if (cluster && !commitSensitiveOverride) {
      finding.group = {
        id: cluster.id,
        kind: "state-cluster",
        members: cluster.members.map(member => member.valueName),
        primary: state === cluster.primary,
      };
    }
    findings.push(finding);
  }

  for (const call of unmatchedStateCalls) {
    findings.push(
      findingFor(call, sourceFile, fileName, "useState", null, {
        action: "review-state",
        confidence: "probable",
        message: "Review this React state; its binding shape is not a standard `[value, setter]` tuple.",
      })
    );
  }

  for (const effect of effects) {
    const classification = !nonProductionHarness && effectDrafts.effects.has(effect)
      ? {
          action: "review-effect" as const,
          confidence: "probable" as const,
          derivedState: null,
          message: "Preserve this React synchronization effect and its dependency timing; when migrating the paired draft, replace only its setter calls with one atomic observable assignment.",
        }
      : effectClassifications.get(effect);
    if (!classification) continue;
    const scope = effect.owner ? effectStateScopes.get(effect.owner) : undefined;
    findings.push(
      findingFor(
        effect.call,
        sourceFile,
        fileName,
        "useEffect",
        null,
        classification,
        effectEvidence(effect, sourceFile, scope?.bySetter ?? EMPTY_STATE_CANDIDATES)
      )
    );
  }

  return findings.sort(
    (left, right) =>
      left.location.line - right.location.line ||
      left.location.column - right.location.column ||
      left.hook.localeCompare(right.hook)
  );
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
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== call) return null;
  if (!ts.isArrayBindingPattern(declaration.name)) return null;
  const value = declaration.name.elements[0];
  const setter = declaration.name.elements[1];
  if (!value || ts.isOmittedExpression(value) || !ts.isIdentifier(value.name)) return null;
  if (setter && !ts.isOmittedExpression(setter) && !ts.isIdentifier(setter.name)) return null;
  const owner = findAncestor(call, isRuntimeFunctionLike);
  if (!owner) return null;
  const setterName = setter && !ts.isOmittedExpression(setter) && ts.isIdentifier(setter.name) ? setter.name.text : null;
  return {
    call,
    owner,
    setterName,
    valueName: value.name.text,
  };
}

function effectCandidate(call: ts.CallExpression, imports: HookImports): EffectCandidate {
  const callbackArg = call.arguments[0];
  const dependenciesArg = call.arguments[1];
  const owner = findAncestor(call, isRuntimeFunctionLike);
  return {
    call,
    callback: callbackArg
      ? resolveEffectCallback(callbackArg, owner, imports)
      : null,
    dependencies: dependenciesArg && ts.isArrayLiteralExpression(dependenciesArg) ? dependenciesArg : null,
    owner,
  };
}

function resolveEffectCallback(
  expression: ts.Expression,
  owner: RuntimeFunctionLike | null,
  imports: HookImports
): ts.ArrowFunction | ts.FunctionExpression | null {
  const callback = unwrapTransparentExpression(expression);
  if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) return callback;
  if (!owner?.body || !ts.isIdentifier(callback)) return null;

  const declaration = uniqueVariableDeclaration(owner.body, callback.text);
  if (
    !declaration?.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, callback.text) !== 1
  ) {
    return null;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
  if (
    !ts.isCallExpression(initializer) ||
    !isImportedHookCall(initializer, imports.useCallback, imports.reactNamespaces, "useCallback") ||
    initializer.arguments.length !== 2
  ) {
    return null;
  }
  const hookRoot = ts.isIdentifier(initializer.expression)
    ? initializer.expression
    : ts.isPropertyAccessExpression(initializer.expression) && ts.isIdentifier(initializer.expression.expression)
      ? initializer.expression.expression
      : null;
  if (!hookRoot || bindingDeclarationCount(owner, hookRoot.text) !== 0) return null;
  const inner = initializer.arguments[0];
  return inner && (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) ? inner : null;
}

const EMPTY_BINDINGS: ReadonlySet<string> = new Set();
const PURE_MATH_METHODS: ReadonlySet<string> = new Set(["abs", "max", "min"]);
const EMPTY_NODES: ReadonlySet<ts.Node> = new Set();
const EMPTY_RUNTIME_FUNCTIONS: ReadonlySet<RuntimeFunctionLike> = new Set();
const EMPTY_STATE_CANDIDATES: ReadonlyMap<string, StateCandidate> = new Map();
const EMPTY_STATE_USAGES: ReadonlyMap<string, StateUsage> = new Map();

function collectEffectStateScopes(
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>
): ReadonlyMap<RuntimeFunctionLike, EffectStateScope> {
  const scopes = new Map<RuntimeFunctionLike, EffectStateScope>();
  for (const state of states) {
    let scope = scopes.get(state.owner);
    if (!scope) {
      scope = { bySetter: new Map(), byValue: new Map(), usageBySetter: new Map() };
      scopes.set(state.owner, scope);
    }
    scope.byValue.set(state.valueName, state);
    if (!state.setterName) continue;
    scope.bySetter.set(state.setterName, state);
    const usage = usageByState.get(state);
    if (usage) scope.usageBySetter.set(state.setterName, usage);
  }
  return scopes;
}

function collectUseValueBindings(
  sourceFile: ts.SourceFile,
  imports: HookImports
): ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>> {
  const bindings = new Map<RuntimeFunctionLike, Set<string>>();
  visit(sourceFile, node => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
    if (!ts.isCallExpression(node.initializer) || !isLocalHookCall(node.initializer, imports.useValue)) return;
    const owner = findAncestor(node, isRuntimeFunctionLike);
    if (!owner || bindingDeclarationCount(owner, node.name.text) !== 1) return;
    const ownerBindings = bindings.get(owner) ?? new Set<string>();
    ownerBindings.add(node.name.text);
    bindings.set(owner, ownerBindings);
  });
  return bindings;
}

const OBSERVABLE_SUBSCRIPTION_HOOKS = new Set(["useValue", "useSelector", "use$"]);

function collectObservableSubscriptionCounts(
  sourceFile: ts.SourceFile,
  imports: HookImports
): ReadonlyMap<RuntimeFunctionLike, number> {
  const counts = new Map<RuntimeFunctionLike, number>();
  visit(sourceFile, node => {
    if (!ts.isCallExpression(node) || !isObservableSubscriptionHookCall(node, imports)) return;
    const owner = findAncestor(node, isRuntimeFunctionLike);
    if (!owner) return;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  });
  return counts;
}

function isObservableSubscriptionHookCall(
  call: ts.CallExpression,
  imports: HookImports
): boolean {
  const expression = call.expression;
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
  imports: HookImports
): ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>> {
  const bindings = new Map<RuntimeFunctionLike, Set<string>>();
  visit(sourceFile, node => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
    if (!ts.isCallExpression(node.initializer) || !isLocalHookCall(node.initializer, imports.useObservable)) return;
    const declarationList = node.parent;
    if (!ts.isVariableDeclarationList(declarationList)) return;
    if ((declarationList.flags & ts.NodeFlags.Const) === 0) return;
    const owner = findAncestor(node, isRuntimeFunctionLike);
    if (!owner || bindingDeclarationCount(owner, node.name.text) !== 1) return;
    const ownerBindings = bindings.get(owner) ?? new Set<string>();
    ownerBindings.add(node.name.text);
    bindings.set(owner, ownerBindings);
  });
  return bindings;
}


function collectModuleScopeBindings(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const bindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name) bindings.add(clause.name.text);
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) bindings.add(named.name.text);
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) bindings.add(element.name.text);
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      bindings.add(statement.name.text);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      bindings.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, bindings);
      }
    }
  }
  return bindings;
}

function collectReactiveMutationBindings(
  sourceFile: ts.SourceFile
): ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>> {
  const result = new Map<RuntimeFunctionLike, Set<string>>();
  visit(sourceFile, node => {
    if (
      !ts.isVariableDeclaration(node) ||
      !node.initializer ||
      !ts.isCallExpression(node.initializer) ||
      !ts.isIdentifier(node.initializer.expression) ||
      !/^use[A-Z0-9]/.test(node.initializer.expression.text)
    ) {
      return;
    }
    const owner = findAncestor(node, isRuntimeFunctionLike);
    if (!owner) return;
    const bindings = result.get(owner) ?? new Set<string>();
    if (ts.isIdentifier(node.name)) {
      bindings.add(`${node.name.text}.mutate`);
      bindings.add(`${node.name.text}.mutateAsync`);
      result.set(owner, bindings);
      return;
    }
    if (!ts.isObjectBindingPattern(node.name)) return;
    for (const element of node.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const property = element.propertyName?.getText() ?? element.name.text;
      if (property !== "mutate" && property !== "mutateAsync") continue;
      bindings.add(element.name.text);
      result.set(owner, bindings);
    }
  });
  return result;
}

function collectStateUsage(
  state: StateCandidate,
  effectNodes: ReadonlySet<ts.Node>,
  imports: HookImports
): StateUsage {
  const usage: StateUsage = {
    directRenderNodes: [],
    deferredReads: 0,
    effectReads: 0,
    effectWrites: 0,
    escaped: false,
    eventReads: 0,
    jsxTargets: new Set<string>(),
    localRenderReads: 0,
    legendReactionWrites: 0,
    repeatedTransport: false,
    repeatedValueTransport: false,
    setterTargets: new Set<string>(),
    setterCalls: 0,
    setterCallNodes: [],
    setterReferences: 0,
    setterTransportSites: new Set<number>(),
    setterUsesPreviousValue: false,
    shadowed: false,
    transportedOccurrences: 0,
    unstableTransport: false,
    valueTransportSites: new Set<number>(),
    valueTargets: new Set<string>(),
    valueProps: new Map<string, Set<string>>(),
  };

  for (const node of stateBindingIdentifiers(state)) {
    if (isNonValueIdentifier(node)) continue;
    if (isDeclarationName(node)) {
      if (node.text === state.valueName || (state.setterName !== null && node.text === state.setterName)) {
        if (!isOriginalStateBinding(node, state.call)) usage.shadowed = true;
      }
      continue;
    }

    if (state.setterName !== null && node.text === state.setterName) {
      classifySetterReference(node, state, effectNodes, imports, usage);
      continue;
    }
    if (node.text === state.valueName) {
      classifyValueReference(node, state, effectNodes, imports, usage);
    }
  }

  const callableReads = collectCommandOnlyCallableReads(state, effectNodes);
  const renderCallableSites = callableReads.renderSites;
  if (renderCallableSites.length > 0) {
    usage.localRenderReads += renderCallableSites.length;
    usage.directRenderNodes.push(...renderCallableSites);
  }
  if (usage.effectReads === 0) {
    usage.effectReads += callableReads.effectSites.length;
  }

  return usage;
}

function stateBindingIdentifiers(state: StateCandidate): readonly ts.Identifier[] {
  const values = identifiersNamed(state.owner.body, state.valueName);
  if (!state.setterName || state.setterName === state.valueName) return values;
  const setters = identifiersNamed(state.owner.body, state.setterName);
  if (values.length === 0) return setters;
  if (setters.length === 0) return values;

  const ordered: ts.Identifier[] = [];
  let valueIndex = 0;
  let setterIndex = 0;
  while (valueIndex < values.length && setterIndex < setters.length) {
    const value = values[valueIndex]!;
    const setter = setters[setterIndex]!;
    if (value.pos < setter.pos) {
      ordered.push(value);
      valueIndex += 1;
    } else {
      ordered.push(setter);
      setterIndex += 1;
    }
  }
  ordered.push(...values.slice(valueIndex), ...setters.slice(setterIndex));
  return ordered;
}

function addMapSet<Key, Value>(map: Map<Key, Set<Value>>, key: Key, value: Value): void {
  const values = map.get(key) ?? new Set<Value>();
  values.add(value);
  map.set(key, values);
}

function siblingProducerConsumerCut(
  state: StateCandidate,
  usage: StateUsage,
  effectNodes: ReadonlySet<ts.Node>
): SiblingRenderCut | null {
  const localConsumer = usage.transportedOccurrences === 0 &&
    usage.localRenderReads > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length;
  const transportedConsumer = usage.localRenderReads === 0 &&
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1 &&
    usage.setterTransportSites.size === 1 &&
    usage.setterTargets.size === 1 &&
    usage.setterCalls === 0 &&
    usage.setterReferences === 1 &&
    usage.transportedOccurrences === 2 &&
    !usage.repeatedTransport &&
    !usage.unstableTransport;
  if (
    !state.setterName ||
    isCustomHookOwner(state.owner) ||
    jsxElementCount(state.owner) < 5 ||
    (!localConsumer && !transportedConsumer) ||
    usage.effectReads > 0 ||
    usage.deferredReads > 0 ||
    usage.setterUsesPreviousValue ||
    usage.shadowed ||
    usage.escaped ||
    stateMayHoldCallable(state)
  ) {
    return null;
  }

  const consumer = siblingProjectionConsumer(state, usage);
  if (!consumer) return null;
  const commandCalls = usage.setterCallNodes.filter(call => !hasAncestorInSet(call, effectNodes));
  const commandProducers = commandCalls.map(call => jsxProducerForSetterCall(call, state.owner));
  const producer = commandCalls.length > 0
    ? commandProducers[0]
    : directTransportProducer(usage, state.owner);
  if (
    !producer ||
    commandProducers.some(candidate => candidate !== producer) ||
    commandCalls.some(call => !mutationRegionOnlyCallsStateSetters(
      nearestMutationFunction(call, state.owner),
      new Set([state.setterName!])
    ))
  ) {
    return null;
  }

  const producerSubtree: JsxSubtreeNode = ts.isJsxOpeningElement(producer) ? producer.parent : producer;
  if (
    producerSubtree === consumer ||
    nodeWithin(producerSubtree, consumer) ||
    nodeWithin(consumer, producerSubtree) ||
    nearestRepeatedRenderCall(producerSubtree, state.owner) ||
    hasUnstableSubtreeLifetime(producerSubtree, state.owner) ||
    hasUnstableSubtreeLifetime(consumer, state.owner) ||
    !shareUniqueOwnerReturn(producerSubtree, consumer, state.owner)
  ) {
    return null;
  }

  return {
    consumerLabel: jsxSubtreeLabel(consumer),
    consumerLine: consumer.getSourceFile().getLineAndCharacterOfPosition(consumer.getStart()).line + 1,
  };
}

function siblingProjectionConsumer(
  state: StateCandidate,
  usage: StateUsage
): JsxSubtreeNode | null {
  if (usage.localRenderReads === 0) {
    const callSite = directUniqueReturnCallSite(usage, state.owner);
    const opening = callSite?.opening;
    if (!opening) return null;
    return ts.isJsxOpeningElement(opening) ? opening.parent : opening;
  }
  const references = oneHopRenderProjectionReferences(state.owner, usage.directRenderNodes);

  if (
    !references ||
    references.some(reference =>
      (isRenderGateReference(reference, state.owner) &&
        !findAncestorUntil(reference, ts.isJsxAttribute, state.owner)) ||
      !findAncestorUntil(reference, isJsxNode, state.owner) ||
      (!isSafeJsxProjectionReference(reference, state.owner, new Set(["cn"])) &&
        !isSnapshotFallbackReference(reference, state.owner))
    )
  ) {
    return null;
  }

  const repeated = references.map(reference => nearestRepeatedRenderCall(reference, state.owner));
  const repeatedCall = repeated[0];
  if (repeated.some(call => call !== repeatedCall)) return null;
  const consumer = repeatedCall
    ? jsxSubtreeAncestors(repeatedCall, state.owner)[0] ?? null
    : lowestCommonJsxSubtree(references, state.owner);
  return consumer && jsxElementCountIn(consumer) / jsxElementCount(state.owner) <= 0.4
    ? consumer
    : null;
}

function isSnapshotFallbackReference(reference: ts.Identifier, boundary: ts.Node): boolean {
  const attribute = findAncestorUntil(reference, ts.isJsxAttribute, boundary);
  const initializer = attribute?.initializer;
  if (
    !initializer ||
    !ts.isJsxExpression(initializer) ||
    !initializer.expression
  ) {
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
  visit(expression.right, node => {
    if (ts.isIdentifier(node) && node.text === reference.text) readsStateAgain = true;
  });
  return !readsStateAgain;
}


function directTransportProducer(
  usage: StateUsage,
  owner: RuntimeFunctionLike
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const site = [...usage.setterTransportSites][0];
  const valueCallSite = directUniqueReturnCallSite(usage, owner);
  if (site === undefined || !valueCallSite) return null;
  const openings: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
  visitSkippingNestedRuntimeFunctions(valueCallSite.returned, node => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.getStart() === site
    ) {
      openings.push(node);
    }
  });
  return openings.length === 1 ? openings[0]! : null;
}

function jsxProducerForSetterCall(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const directAttribute = findAncestorUntil(call, ts.isJsxAttribute, owner);
  if (directAttribute && /^on[A-Z]/.test(directAttribute.name.getText())) {
    return jsxOpeningForAttribute(directAttribute);
  }

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
  if (!name || bindingDeclarationCount(owner, name) !== 1) return null;
  const openings: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
  let unsafeReference = false;
  visit(owner.body, node => {
    if (
      unsafeReference ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    const opening = attribute &&
      /^on[A-Z]/.test(attribute.name.getText()) &&
      isDirectJsxAttributeExpression(attribute, node)
      ? jsxOpeningForAttribute(attribute)
      : null;
    if (opening) openings.push(opening);
    else unsafeReference = true;
  });
  return !unsafeReference && openings.length === 1 ? openings[0]! : null;
}

function localCallbackBindingName(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression
): string | null {
  if (ts.isFunctionDeclaration(callback)) return callback.name?.text ?? null;
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
  childContracts: ChildContractResolver | null
): ReadonlySet<RuntimeFunctionLike> {
  const callbacks = new Set<RuntimeFunctionLike>();
  if (!owner.body) return callbacks;
  visitDirectOwnerNodes(owner.body, node => {
    if (
      node !== owner &&
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    ) {
      const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
      if (
        attribute?.initializer &&
        ts.isJsxExpression(attribute.initializer) &&
        attribute.initializer.expression &&
        unwrapTransparentExpression(attribute.initializer.expression) === node &&
        jsxEventAttributeIsDeferred(attribute, childContracts)
      ) {
        callbacks.add(node);
      }
    }
    const binding = ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      ? node.name.text
      : ts.isFunctionDeclaration(node) && node.name
        ? node.name.text
        : null;
    if (!binding) return;
    const callback = localCallbackByBinding(owner, binding, imports);
    if (!callback) return;
    const publications = jsxComponentPublications(owner, binding);
    if (
      publications.length > 0 &&
      publications.every(publication =>
        (
          /^on[A-Z]/.test(publication.prop) &&
          (publication.intrinsic ||
            childContracts?.frameworkEventComponent(publication.component) === true)
        ) ||
        (
          childContracts?.componentCallbackPropIsDeferred(
            publication.component,
            publication.prop
          ) === true
        )
      )
    ) {
      callbacks.add(callback);
    }
  });
  return callbacks;
}

function sourceProvenOptionEventCallbacks(
  owner: RuntimeFunctionLike,
  imports: HookImports,
  childContracts: ChildContractResolver
): ReadonlySet<RuntimeFunctionLike> {
  const callbacks = new Set<RuntimeFunctionLike>();
  if (!owner.body) return callbacks;
  visitSkippingNestedRuntimeFunctions(owner.body, node => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.initializer ||
      bindingDeclarationCount(owner, node.name.text) !== 1
    ) {
      return;
    }
    const memo = memoizedObjectLiteral(node.initializer, imports);
    if (!memo || memo.object.properties.some(ts.isSpreadAssignment)) return;
    const publications = jsxComponentPublications(
      owner,
      node.name.text
    );
    if (publications.length === 0) return;
    for (const property of memo.object.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
      const propertyName = staticPropertyName(property.name);
      const callbackName = ts.isShorthandPropertyAssignment(property)
        ? property.name
        : unwrapTransparentExpression(property.initializer);
      if (!propertyName || !ts.isIdentifier(callbackName)) continue;
      const callback = localCallbackByBinding(owner, callbackName.text, imports);
      if (
        !callback ||
        !memo.dependencies.elements.some(element =>
          ts.isIdentifier(element) && element.text === callbackName.text
        ) ||
        !callbackPublishedOnlyThroughMemo(
          owner,
          callbackName.text,
          property,
          memo.call
        ) ||
        !publications.every(publication =>
          childContracts.componentPropCallbackIsDeferred(
            publication.component,
            publication.prop,
            propertyName
          )
        )
      ) {
        continue;
      }
      callbacks.add(callback);
    }
  });
  return callbacks;
}

interface MemoizedObjectLiteral {
  call: ts.CallExpression;
  dependencies: ts.ArrayLiteralExpression;
  object: ts.ObjectLiteralExpression;
}

function memoizedObjectLiteral(
  initializer: ts.Expression,
  imports: HookImports
): MemoizedObjectLiteral | null {
  const call = unwrapTransparentExpression(initializer);
  if (
    !ts.isCallExpression(call) ||
    !isImportedHookCall(call, imports.useMemo, imports.reactNamespaces, "useMemo") ||
    call.arguments.length !== 2
  ) {
    return null;
  }
  const factory = call.arguments[0];
  const dependencies = call.arguments[1];
  if (
    !factory ||
    (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) ||
    !dependencies ||
    !ts.isArrayLiteralExpression(dependencies)
  ) {
    return null;
  }
  let expression: ts.Expression | null = ts.isBlock(factory.body)
    ? factory.body.statements.length === 1 &&
        ts.isReturnStatement(factory.body.statements[0]!) &&
        factory.body.statements[0]!.expression
      ? factory.body.statements[0]!.expression
      : null
    : factory.body;
  if (!expression) return null;
  expression = unwrapTransparentExpression(expression);
  return ts.isObjectLiteralExpression(expression)
    ? { call, dependencies, object: expression }
    : null;
}

interface ComponentPublication {
  component: string;
  intrinsic: boolean;
  prop: string;
}

function jsxComponentPublications(
  owner: RuntimeFunctionLike,
  binding: string
): readonly ComponentPublication[] {
  const publications: ComponentPublication[] = [];
  let safe = true;
  for (const node of identifiersNamed(owner.body, binding)) {
    if (!safe) break;
    if (isDeclarationName(node) || isNonValueIdentifier(node)) continue;
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    const component = attribute ? jsxTargetName(attribute) : null;
    if (
      !attribute ||
      !component ||
      !isJsxEventHandlerReference(attribute, node)
    ) {
      safe = false;
      continue;
    }
    publications.push({
      component,
      intrinsic: !isCustomJsxTarget(component),
      prop: attribute.name.getText(),
    });
  }
  return safe ? publications : [];
}

function callbackPublishedOnlyThroughMemo(
  owner: RuntimeFunctionLike,
  binding: string,
  property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  memoCall: ts.CallExpression
): boolean {
  let propertyReferences = 0;
  let safe = true;
  for (const node of identifiersNamed(owner.body, binding)) {
    if (!safe) break;
    if (isDeclarationName(node) || isNonValueIdentifier(node)) continue;
    if (nodeWithin(node, property)) {
      propertyReferences += 1;
      continue;
    }
    if (isHookDependencyReference(node, new Set(["useMemo"]))) {
      const call = findAncestorUntil(node, ts.isCallExpression, owner);
      if (call === memoCall) continue;
    }
    safe = false;
  }
  return safe && propertyReferences === 1;
}

function localCallbackByBinding(
  owner: RuntimeFunctionLike,
  binding: string,
  imports: HookImports
): RuntimeFunctionLike | null {
  if (!owner.body || bindingDeclarationCount(owner, binding) !== 1) return null;
  let callbacks = localCallbacksByOwner.get(owner);
  if (!callbacks) {
    const collected = new Map<string, RuntimeFunctionLike>();
    visitDirectOwnerNodes(owner.body, node => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        collected.set(node.name.text, node);
        return;
      }
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
        return;
      }
      const initializer = unwrapTransparentExpression(node.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        collected.set(node.name.text, initializer);
        return;
      }
      const callback = ts.isCallExpression(initializer) &&
        isImportedHookCall(initializer, imports.useCallback, imports.reactNamespaces, "useCallback")
        ? initializer.arguments[0]
        : null;
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        collected.set(node.name.text, callback);
      }
    });
    callbacks = collected;
    localCallbacksByOwner.set(owner, callbacks);
  }
  return callbacks.get(binding) ?? null;
}

const localCallbacksByOwner = new WeakMap<
  RuntimeFunctionLike,
  ReadonlyMap<string, RuntimeFunctionLike>
>();

function visitDirectOwnerNodes(
  node: ts.Node,
  callback: (node: ts.Node) => void
): void {
  node.forEachChild(child => {
    callback(child);
    if (!isRuntimeFunctionLike(child)) visitDirectOwnerNodes(child, callback);
  });
}

function jsxOpeningForAttribute(
  attribute: ts.JsxAttribute
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const opening = attribute.parent.parent;
  return ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening) ? opening : null;
}

function shareUniqueOwnerReturn(
  left: ts.Node,
  right: ts.Node,
  owner: RuntimeFunctionLike
): boolean {
  const returned = uniqueReturnedExpression(owner);
  return !!returned && nodeWithin(left, returned) && nodeWithin(right, returned);
}

function findObservableStateClusters(
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  knownComponents: ReadonlySet<string>,
  sourceFile: ts.SourceFile,
  stateFlow: StateFlowIndex,
  childContracts: ChildContractResolver | null
): ReadonlyMap<StateCandidate, StateCluster> {
  const result = new Map<StateCandidate, StateCluster>();
  const statesByOwner = new Map<RuntimeFunctionLike, StateCandidate[]>();
  for (const state of states) {
    const ownerStates = statesByOwner.get(state.owner) ?? [];
    ownerStates.push(state);
    statesByOwner.set(state.owner, ownerStates);
  }

  for (const [owner, ownerStates] of statesByOwner) {
    const ownerElements = jsxElementCount(owner);
    if (ownerElements < 8) continue;
    const hasLargeSourceOwner = ownerLineSpan(owner, sourceFile) >= 100;
    const broadOwner = ownerElements >= 12;
    const mutableStates: StateCandidate[] = ownerStates.filter(state => state.setterName !== null);
    const stateBySetter = new Map(
      mutableStates.flatMap(state => state.setterName ? [[state.setterName, state] as const] : [])
    );
    const calls: SetterMutation[] = [];
    visit(owner.body, node => {
      if (
        !ts.isCallExpression(node) ||
        !ts.isIdentifier(node.expression)
      ) {
        return;
      }
      const state = stateBySetter.get(node.expression.text);
      if (!state) return;
      calls.push({
        call: node,
        region: nearestMutationFunction(node, owner),
        state,
      });
    });

    const union = new DisjointSet(mutableStates.length);
    for (let leftIndex = 0; leftIndex < calls.length; leftIndex += 1) {
      const left = calls[leftIndex];
      if (!left) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < calls.length; rightIndex += 1) {
        const right = calls[rightIndex];
        if (!right || left.state === right.state) continue;
        if (
          left.region !== right.region ||
          !mutationsAreProvenCoexecuting(left.call, right.call, left.region, stateFlow)
        ) continue;
        const leftStateIndex = mutableStates.indexOf(left.state);
        const rightStateIndex = mutableStates.indexOf(right.state);
        if (leftStateIndex >= 0 && rightStateIndex >= 0) union.join(leftStateIndex, rightStateIndex);
      }
    }

    const components = new Map<number, StateCandidate[]>();
    for (let index = 0; index < mutableStates.length; index += 1) {
      const state = mutableStates[index];
      if (!state) continue;
      const root = union.find(index);
      const members = components.get(root) ?? [];
      members.push(state);
      components.set(root, members);
    }

    for (const members of components.values()) {
      const dialogMembers = broadOwner && hasLargeSourceOwner
        ? normalizeObservableDialogClusterMembers(
            members,
            usageByState,
            knownComponents,
            calls,
            stateFlow
          ) ?? normalizePersistentScalarDialogClusterMembers(
            members,
            usageByState,
            knownComponents,
            calls,
            stateFlow,
            childContracts
          )
        : null;
      const gatedFeedbackMembers = broadOwner && !dialogMembers
        ? normalizeGatedFeedbackClusterMembers(
            members,
            usageByState,
            calls,
            stateFlow
          )
        : null;
      const textDraftMembers = broadOwner && hasLargeSourceOwner && !dialogMembers && !gatedFeedbackMembers
        ? normalizeObservableTextDraftClusterMembers(members, usageByState, calls, stateFlow)
        : null;
      const selectionMembers = hasLargeSourceOwner && !dialogMembers && !gatedFeedbackMembers && !textDraftMembers
        ? normalizeObservableSelectionClusterMembers(members, usageByState, calls, stateFlow)
        : null;
      const clusterMembers = dialogMembers ?? gatedFeedbackMembers ?? textDraftMembers ?? selectionMembers;
      if (!clusterMembers) continue;
      const hasBoundedDialogGate = dialogMembers?.some(
        state => stateHasBoundedDialogGate(state, dialogMembers, usageByState, knownComponents)
      ) ?? false;
      if (
        dialogMembers &&
        !hasBoundedDialogGate &&
        clusterMembers.some(member => {
          const usage = usageByState.get(member);
          return usage !== undefined && usage.localRenderReads > 0 && usage.jsxTargets.size === 0;
        })
      ) {
        continue;
      }
      const sortedMembers = [...clusterMembers].sort((left, right) => left.call.getStart() - right.call.getStart());
      const primary = sortedMembers[0];
      if (!primary) continue;
      const names = sortedMembers.map(state => state.valueName);
      const targets = new Set(
        sortedMembers.flatMap(state => [...(usageByState.get(state)?.jsxTargets ?? [])])
      );
      const cluster: StateCluster = {
        action: "use-observable",
        id: `state-cluster:${owner.getStart(sourceFile)}:${names.join(",")}`,
        members: sortedMembers,
        message: selectionMembers
          ? `Replace the co-written selection mode (${names.map(name => `\`${name}\``).join(", ")}) with one component-lifetime observable object; preserve mode-and-clear transitions with atomic \`assign\` calls, keep independent collection edits as leaf writes, snapshot command reads with \`peek\`, and subscribe with \`useValue\` only at header, control, and keyed-row leaves.`
          : gatedFeedbackMembers
          ? `Replace the payload and timed feedback state (${names.map(name => `\`${name}\``).join(", ")}) with one component-lifetime observable model; preserve the timer and command timing, batch the paired reset, read the payload command with \`peek\`, subscribe to the payload-gated content at its stable call site, and subscribe to feedback again only in its nested feedback leaf.`
          : textDraftMembers
          ? `Replace the co-written editable draft (${names.map(name => `\`${name}\``).join(", ")}) with one component-lifetime observable object; preserve cursor-and-name transitions with atomic \`assign\` calls, keep controlled name edits as leaf writes, snapshot command reads with \`peek\`, and subscribe with \`useValue\` only at the rendered row or control leaves.`
          : hasBoundedDialogGate
          ? `Replace the persistent dialog state (${names.map(name => `\`${name}\``).join(", ")}) with one component-lifetime observable model; atomically assign the payload and open flag, keep close transitions as leaf writes, and move the complete payload gate plus ${[...targets].sort().join(", ")} into one always-mounted stable leaf wrapper. Subscribe there with \`useValue\` so the existing payload gate and dialog mount behavior stay unchanged.`
          : `Replace the co-written React state cluster (${names.map(name => `\`${name}\``).join(", ")}) with one component-lifetime observable dialog model; preserve paired payload/open transitions with atomic \`assign\` calls, keep independent close updates as leaf writes, and subscribe with \`useValue\` only inside ${[...targets].sort().join(", ")}.`,
        primary,
      };
      for (const member of sortedMembers) result.set(member, cluster);
    }
  }

  return result;
}

function normalizeObservableSelectionClusterMembers(
  members: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  mutations: readonly SetterMutation[],
  stateFlow: StateFlowIndex
): readonly StateCandidate[] | null {
  if (members.length !== 2) return null;
  const mode = members.find(state => hasStateInitializer(state, ts.SyntaxKind.FalseKeyword));
  const selection = members.find(hasEmptyArrayStateInitializer);
  if (!mode || !selection || mode === selection) return null;

  const modeUsage = usageByState.get(mode);
  const selectionUsage = usageByState.get(selection);
  if (
    !modeUsage ||
    !selectionUsage ||
    [modeUsage, selectionUsage].some(usage =>
      usage.shadowed || usage.escaped || usage.effectReads > 0 || usage.effectWrites > 0
    ) ||
    modeUsage.setterUsesPreviousValue ||
    stateMayHoldCallable(mode) ||
    stateMayHoldCallable(selection) ||
    modeUsage.setterReferences !== modeUsage.setterCalls ||
    selectionUsage.setterReferences !== selectionUsage.setterCalls ||
    !renderReadsStayInJsxAttributes(mode, modeUsage) ||
    !renderReadsStayInJsxAttributes(selection, selectionUsage)
  ) {
    return null;
  }

  const modeMutations = mutations.filter(mutation => mutation.state === mode);
  const selectionMutations = mutations.filter(mutation => mutation.state === selection);
  const resets = selectionMutations.filter(mutation => callSetsEmptyArray(mutation));
  const edits = selectionMutations.filter(mutation => !callSetsEmptyArray(mutation));
  if (
    modeMutations.length < 2 ||
    resets.length < 1 ||
    edits.length < 1 ||
    !modeMutations.some(mutation => callSetsLiteral(mutation, ts.SyntaxKind.TrueKeyword)) ||
    !modeMutations.some(mutation => callSetsLiteral(mutation, ts.SyntaxKind.FalseKeyword)) ||
    edits.some(mutation => !setterCallUsesPreviousValue(mutation.call))
  ) {
    return null;
  }

  const paired = (left: SetterMutation, right: SetterMutation) =>
    left.region === right.region &&
    (callsAreAdjacentDraftWrites(left.call, right.call) ||
      mutationsAreProvenCoexecuting(left.call, right.call, left.region, stateFlow));
  if (modeMutations.some(modeMutation => !resets.some(reset => paired(modeMutation, reset)))) {
    return null;
  }
  return [mode, selection];
}

function hasEmptyArrayStateInitializer(state: StateCandidate): boolean {
  const initializer = state.call.arguments[0];
  if (!initializer) return false;
  const value = unwrapTransparentExpression(initializer);
  return ts.isArrayLiteralExpression(value) && value.elements.length === 0;
}

function callSetsEmptyArray(mutation: SetterMutation): boolean {
  const argument = mutation.call.arguments[0];
  if (!argument) return false;
  const value = unwrapTransparentExpression(argument);
  return ts.isArrayLiteralExpression(value) && value.elements.length === 0;
}

function renderReadsStayInJsxAttributes(
  state: StateCandidate,
  usage: StateUsage
): boolean {
  return usage.localRenderReads + usage.transportedOccurrences > 0 &&
    usage.directRenderNodes.every(node =>
      findAncestorUntil(node, ts.isJsxAttribute, state.owner) !== null
    );
}

function normalizeObservableTextDraftClusterMembers(
  members: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  mutations: readonly SetterMutation[],
  stateFlow: StateFlowIndex
): readonly StateCandidate[] | null {
  if (members.length !== 2) return null;
  const cursor = members.find(state => hasStateInitializer(state, ts.SyntaxKind.NullKeyword));
  const draft = members.find(state => hasEmptyStringStateInitializer(state));
  if (!cursor || !draft || cursor === draft) return null;

  const cursorUsage = usageByState.get(cursor);
  const draftUsage = usageByState.get(draft);
  if (
    !cursorUsage ||
    !draftUsage ||
    [cursorUsage, draftUsage].some(usage =>
      usage.shadowed ||
      usage.escaped ||
      usage.effectReads > 0 ||
      usage.effectWrites > 0 ||
      usage.setterUsesPreviousValue
    ) ||
    stateMayHoldCallable(cursor) ||
    stateMayHoldCallable(draft) ||
    cursorUsage.localRenderReads + cursorUsage.transportedOccurrences === 0 ||
    draftUsage.localRenderReads + draftUsage.transportedOccurrences === 0 ||
    cursorUsage.setterReferences !== cursorUsage.setterCalls ||
    !setterReferencesAreCallsOrControlledValueWrites(draft)
  ) {
    return null;
  }

  const cursorMutations = mutations.filter(mutation => mutation.state === cursor);
  const draftMutations = mutations.filter(mutation => mutation.state === draft);
  const cursorClears = cursorMutations.filter(mutation =>
    callSetsLiteral(mutation, ts.SyntaxKind.NullKeyword)
  );
  const cursorOpens = cursorMutations.filter(mutation =>
    !callSetsLiteral(mutation, ts.SyntaxKind.NullKeyword)
  );
  if (
    cursorMutations.length < 2 ||
    draftMutations.length < 1 ||
    cursorClears.length < 1 ||
    cursorOpens.length < 1
  ) {
    return null;
  }

  const coexecutes = (left: SetterMutation, right: SetterMutation) =>
    left.region === right.region &&
    (callsAreAdjacentDraftWrites(left.call, right.call) ||
      mutationsAreProvenCoexecuting(left.call, right.call, left.region, stateFlow));
  if (cursorOpens.some(cursorMutation =>
    !draftMutations.some(draftMutation => coexecutes(cursorMutation, draftMutation))
  ) || cursorClears.some(mutation => !mutationIsEventRooted(mutation, cursor))) {
    return null;
  }
  for (const cursorMutation of cursorMutations) {
    for (const draftMutation of draftMutations) {
      if (
        cursorMutation.region === draftMutation.region &&
        mutationsMayCoexecute(
          cursorMutation.call,
          draftMutation.call,
          cursorMutation.region,
          stateFlow
        ) &&
        !coexecutes(cursorMutation, draftMutation)
      ) {
        return null;
      }
    }
  }
  if (draftMutations.some(draftMutation =>
    !cursorMutations.some(cursorMutation => coexecutes(draftMutation, cursorMutation)) &&
    !controlledValueSetterCall(draftMutation.call, draft) &&
    !mutationIsEventRooted(draftMutation, draft)
  )) {
    return null;
  }
  return [cursor, draft];
}

function callsAreAdjacentDraftWrites(
  left: ts.CallExpression,
  right: ts.CallExpression
): boolean {
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
  const parent = leftStatement.parent;
  const statements = ts.isBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)
    ? parent.statements
    : null;
  return !!statements &&
    Math.abs(statements.indexOf(leftStatement) - statements.indexOf(rightStatement)) === 1;
}

function hasEmptyStringStateInitializer(state: StateCandidate): boolean {
  const initializer = state.call.arguments[0];
  if (!initializer) return false;
  const value = unwrapTransparentExpression(initializer);
  return ts.isStringLiteral(value) && value.text === "";
}

function setterReferencesAreCallsOrControlledValueWrites(state: StateCandidate): boolean {
  if (!state.setterName) return false;
  let controlledWrites = 0;
  let safe = true;
  visit(state.owner.body, node => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.setterName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const setterCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
    const attribute = controlledValueWriteAttribute(node, state);
    if (setterCall) {
      if (attribute) controlledWrites += 1;
      return;
    }
    if (
      !attribute ||
      !isDirectJsxAttributeExpression(attribute, node)
    ) {
      safe = false;
      return;
    }
    controlledWrites += 1;
  });
  return safe && controlledWrites > 0;
}

function controlledValueWriteAttribute(
  node: ts.Identifier,
  state: StateCandidate
): ts.JsxAttribute | null {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
  if (!attribute || !isControlledInteractionProp(attribute.name.getText())) return null;
  const opening = jsxOpeningForAttribute(attribute);
  const hasValue = opening?.attributes.properties.some(property => {
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

function controlledValueSetterCall(
  call: ts.CallExpression,
  state: StateCandidate
): boolean {
  return ts.isIdentifier(call.expression) &&
    controlledValueWriteAttribute(call.expression, state) !== null;
}

function mutationIsEventRooted(
  mutation: SetterMutation,
  state: StateCandidate
): boolean {
  const region = mutation.region;
  return region !== state.owner &&
    (ts.isArrowFunction(region) ||
      ts.isFunctionDeclaration(region) ||
      ts.isFunctionExpression(region)) &&
    callbackIsEventRooted(region, state.owner, "", new Set());
}

function findStateCompanionWrites(
  states: readonly StateCandidate[],
  stateFlow: StateFlowIndex
): {
  all: ReadonlySet<StateCandidate>;
  nonClosing: ReadonlySet<StateCandidate>;
} {
  const all = new Set<StateCandidate>();
  const nonClosing = new Set<StateCandidate>();
  const statesByOwner = new Map<RuntimeFunctionLike, StateCandidate[]>();
  for (const state of states) {
    if (!state.setterName) continue;
    const ownerStates = statesByOwner.get(state.owner) ?? [];
    ownerStates.push(state);
    statesByOwner.set(state.owner, ownerStates);
  }

  for (const [owner, ownerStates] of statesByOwner) {
    const stateBySetter = new Map(
      ownerStates.flatMap(state => state.setterName ? [[state.setterName, state] as const] : [])
    );
    const mutations: SetterMutation[] = [];
    visit(owner.body, node => {
      if (
        !ts.isCallExpression(node) ||
        !ts.isIdentifier(node.expression)
      ) {
        return;
      }
      const state = stateBySetter.get(node.expression.text);
      if (!state) return;
      const region = nearestMutationFunction(node, owner);
      mutations.push({ call: node, region, state });
    });

    for (let leftIndex = 0; leftIndex < mutations.length; leftIndex += 1) {
      const left = mutations[leftIndex];
      if (!left) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < mutations.length; rightIndex += 1) {
        const right = mutations[rightIndex];
        if (
          !right ||
          left.state === right.state ||
          left.region !== right.region ||
          !mutationsMayCoexecute(left.call, right.call, left.region, stateFlow)
        ) {
          continue;
        }
        all.add(left.state);
        all.add(right.state);
        if (!mutationIsProvenCloseDuringCompanion(left, right)) nonClosing.add(left.state);
        if (!mutationIsProvenCloseDuringCompanion(right, left)) nonClosing.add(right.state);
      }
    }
  }

  return { all, nonClosing };
}

function mutationIsProvenCloseDuringCompanion(
  mutation: SetterMutation,
  companion: SetterMutation
): boolean {
  if (callSetsLiteral(mutation, ts.SyntaxKind.FalseKeyword)) return true;
  const argument = mutation.call.arguments[0];
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
  name: string
): boolean {
  const parameter = owner.parameters.find(candidate =>
    ts.isIdentifier(candidate.name) && candidate.name.text === name
  );
  if (!parameter) return false;
  if (parameter.type?.kind === ts.SyntaxKind.BooleanKeyword) return true;
  const attribute = findAncestorUntil(owner, ts.isJsxAttribute, state.owner);
  if (
    !attribute?.initializer ||
    !ts.isJsxExpression(attribute.initializer) ||
    attribute.initializer.expression !== owner
  ) {
    return false;
  }
  const opening = attribute.parent.parent;
  return (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) &&
    isVisibilityTransitionAttribute(opening, attribute.name.getText(), state.valueName);
}

function runtimeParameterIsReassigned(owner: RuntimeFunctionLike, name: string): boolean {
  if (!owner.body) return true;
  let reassigned = false;
  visitSkippingNestedRuntimeFunctions(owner.body, node => {
    if (!ts.isBinaryExpression(node)) return;
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
  if (
    !ts.isPrefixUnaryExpression(value) ||
    value.operator !== ts.SyntaxKind.ExclamationToken
  ) {
    return false;
  }
  const operand = unwrapTransparentExpression(value.operand);
  return ts.isIdentifier(operand) && operand.text === name;
}

function findBranchUnmountMoves(
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  safeCommandStates: ReadonlySet<StateCandidate>,
  stateFlow: StateFlowIndex
): ReadonlyMap<StateCandidate, BranchUnmountMove> {
  const result = new Map<StateCandidate, BranchUnmountMove>();
  for (const state of states) {
    const usage = usageByState.get(state);
    if (
      !state.setterName ||
      !safeCommandStates.has(state) ||
      !hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) ||
      !usage ||
      usage.localRenderReads !== 0 ||
      usage.effectReads !== 0 ||
      usage.effectWrites !== 0 ||
      usage.deferredReads !== 0 ||
      usage.valueTransportSites.size !== 1 ||
      usage.valueTargets.size !== 1 ||
      usage.repeatedTransport ||
      usage.setterReferences !== usage.setterCalls ||
      usage.setterCallNodes.length < 2 ||
      usage.shadowed ||
      usage.escaped
    ) {
      continue;
    }

    const callSite = directBranchReturnCallSite(usage, state.owner);
    const target = [...usage.valueTargets][0];
    if (!callSite || !target) continue;
    const subtree: ts.Node = ts.isJsxOpeningElement(callSite.opening)
      ? callSite.opening.parent
      : callSite.opening;
    const gate = exactDiscriminatedBranchGate(callSite.opening, state.owner, states);
    if (!gate) continue;
    const controllerUsage = usageByState.get(gate.controller);
    if (
      !gate.controller.setterName ||
      !controllerUsage ||
      controllerUsage.shadowed ||
      controllerUsage.escaped
    ) {
      continue;
    }

    const branchCalls = usage.setterCallNodes.filter(call => nodeWithin(call, subtree));
    const outsideCalls = usage.setterCallNodes.filter(call => !nodeWithin(call, subtree));
    if (
      branchCalls.length === 0 ||
      outsideCalls.length === 0 ||
      !branchCalls.every(call => isDirectBranchInteractionWrite(call, callSite.opening, state)) ||
      !outsideCalls.every(call =>
        isBranchUnmountReset(
          call,
          state,
          gate,
          controllerUsage,
          stateFlow
        )
      )
    ) {
      continue;
    }
    result.set(state, { target });
  }
  return result;
}

interface DiscriminatedBranchGate {
  controller: StateCandidate;
  property: string;
  value: string;
}

function exactDiscriminatedBranchGate(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  owner: RuntimeFunctionLike,
  states: readonly StateCandidate[]
): DiscriminatedBranchGate | null {
  let conditional: ts.ConditionalExpression | null = null;
  for (let current: ts.Node | undefined = opening.parent; current && current !== owner; current = current.parent) {
    if (
      ts.isConditionalExpression(current) &&
      nodeWithin(opening, current.whenTrue) &&
      unwrapTransparentExpression(current.whenFalse).kind === ts.SyntaxKind.NullKeyword
    ) {
      conditional = current;
      break;
    }
  }
  if (!conditional) return null;
  const condition = unwrapTransparentExpression(conditional.condition);
  if (
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
  const controllerName = left.expression.text;
  const matches = states.filter(state =>
    state.owner === owner && state.valueName === controllerName
  );
  return matches.length === 1
    ? { controller: matches[0]!, property: left.name.text, value: right.text }
    : null;
}

function isDirectBranchInteractionWrite(
  call: ts.CallExpression,
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  state: StateCandidate
): boolean {
  const attribute = findAncestorUntil(call, ts.isJsxAttribute, state.owner);
  const callback = nearestMutationFunction(call, state.owner);
  return !!state.setterName &&
    !!attribute &&
    /^on[A-Z]/.test(attribute.name.getText()) &&
    attribute.parent.parent === opening &&
    callback !== state.owner &&
    mutationRegionOnlyCallsStateSetters(callback, new Set([state.setterName]));
}

function isBranchUnmountReset(
  reset: ts.CallExpression,
  state: StateCandidate,
  gate: DiscriminatedBranchGate,
  controllerUsage: StateUsage,
  stateFlow: StateFlowIndex
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
  const closeCalls = controllerUsage.setterCallNodes.filter(call =>
    callsAreAdjacentStatements(reset, call) &&
    callSetsDifferentDiscriminant(call, gate.property, gate.value)
  );
  const close = closeCalls.length === 1 ? closeCalls[0] : null;
  if (!close) return false;
  return !controllerUsage.setterCallNodes.some(call => {
    if (
      call === close ||
      nearestMutationFunction(call, state.owner) !== region ||
      !mutationsMayCoexecute(close, call, region, stateFlow)
    ) {
      return false;
    }
    const value = callDiscriminantValue(call, gate.property);
    return value === null || value === gate.value;
  });
}

function callsAreAdjacentStatements(
  left: ts.CallExpression,
  right: ts.CallExpression
): boolean {
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
  const statements = leftStatement.parent.statements;
  return Math.abs(statements.indexOf(leftStatement) - statements.indexOf(rightStatement)) === 1;
}

function callSetsDifferentDiscriminant(
  call: ts.CallExpression,
  property: string,
  activeValue: string
): boolean {
  const value = callDiscriminantValue(call, property);
  return value !== null && value !== activeValue;
}

function callDiscriminantValue(
  call: ts.CallExpression,
  property: string
): string | null {
  if (call.arguments.length !== 1 || !call.arguments[0]) return null;
  const value = unwrapTransparentExpression(call.arguments[0]);
  if (
    !ts.isObjectLiteralExpression(value) ||
    value.properties.some(candidate =>
      (ts.isShorthandPropertyAssignment(candidate) && candidate.name.text === property) ||
      (!ts.isShorthandPropertyAssignment(candidate) &&
        (!ts.isPropertyAssignment(candidate) ||
          (!ts.isIdentifier(candidate.name) && !ts.isStringLiteral(candidate.name))))
    )
  ) {
    return null;
  }
  const matches = value.properties.filter(candidate => {
    if (!ts.isPropertyAssignment(candidate)) return false;
    const name = ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)
      ? candidate.name.text
      : null;
    return name === property;
  });
  const assignment = matches.length === 1 && ts.isPropertyAssignment(matches[0]!)
    ? matches[0]!
    : null;
  const discriminator = assignment
    ? unwrapTransparentExpression(assignment.initializer)
    : null;
  return discriminator && ts.isStringLiteral(discriminator) ? discriminator.text : null;
}

function findIndependentStateWrites(
  states: readonly StateCandidate[]
): {
  directEventWrites: ReadonlySet<StateCandidate>;
  visibilitySetterTransports: ReadonlySet<StateCandidate>;
} {
  const directEventWrites = new Set<StateCandidate>();
  const visibilitySetterTransports = new Set<StateCandidate>();
  const byOwner = new Map<RuntimeFunctionLike, Map<string, StateCandidate>>();
  for (const state of states) {
    if (!state.setterName) continue;
    const bySetter = byOwner.get(state.owner) ?? new Map<string, StateCandidate>();
    bySetter.set(state.setterName, state);
    byOwner.set(state.owner, bySetter);
  }

  for (const [owner, bySetter] of byOwner) {
    if (!owner.body) continue;
    const returned = uniqueReturnedExpression(owner);
    if (!returned) continue;
    visitSkippingNestedRuntimeFunctions(returned, node => {
      if (
        !ts.isJsxAttribute(node) ||
        !node.initializer ||
        !ts.isJsxExpression(node.initializer) ||
        !node.initializer.expression
      ) {
        return;
      }
      if (ts.isIdentifier(node.initializer.expression)) {
        const state = bySetter.get(node.initializer.expression.text);
        const opening = node.parent.parent;
        if (
          state &&
          hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) &&
          (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) &&
          isVisibilityTransitionAttribute(opening, node.name.getText(), state.valueName)
        ) {
          visibilitySetterTransports.add(state);
        }
        return;
      }
      if (!/^on[A-Z]/.test(node.name.getText())) return;
      const controlledInteraction = isControlledInteractionProp(node.name.getText());
      if (
        !ts.isArrowFunction(node.initializer.expression) &&
        !ts.isFunctionExpression(node.initializer.expression)
      ) {
        return;
      }
      const callback = node.initializer.expression;
      const expression = ts.isBlock(callback.body)
        ? callback.body.statements.length === 1 && ts.isExpressionStatement(callback.body.statements[0]!)
          ? callback.body.statements[0]!.expression
          : null
        : callback.body;
      if (
        !expression ||
        !ts.isCallExpression(expression) ||
        !ts.isIdentifier(expression.expression) ||
        expression.arguments.length !== 1 ||
        (!isDirectPrimitiveExpression(expression.arguments[0]!) &&
          (!controlledInteraction || expression.arguments.some(argument => containsCallExpression(argument))))
      ) {
        return;
      }
      const state = bySetter.get(expression.expression.text);
      if (state) directEventWrites.add(state);
    });
  }
  return { directEventWrites, visibilitySetterTransports };
}

function findStateSubtreeClusters(
  subtreeByState: ReadonlyMap<StateCandidate, StateSubtree>,
  statesWithCompanionWrites: ReadonlySet<StateCandidate>
): ReadonlyMap<StateCandidate, StateCluster> {
  const bySubtree = new Map<JsxSubtreeNode, Array<{ state: StateCandidate; subtree: StateSubtree }>>();
  for (const [state, subtree] of subtreeByState) {
    if (statesWithCompanionWrites.has(state)) continue;
    const members = bySubtree.get(subtree.node) ?? [];
    members.push({ state, subtree });
    bySubtree.set(subtree.node, members);
  }

  const result = new Map<StateCandidate, StateCluster>();
  for (const candidates of bySubtree.values()) {
    if (candidates.length < 2) continue;
    const first = candidates[0]!;
    const members = candidates.map(candidate => candidate.state);
    const names = members.map(member => member.valueName);
    const repeated = candidates.some(candidate => candidate.subtree.repeated);
    const needsObservable = repeated || candidates.some(
      candidate => candidate.subtree.unstable || candidate.subtree.kind !== "direct"
    );
    const action: StateAction = needsObservable
      ? "use-observable"
      : "move-state-down";
    const ownership = repeated
      ? "replace them with one component-lifetime observable model and subscribe with per-item `useValue` selectors in the repeated row leaf"
      : needsObservable
      ? "replace them with one component-lifetime observable model and subscribe in the extracted leaf with `useValue`"
      : "move their ownership into the extracted leaf component";
    const cluster: StateCluster = {
      action,
      id: `state-cluster:subtree:${first.state.owner.getStart()}:${first.subtree.node.getStart()}:${names.join(",")}`,
      members,
      message: `Extract the ${first.subtree.label} subtree at line ${first.subtree.line}; ${ownership} for the confined state cluster (${names.map(name => `\`${name}\``).join(", ")}).`,
      primary: members[0]!,
    };
    for (const member of members) result.set(member, cluster);
  }
  return result;
}

interface SetterMutation {
  call: ts.CallExpression;
  region: RuntimeFunctionLike;
  state: StateCandidate;
}

function nullableDialogPayloadCut(
  state: StateCandidate,
  usage: StateUsage,
  knownComponents: ReadonlySet<string>,
  childContracts: ChildContractResolver | null,
  imports: HookImports
): DialogPayloadCut | null {
  if (
    !state.setterName ||
    isCustomHookOwner(state.owner) ||
    !hasStateInitializer(state, ts.SyntaxKind.NullKeyword) ||
    stateMayHoldCallable(state) ||
    usage.localRenderReads === 0 ||
    usage.localRenderReads !== usage.directRenderNodes.length ||
    usage.effectReads !== 0 ||
    usage.effectWrites !== 0 ||
    usage.transportedOccurrences !== 0 ||
    usage.setterCallNodes.length < 2 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.setterUsesPreviousValue ||
    usage.shadowed ||
    usage.escaped ||
    !usage.setterCallNodes.some(call => setterCallSetsLiteral(call, ts.SyntaxKind.NullKeyword)) ||
    !usage.setterCallNodes.some(call => !setterCallSetsLiteral(call, ts.SyntaxKind.NullKeyword)) ||
    usage.setterCallNodes.some(call => {
      const argument = call.arguments[0];
      return call.arguments.length !== 1 ||
        !argument ||
        ts.isArrowFunction(argument) ||
        ts.isFunctionExpression(argument);
    })
  ) {
    return null;
  }

  const ownerJsx = jsxElementCount(state.owner);
  const conditionalBoundary = conditionalNullablePayloadBoundary(
    state,
    usage,
    knownComponents
  );
  const dialog = conditionalBoundary?.dialog ??
    lowestCommonJsxSubtree(usage.directRenderNodes, state.owner);
  if (
    !dialog ||
    ts.isJsxFragment(dialog) ||
    ownerJsx < 12 ||
    nearestRepeatedRenderCall(dialog, state.owner) ||
    (!conditionalBoundary && hasUnstableSubtreeLifetime(dialog, state.owner)) ||
    !usage.directRenderNodes.every(read =>
      nodeWithin(read, conditionalBoundary?.gate ?? dialog)
    )
  ) {
    return null;
  }
  const dialogJsx = jsxElementCountIn(dialog);
  if (dialogJsx > 12 || dialogJsx / ownerJsx > 0.4) return null;

  const returned = uniqueReturnedExpression(state.owner);
  const opening = ts.isJsxElement(dialog) ? dialog.openingElement : dialog;
  const target = opening.tagName.getText();
  if (
    !returned ||
    !nodeWithin(conditionalBoundary?.gate ?? dialog, returned) ||
    (isCustomJsxTarget(target) && !knownComponents.has(target)) ||
    (!conditionalBoundary &&
      !opening.attributes.properties.some(attribute =>
        ts.isJsxAttribute(attribute) &&
        attribute.name.getText() === "open" &&
        attribute.initializer !== undefined &&
        ts.isJsxExpression(attribute.initializer) &&
        attribute.initializer.expression !== undefined &&
        isNullablePayloadOpenExpression(attribute.initializer.expression, state.valueName)
      ))
  ) {
    return null;
  }

  const provenEventRoots = new Set<RuntimeFunctionLike>();
  if (childContracts) {
    for (const callback of sourceProvenDirectEventCallbacks(state.owner, imports, childContracts)) {
      provenEventRoots.add(callback);
    }
  }
  if (
    !stateReadsOutsideRenderAreEventRooted(state, usage, provenEventRoots, childContracts) ||
    !usage.setterCallNodes.every(call =>
      setterCallSetsLiteral(call, ts.SyntaxKind.NullKeyword) ||
      nodeIsDirectDeferredEvent(call, state, provenEventRoots, childContracts)
    )
  ) {
    return null;
  }

  return {
    conditional: conditionalBoundary !== null,
    consumerLabel: jsxSubtreeLabel(dialog),
    consumerLine: dialog.getSourceFile().getLineAndCharacterOfPosition(
      (conditionalBoundary?.gate ?? dialog).getStart()
    ).line + 1,
  };
}

function conditionalNullablePayloadBoundary(
  state: StateCandidate,
  usage: StateUsage,
  knownComponents: ReadonlySet<string>
): { dialog: ts.JsxElement | ts.JsxSelfClosingElement; gate: ts.JsxExpression } | null {
  if (usage.directRenderNodes.length < 2) return null;

  for (const read of usage.directRenderNodes) {
    const gate = findAncestorUntil(read, ts.isJsxExpression, state.owner);
    const expression = gate?.expression && unwrapTransparentExpression(gate.expression);
    const dialog = expression
      ? directDialogPayloadGateBranch(expression, state.valueName)
      : null;
    if (
      !gate ||
      !expression ||
      !dialog ||
      (!ts.isJsxElement(dialog) && !ts.isJsxSelfClosingElement(dialog)) ||
      !nodeWithin(read, dialogGateCondition(expression)) ||
      nearestRepeatedRenderCall(gate, state.owner) ||
      !usage.directRenderNodes.every(node => nodeWithin(node, gate))
    ) {
      continue;
    }

    const opening = ts.isJsxElement(dialog) ? dialog.openingElement : dialog;
    const target = opening.tagName.getText();
    if (
      (isCustomJsxTarget(target) && !knownComponents.has(target)) ||
      usage.directRenderNodes.some(node =>
        nodeWithin(node, dialog) && !isSafeJsxProjectionReference(node, state.owner)
      )
    ) {
      continue;
    }
    return { dialog, gate };
  }
  return null;
}

function dialogGateCondition(expression: ts.Expression): ts.Expression {
  const value = unwrapTransparentExpression(expression);
  return ts.isConditionalExpression(value) ? value.condition :
    ts.isBinaryExpression(value) ? value.left : value;
}

function isNullablePayloadOpenExpression(
  expression: ts.Expression,
  stateName: string
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (isDirectTruthyStateCondition(value, stateName)) return true;
  if (
    !ts.isBinaryExpression(value) ||
    (value.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsToken &&
      value.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken)
  ) {
    return false;
  }
  const left = unwrapTransparentExpression(value.left);
  const right = unwrapTransparentExpression(value.right);
  return (ts.isIdentifier(left) && left.text === stateName && right.kind === ts.SyntaxKind.NullKeyword) ||
    (left.kind === ts.SyntaxKind.NullKeyword && ts.isIdentifier(right) && right.text === stateName);
}

function setterCallSetsLiteral(
  call: ts.CallExpression,
  kind: ts.SyntaxKind
): boolean {
  return call.arguments.length === 1 && call.arguments[0]?.kind === kind;
}

function stateReadsOutsideRenderAreEventRooted(
  state: StateCandidate,
  usage: StateUsage,
  eventRoots: ReadonlySet<RuntimeFunctionLike>,
  childContracts: ChildContractResolver | null
): boolean {
  const renderReads = new Set(usage.directRenderNodes);
  let safe = true;
  visit(state.owner.body, node => {
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
    safe = nodeIsDirectDeferredEvent(node, state, eventRoots, childContracts);
  });
  return safe;
}

function nodeIsDirectDeferredEvent(
  node: ts.Node,
  state: StateCandidate,
  eventRoots: ReadonlySet<RuntimeFunctionLike>,
  childContracts: ChildContractResolver | null
): boolean {
  const callback = nearestNestedFunction(node, state.owner);
  return callback !== null &&
    callbackResolvesToDeferredEvent(
      callback,
      state.owner,
      eventRoots,
      childContracts,
      new Set()
    );
}

function callbackResolvesToDeferredEvent(
  callback: RuntimeFunctionLike,
  owner: RuntimeFunctionLike,
  eventRoots: ReadonlySet<RuntimeFunctionLike>,
  childContracts: ChildContractResolver | null,
  seen: ReadonlySet<string>
): boolean {
  if (
    !ts.isArrowFunction(callback) &&
    !ts.isFunctionDeclaration(callback) &&
    !ts.isFunctionExpression(callback)
  ) {
    return false;
  }
  if (
    eventRoots.has(callback) ||
    callbackHasDirectJsxEventRoot(callback, owner, childContracts)
  ) {
    return true;
  }
  const name = localCallbackBindingName(callback);
  if (!name || seen.has(name) || bindingDeclarationCount(owner, name) !== 1) return false;

  const nextSeen = new Set(seen).add(name);
  let referenced = false;
  let safe = true;
  for (const node of identifiersNamed(owner.body, name)) {
    if (!safe) break;
    if (isDeclarationName(node) || isNonValueIdentifier(node)) continue;
    referenced = true;
    if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) {
      safe = false;
      continue;
    }
    const caller = nearestNestedFunction(node, owner);
    safe = caller !== null &&
      caller !== callback &&
      callbackResolvesToDeferredEvent(
        caller,
        owner,
        eventRoots,
        childContracts,
        nextSeen
      );
  }
  return referenced && safe;
}

function callbackHasDirectJsxEventRoot(
  callback: RuntimeFunctionLike,
  owner: RuntimeFunctionLike,
  childContracts: ChildContractResolver | null
): boolean {
  if (
    !ts.isArrowFunction(callback) &&
    !ts.isFunctionDeclaration(callback) &&
    !ts.isFunctionExpression(callback)
  ) {
    return false;
  }
  const directAttribute = findAncestorUntil(callback, ts.isJsxAttribute, owner);
  if (
    directAttribute &&
    directAttribute.initializer &&
    ts.isJsxExpression(directAttribute.initializer) &&
    directAttribute.initializer.expression &&
    unwrapTransparentExpression(directAttribute.initializer.expression) === callback &&
    jsxEventAttributeIsDeferred(directAttribute, childContracts)
  ) {
    return true;
  }

  const name = localCallbackBindingName(callback);
  if (!name || bindingDeclarationCount(owner, name) !== 1) return false;
  let referenced = false;
  let safe = true;
  for (const node of identifiersNamed(owner.body, name)) {
    if (!safe) break;
    if (isDeclarationName(node) || isNonValueIdentifier(node)) continue;
    referenced = true;
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    safe = attribute !== null &&
      isDirectJsxAttributeExpression(attribute, node) &&
      jsxEventAttributeIsDeferred(attribute, childContracts);
  }
  return referenced && safe;
}

function jsxEventAttributeIsDeferred(
  attribute: ts.JsxAttribute,
  childContracts: ChildContractResolver | null
): boolean {
  const prop = attribute.name.getText();
  const target = jsxTargetName(attribute);
  if (!target || !/^on[A-Z]/.test(prop)) return false;
  return !isCustomJsxTarget(target) ||
    childContracts?.frameworkEventComponent(target) === true ||
    childContracts?.componentCallbackPropIsDeferred(target, prop) === true;
}

function normalizeObservableDialogClusterMembers(
  members: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  knownComponents: ReadonlySet<string>,
  mutations: readonly SetterMutation[],
  stateFlow: StateFlowIndex
): readonly StateCandidate[] | null {
  if (members.length < 2) return null;
  const payloads = members.filter(hasDialogPayloadInitializer);
  const flags = members.filter(state => hasStateInitializer(state, ts.SyntaxKind.FalseKeyword));
  if (payloads.length !== 1 || flags.length < 1 || payloads.length + flags.length !== members.length) {
    return null;
  }

  const payload = payloads[0];
  if (!payload) return null;
  const payloadMutations = mutations.filter(mutation => mutation.state === payload);
  const payloadOpenMutations = payloadMutations.filter(mutation => !callSetsLiteral(mutation, ts.SyntaxKind.NullKeyword));
  if (payloadOpenMutations.length === 0) return null;
  const latches = flags.filter(flag =>
    isMonotonicDialogLatch(flag, usageByState, mutations, payloadOpenMutations, stateFlow)
  );
  if (latches.length > 1) return null;
  const latch = latches[0] ?? null;

  const targetSets: ReadonlySet<string>[] = [];
  for (const member of members) {
    const usage = usageByState.get(member);
    if (
      !usage ||
      usage.shadowed ||
      usage.escaped ||
      stateMayHoldCallable(member) ||
      usage.effectReads > 0 ||
      usage.effectWrites > 0 ||
      usage.setterUsesPreviousValue
    ) {
      return null;
    }
    const targets = new Set([...usage.jsxTargets].filter(target => knownComponents.has(target)));
    if (
      targets.size === 0 &&
      member !== payload &&
      member !== latch
    ) {
      return null;
    }
    if (member === payload && targets.size === 0 && usage.localRenderReads === 0 && usage.deferredReads === 0) {
      return null;
    }
    targetSets.push(targets);
  }

  for (const flag of flags) {
    if (flag === latch) continue;
    const flagMutations = mutations.filter(mutation => mutation.state === flag);
    const openMutations = flagMutations.filter(mutation => callSetsLiteral(mutation, ts.SyntaxKind.TrueKeyword));
    const flagUsage = usageByState.get(flag);
    const canClose =
      flagMutations.some(mutation => callSetsLiteral(mutation, ts.SyntaxKind.FalseKeyword)) ||
      flagMutations.some(isControlledBooleanTransition) ||
      (flagUsage?.setterTargets.size ?? 0) > 0;
    if (openMutations.length === 0 || !canClose) return null;
    const pairedOpen = openMutations.some(flagMutation =>
      payloadOpenMutations.some(
        payloadMutation =>
          flagMutation.region === payloadMutation.region &&
          mutationsAreProvenCoexecuting(
            flagMutation.call,
            payloadMutation.call,
            flagMutation.region,
            stateFlow
          )
      )
    );
    if (!pairedOpen) return null;
  }
  if (!targetSets.some(targets => targets.size > 0)) return null;

  const ownerGuardedPayload = payloadControlsOwnerJsx(payload, knownComponents);
  if (
    ownerGuardedPayload &&
    !stateHasBoundedDialogGate(payload, members, usageByState, knownComponents)
  ) {
    return null;
  }
  if (
    latch &&
    !stateHasBoundedDialogGate(latch, members, usageByState, knownComponents)
  ) {
    return null;
  }
  return members;
}

function normalizePersistentScalarDialogClusterMembers(
  members: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  knownComponents: ReadonlySet<string>,
  mutations: readonly SetterMutation[],
  stateFlow: StateFlowIndex,
  childContracts: ChildContractResolver | null
): readonly StateCandidate[] | null {
  if (!childContracts || members.length !== 2) return null;
  const payload = members.find(hasLiteralScalarDialogPayloadInitializer);
  const flag = members.find(state => hasStateInitializer(state, ts.SyntaxKind.FalseKeyword));
  if (!payload || !flag || payload === flag) return null;

  const payloadUsage = usageByState.get(payload);
  const flagUsage = usageByState.get(flag);
  if (
    !payloadUsage ||
    !flagUsage ||
    [payloadUsage, flagUsage].some(usage =>
      usage.localRenderReads !== 0 ||
      usage.effectReads !== 0 ||
      usage.effectWrites !== 0 ||
      usage.deferredReads !== 0 ||
      usage.repeatedTransport ||
      usage.unstableTransport ||
      usage.setterUsesPreviousValue ||
      usage.shadowed ||
      usage.escaped
    ) ||
    stateMayHoldCallable(payload) ||
    stateMayHoldCallable(flag) ||
    payloadUsage.valueTransportSites.size !== 1 ||
    flagUsage.valueTransportSites.size !== 1 ||
    [...payloadUsage.valueTransportSites][0] !== [...flagUsage.valueTransportSites][0] ||
    payloadUsage.valueTargets.size !== 1 ||
    flagUsage.valueTargets.size !== 1 ||
    [...payloadUsage.valueTargets][0] !== [...flagUsage.valueTargets][0] ||
    payloadUsage.setterTransportSites.size !== 0 ||
    payloadUsage.setterReferences !== payloadUsage.setterCalls ||
    flagUsage.setterTransportSites.size !== 1 ||
    flagUsage.setterReferences !== flagUsage.setterCalls + 1
  ) {
    return null;
  }

  const target = [...payloadUsage.valueTargets][0];
  const payloadCallSite = directUniqueReturnCallSite(payloadUsage, payload.owner)?.opening;
  const flagCallSite = directUniqueReturnCallSite(flagUsage, flag.owner)?.opening;
  const closeTransport = directSetterTransport(flag);
  if (
    !target ||
    !knownComponents.has(target) ||
    !payloadCallSite ||
    payloadCallSite !== flagCallSite ||
    callSiteIsKeyed(payloadCallSite) ||
    !closeTransport ||
    closeTransport.target !== target ||
    closeTransport.attribute.parent.parent !== payloadCallSite ||
    !childContracts.componentCallbackPropIsDeferred(
      target,
      closeTransport.attribute.name.getText()
    )
  ) {
    return null;
  }

  const payloadMutations = mutations.filter(mutation => mutation.state === payload);
  const flagMutations = mutations.filter(mutation => mutation.state === flag);
  const opens = flagMutations.filter(mutation => callSetsLiteral(mutation, ts.SyntaxKind.TrueKeyword));
  const closes = flagMutations.filter(mutation => callSetsLiteral(mutation, ts.SyntaxKind.FalseKeyword));
  const paired = (left: SetterMutation, right: SetterMutation) =>
    left.region === right.region &&
    mutationsAreProvenCoexecuting(left.call, right.call, left.region, stateFlow);
  if (
    payloadMutations.length === 0 ||
    opens.length === 0 ||
    flagMutations.length !== opens.length + closes.length ||
    payloadMutations.some(mutation =>
      !mutationIsEventRooted(mutation, payload) ||
      !mutationWritesTypedPrimitive(mutation)
    ) ||
    flagMutations.some(mutation => !mutationIsEventRooted(mutation, flag)) ||
    payloadMutations.some(payloadMutation =>
      !opens.some(open => paired(payloadMutation, open))
    ) ||
    opens.some(open =>
      !payloadMutations.some(payloadMutation => paired(open, payloadMutation))
    )
  ) {
    return null;
  }
  return members;
}

function hasLiteralScalarDialogPayloadInitializer(state: StateCandidate): boolean {
  const initializer = state.call.arguments[0];
  if (!initializer) return false;
  const value = unwrapTransparentExpression(initializer);
  return ts.isStringLiteralLike(value) || ts.isNumericLiteral(value);
}

function mutationWritesTypedPrimitive(mutation: SetterMutation): boolean {
  const argument = mutation.call.arguments[0];
  if (!argument || mutation.call.arguments.length !== 1) return false;
  const value = unwrapTransparentExpression(argument);
  if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)) return true;
  if (!ts.isIdentifier(value) || !isRuntimeFunctionLike(mutation.region)) return false;
  return mutation.region.parameters.some(parameter =>
    ts.isIdentifier(parameter.name) &&
    parameter.name.text === value.text &&
    parameter.type !== undefined &&
    primitiveDialogPayloadType(parameter.type)
  );
}

function primitiveDialogPayloadType(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type)) return primitiveDialogPayloadType(type.type);
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
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  mutations: readonly SetterMutation[],
  payloadOpenMutations: readonly SetterMutation[],
  stateFlow: StateFlowIndex
): boolean {
  const usage = usageByState.get(flag);
  const flagMutations = mutations.filter(mutation => mutation.state === flag);
  return usage !== undefined &&
    usage.localRenderReads > 0 &&
    usage.transportedOccurrences === 0 &&
    usage.deferredReads === 0 &&
    usage.setterReferences === usage.setterCalls &&
    flagMutations.length > 0 &&
    flagMutations.every(mutation => callSetsLiteral(mutation, ts.SyntaxKind.TrueKeyword)) &&
    flagMutations.every(flagMutation =>
      payloadOpenMutations.some(payloadMutation =>
        flagMutation.region === payloadMutation.region &&
        mutationsAreProvenCoexecuting(
          flagMutation.call,
          payloadMutation.call,
          flagMutation.region,
          stateFlow
        )
      )
    );
}

function hasDialogPayloadInitializer(state: StateCandidate): boolean {
  return state.call.arguments.length === 0 ||
    hasStateInitializer(state, ts.SyntaxKind.NullKeyword);
}

function normalizeGatedFeedbackClusterMembers(
  members: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  mutations: readonly SetterMutation[],
  stateFlow: StateFlowIndex
): readonly StateCandidate[] | null {
  if (members.length !== 2) return null;
  const payload = members.find(state => hasStateInitializer(state, ts.SyntaxKind.NullKeyword));
  const feedback = members.find(state => hasStateInitializer(state, ts.SyntaxKind.FalseKeyword));
  if (!payload || !feedback || payload === feedback) return null;

  const payloadUsage = usageByState.get(payload);
  const feedbackUsage = usageByState.get(feedback);
  if (
    !payloadUsage ||
    !feedbackUsage ||
    [payloadUsage, feedbackUsage].some(usage =>
      usage.shadowed ||
      usage.escaped ||
      usage.effectReads > 0 ||
      usage.effectWrites > 0 ||
      usage.setterUsesPreviousValue ||
      usage.transportedOccurrences > 0
    ) ||
    stateMayHoldCallable(payload) ||
    stateMayHoldCallable(feedback) ||
    payloadUsage.localRenderReads === 0 ||
    feedbackUsage.localRenderReads === 0 ||
    payloadUsage.setterReferences !== payloadUsage.setterCalls ||
    feedbackUsage.setterReferences !== feedbackUsage.setterCalls ||
    !feedbackRenderIsConfinedToPayloadGate(payload, payloadUsage, feedbackUsage)
  ) {
    return null;
  }

  const payloadMutations = mutations.filter(mutation => mutation.state === payload);
  const feedbackMutations = mutations.filter(mutation => mutation.state === feedback);
  const payloadResets = payloadMutations.filter(mutation =>
    callSetsLiteral(mutation, ts.SyntaxKind.NullKeyword)
  );
  const feedbackResets = feedbackMutations.filter(mutation =>
    callSetsLiteral(mutation, ts.SyntaxKind.FalseKeyword)
  );
  const feedbackStarts = feedbackMutations.filter(mutation =>
    callSetsLiteral(mutation, ts.SyntaxKind.TrueKeyword)
  );
  if (
    payloadMutations.length < 2 ||
    payloadResets.length === 0 ||
    !payloadMutations.some(mutation => !callSetsLiteral(mutation, ts.SyntaxKind.NullKeyword)) ||
    feedbackStarts.length === 0 ||
    feedbackResets.length < 2 ||
    !feedbackHasTimedReset(feedbackStarts, feedbackResets, feedback.owner, stateFlow)
  ) {
    return null;
  }

  const hasPairedReset = payloadResets.some(payloadReset =>
    feedbackResets.some(feedbackReset =>
      payloadReset.region === feedbackReset.region &&
      (callsAreAdjacentDraftWrites(payloadReset.call, feedbackReset.call) ||
        mutationsAreProvenCoexecuting(
          payloadReset.call,
          feedbackReset.call,
          payloadReset.region,
          stateFlow
        ))
    )
  );
  return hasPairedReset ? [payload, feedback] : null;
}

function feedbackRenderIsConfinedToPayloadGate(
  payload: StateCandidate,
  payloadUsage: StateUsage,
  feedbackUsage: StateUsage
): boolean {
  if (
    payloadUsage.directRenderNodes.length === 0 ||
    payloadUsage.localRenderReads !== payloadUsage.directRenderNodes.length ||
    feedbackUsage.directRenderNodes.length === 0 ||
    feedbackUsage.localRenderReads !== feedbackUsage.directRenderNodes.length
  ) {
    return false;
  }
  const feedbackLeaf = lowestCommonJsxSubtree(
    feedbackUsage.directRenderNodes,
    payload.owner
  );
  if (!feedbackLeaf || jsxElementCountIn(feedbackLeaf) > 4) return false;
  const returned = uniqueReturnedExpression(payload.owner) ??
    uniqueJsxReturnAllowingNullGuard(payload.owner);
  if (!returned) return false;
  let confined = false;
  visit(returned, node => {
    if (
      confined ||
      !ts.isConditionalExpression(node) ||
      !isDirectTruthyStateCondition(node.condition, payload.valueName)
    ) {
      return;
    }
    confined = payloadUsage.directRenderNodes.every(read => nodeWithin(read, node)) &&
      feedbackUsage.directRenderNodes.every(read => nodeWithin(read, node.whenTrue)) &&
      nodeWithin(feedbackLeaf, node.whenTrue);
  });
  return confined;
}

function uniqueJsxReturnAllowingNullGuard(
  owner: RuntimeFunctionLike
): ts.Expression | null {
  if (!owner.body) return null;
  const returned: ts.Expression[] = [];
  let unsafe = false;
  visitSkippingNestedRuntimeFunctions(owner.body, node => {
    if (unsafe || !ts.isReturnStatement(node)) return;
    if (!node.expression) {
      unsafe = true;
      return;
    }
    const expression = unwrapTransparentExpression(node.expression);
    if (expression.kind === ts.SyntaxKind.NullKeyword) return;
    if (
      !ts.isJsxElement(expression) &&
      !ts.isJsxSelfClosingElement(expression) &&
      !ts.isJsxFragment(expression)
    ) {
      unsafe = true;
      return;
    }
    returned.push(expression);
  });
  return !unsafe && returned.length === 1 ? returned[0]! : null;
}

function isDirectTruthyStateCondition(
  expression: ts.Expression,
  stateName: string
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) return value.text === stateName;
  return ts.isPrefixUnaryExpression(value) &&
    value.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isPrefixUnaryExpression(value.operand) &&
    value.operand.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isIdentifier(value.operand.operand) &&
    value.operand.operand.text === stateName;
}

function feedbackHasTimedReset(
  starts: readonly SetterMutation[],
  resets: readonly SetterMutation[],
  owner: RuntimeFunctionLike,
  stateFlow: StateFlowIndex
): boolean {
  if (bindingDeclarationCount(owner, "setTimeout") > 0) return false;
  return resets.some(reset => {
    const timer = findAncestorUntil(
      reset.call,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "setTimeout" &&
        !!node.arguments[0] &&
        nodeWithin(reset.call, node.arguments[0]),
      owner
    );
    if (!timer) return false;
    const command = nearestMutationFunction(timer, owner);
    return starts.some(start =>
      start.region === command &&
      start.call.getStart() < timer.getStart() &&
      (callsAreAdjacentDraftWrites(start.call, timer) ||
        mutationsAreProvenCoexecuting(start.call, timer, command, stateFlow))
    );
  });
}

function payloadControlsOwnerJsx(
  payload: StateCandidate,
  knownComponents: ReadonlySet<string>
): boolean {
  let controls = false;
  visit(payload.owner.body, node => {
    if (!ts.isIdentifier(node) || node.text !== payload.valueName || isNonValueIdentifier(node)) return;
    const jsx = findAncestorUntil(node, isJsxNode, payload.owner);
    if (!jsx) return;
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, payload.owner);
    if (attribute) {
      const target = jsxTargetName(attribute);
      if (target && knownComponents.has(target)) return;
    }
    controls = true;
  });
  return controls;
}

function stateHasBoundedDialogGate(
  state: StateCandidate,
  members: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  knownComponents: ReadonlySet<string>
): boolean {
  const stateUsage = usageByState.get(state);
  if (
    !stateUsage ||
    stateUsage.localRenderReads === 0 ||
    stateUsage.localRenderReads !== stateUsage.directRenderNodes.length
  ) {
    return false;
  }

  const firstRead = stateUsage.directRenderNodes[0];
  if (!firstRead) return false;
  const gate = findAncestorUntil(firstRead, ts.isJsxExpression, state.owner);
  const expression = gate?.expression && unwrapTransparentExpression(gate.expression);
  const trueBranch = expression
    ? directDialogPayloadGateBranch(expression, state.valueName)
    : null;
  if (
    !gate ||
    !expression ||
    !trueBranch ||
    (!ts.isJsxElement(trueBranch) &&
      !ts.isJsxSelfClosingElement(trueBranch) &&
      !ts.isJsxFragment(trueBranch)) ||
    nearestRepeatedRenderCall(gate, state.owner) ||
    jsxElementCountIn(trueBranch) > 12 ||
    jsxElementCountIn(trueBranch) / jsxElementCount(state.owner) > 0.4 ||
    !stateUsage.directRenderNodes.every(read => nodeWithin(read, gate))
  ) {
    return false;
  }

  const targetSites = new Set<number>();
  visit(trueBranch, node => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    if (knownComponents.has(node.tagName.getText())) targetSites.add(node.getStart());
  });
  if (targetSites.size === 0) return false;

  return members.every(member => {
    const usage = usageByState.get(member);
    return usage !== undefined &&
      [...usage.jsxTargets].every(target => knownComponents.has(target)) &&
      [...usage.valueTransportSites, ...usage.setterTransportSites].every(site => targetSites.has(site)) &&
      usage.directRenderNodes.every(read => nodeWithin(read, gate));
  });
}

function directDialogPayloadGateBranch(
  expression: ts.Expression,
  payloadName: string
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
  const argument = mutation.call.arguments[0];
  if (!argument || !ts.isIdentifier(argument)) return false;
  const callback = isInlineRuntimeCallback(mutation.region) ? mutation.region : null;
  const parameter = callback?.parameters[0];
  if (!parameter || !ts.isIdentifier(parameter.name) || parameter.name.text !== argument.text) return false;
  const attribute = callback ? findAncestor(callback, ts.isJsxAttribute) : null;
  return attribute !== null && /^(?:onOpen|onVisible|onExpanded)Change(?:Complete)?$/.test(attribute.name.getText());
}

function isInlineRuntimeCallback(
  node: ts.Node
): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function callSetsLiteral(mutation: SetterMutation, kind: ts.SyntaxKind): boolean {
  return mutation.call.arguments.length === 1 && mutation.call.arguments[0]?.kind === kind;
}

function primitiveSetterUpdatersArePure(
  state: StateCandidate,
  usage: StateUsage
): boolean {
  if (!hasDirectPrimitiveInitializer(state)) return true;
  return usage.setterCallNodes.every(call => {
    const argument = call.arguments[0];
    return !argument ||
      (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) ||
      isPureExpression(
        argument,
        call => isUnshadowedMathCall(state.owner, call, PURE_MATH_METHODS)
      );
  });
}




function nearestMutationFunction(node: ts.Node, owner: RuntimeFunctionLike): RuntimeFunctionLike {
  return findAncestorUntil(node, isRuntimeFunctionLike, owner) ?? owner;
}

function mutationsAreProvenCoexecuting(
  left: ts.CallExpression,
  right: ts.CallExpression,
  region: RuntimeFunctionLike,
  stateFlow: StateFlowIndex
): boolean {
  return stateFlow.proveSynchronousCoexecution(region, left, right) === "proven";
}

function mutationsMayCoexecute(
  left: ts.CallExpression,
  right: ts.CallExpression,
  region: RuntimeFunctionLike,
  stateFlow: StateFlowIndex
): boolean {
  return stateFlow.proveSynchronousCoexecution(region, left, right) !== "disproven";
}

class DisjointSet {
  private readonly parents: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.parents[index];
    if (parent === undefined || parent === index) return index;
    const root = this.find(parent);
    this.parents[index] = root;
    return root;
  }

  join(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parents[rightRoot] = leftRoot;
  }
}

function classifySetterReference(
  node: ts.Identifier,
  state: StateCandidate,
  effectNodes: ReadonlySet<ts.Node>,
  imports: HookImports,
  usage: StateUsage
): void {
  if (node.parent === state.call.parent) return;
  usage.setterReferences += 1;
  if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
    usage.setterCalls += 1;
    usage.setterCallNodes.push(node.parent);
    if (setterCallUsesPreviousValue(node.parent)) usage.setterUsesPreviousValue = true;
    if (hasAncestorInSet(node, effectNodes)) usage.effectWrites += 1;
    if (isInsideImportedCallback(node, imports.useObserveEffect)) usage.legendReactionWrites += 1;
    return;
  }
  const jsxAttribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
  if (jsxAttribute) {
    const target = jsxTargetName(jsxAttribute);
    if (target && isCustomJsxTarget(target) && !imports.hostComponents.has(target)) {
      if (target.endsWith(".Provider")) {
        usage.escaped = true;
        return;
      }
      if (isDirectJsxAttributeExpression(jsxAttribute, node)) {
        usage.jsxTargets.add(target);
        usage.setterTargets.add(target);
        usage.setterTransportSites.add(jsxTransportSite(jsxAttribute));
        usage.transportedOccurrences += 1;
        if (nearestRepeatedRenderCall(jsxAttribute, state.owner)) usage.repeatedTransport = true;
        if (hasUnstableJsxLifetime(jsxAttribute, state.owner)) usage.unstableTransport = true;
        return;
      }
    }
    usage.localRenderReads += 1;
    return;
  }
  usage.escaped = true;
}

function classifyValueReference(
  node: ts.Identifier,
  state: StateCandidate,
  effectNodes: ReadonlySet<ts.Node>,
  imports: HookImports,
  usage: StateUsage
): void {
  if (node.parent === state.call.parent) return;
  if (isHookDependencyReference(node, new Set(["useCallback"]))) {
    usage.deferredReads += 1;
    return;
  }
  if (hasAncestorInSet(node, effectNodes)) {
    usage.effectReads += 1;
    return;
  }
  if (isInsideJsxEventCallback(node, state.owner)) {
    usage.deferredReads += 1;
    usage.eventReads += 1;
    return;
  }
  const jsxAttribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
  if (jsxAttribute) {
    const target = jsxTargetName(jsxAttribute);
    if (target && isCustomJsxTarget(target) && !imports.hostComponents.has(target)) {
      if (target.endsWith(".Provider")) {
        usage.escaped = true;
        return;
      }
      if (isDirectJsxAttributeExpression(jsxAttribute, node)) {
        usage.jsxTargets.add(target);
        usage.valueTargets.add(target);
        addMapSet(usage.valueProps, target, jsxAttribute.name.getText());
        usage.valueTransportSites.add(jsxTransportSite(jsxAttribute));
        usage.transportedOccurrences += 1;
        if (nearestRepeatedRenderCall(jsxAttribute, state.owner)) {
          usage.repeatedTransport = true;
          usage.repeatedValueTransport = true;
        }
        if (isInsideJsxCallback(jsxAttribute, state.owner)) usage.repeatedValueTransport = true;
        if (hasUnstableJsxLifetime(jsxAttribute, state.owner)) usage.unstableTransport = true;
        return;
      }
    }
    usage.localRenderReads += 1;
    usage.directRenderNodes.push(node);
    return;
  }

  if (findAncestorUntil(node, isJsxNode, state.owner)) {
    usage.localRenderReads += 1;
    usage.directRenderNodes.push(node);
    return;
  }

  const nestedFunction = nearestNestedFunction(node, state.owner);
  if (nestedFunction && !isSynchronousRenderCallback(nestedFunction)) {
    usage.deferredReads += 1;
    return;
  }

  if (isDirectArgumentToUnknownCall(node)) {
    usage.escaped = true;
    return;
  }
  usage.localRenderReads += 1;
  usage.directRenderNodes.push(node);
}

function findLegendValueMirrors(
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  bridges: ReadonlyMap<string, ReadonlySet<string>>
): ReadonlyMap<StateCandidate, ClassifiedState> {
  const mirrors = new Map<StateCandidate, ClassifiedState>();
  if (bridges.size === 0) return mirrors;
  for (const state of states) {
    const usage = usageByState.get(state);
    const initial = state.call.arguments[0];
    if (
      !usage ||
      !state.setterName ||
      !initial ||
      !ts.isIdentifier(initial) ||
      usage.setterCalls === 0 ||
      usage.setterReferences !== usage.setterCalls ||
      usage.setterUsesPreviousValue ||
      usage.effectReads > 0 ||
      usage.effectWrites > 0 ||
      usage.deferredReads > 0 ||
      usage.eventReads > 0 ||
      usage.shadowed ||
      usage.escaped
    ) {
      continue;
    }
    const sourceName = initial.text;
    const source = uniqueVariableDeclaration(state.owner, sourceName);
    const hookCall = source?.initializer
      ? unwrapTransparentExpression(source.initializer)
      : null;
    if (
      !source ||
      !hookCall ||
      !ts.isCallExpression(hookCall) ||
      hookCall.arguments.length !== 0 ||
      !ts.isIdentifier(hookCall.expression)
    ) {
      continue;
    }
    const writers = bridges.get(hookCall.expression.text);
    if (
      !writers ||
      !sourceBindingOnlySeedsState(source, state) ||
      !usage.setterCallNodes.every(call => hasAdjacentBridgeWrite(call, writers))
    ) {
      continue;
    }
    mirrors.set(state, {
      action: "use-value",
      confidence: "probable",
      message: `Delete the React mirror \`${state.valueName}\` and render from \`${sourceName}\`, the one-hop \`${hookCall.expression.text}\` value; every React setter call is paired with the same inert argument to its proven observable writer, which remains the sole update path.`,
    });
  }
  return mirrors;
}

function sourceBindingOnlySeedsState(
  source: ts.VariableDeclaration,
  state: StateCandidate
): boolean {
  if (!ts.isIdentifier(source.name) || !state.owner.body) return false;
  const binding = source.name;
  const initial = state.call.arguments[0];
  let safe = true;
  let references = 0;
  visit(state.owner.body, node => {
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
    if (node !== initial) safe = false;
  });
  return safe && references === 1;
}

function hasAdjacentBridgeWrite(
  setterCall: ts.CallExpression,
  writers: ReadonlySet<string>
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
  const statements = statement.parent.statements;
  const index = statements.indexOf(statement);
  return [statements[index - 1], statements[index + 1]].some(candidate => {
    if (!candidate || !ts.isExpressionStatement(candidate)) return false;
    const expression = unwrapTransparentExpression(candidate.expression);
    return ts.isCallExpression(expression) &&
      expression.arguments.length === 1 &&
      !!expression.arguments[0] &&
      ts.isIdentifier(expression.expression) &&
      writers.has(expression.expression.text) &&
      expression.arguments[0].getText() === setterCall.arguments[0]!.getText();
  });
}

function classifyState(
  state: StateCandidate,
  usage: StateUsage,
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>,
  sourceFile: ts.SourceFile,
  isPropertyLocalObjectDraft: boolean,
  subtree: StateSubtree | null,
  dialogPayloadCut: DialogPayloadCut | null,
  hasSafeCommands: boolean,
  isSelfRefreshingCommand: boolean,
  belongsToObservableSelection: boolean,
  hasCompanionWrites: boolean,
  hasNonClosingCompanionWrites: boolean,
  hasIndependentDirectEventWrite: boolean,
  hasIndependentVisibilitySetterTransport: boolean,
  hasReactiveMutationPath: boolean,
  isAsyncLeafStatus: boolean,
  isCohesiveAsyncStatus: boolean,
  isUnprovenAsyncStatus: boolean,
  isDeferredReveal: boolean,
  isKeyedLeafCollection: boolean,
  isKeyedLeafRecord: boolean,
  isKeyedLeafScalar: boolean,
  isKeyedScalarWithSecondary: boolean,
  ownerObservableSubscriptions: number,
  siblingRenderCut: SiblingRenderCut | null,
  branchUnmountMove: BranchUnmountMove | null,
  childContracts: ChildContractResolver | null,
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>,
  eventTransitionCallbacks: ReadonlySet<RuntimeFunctionLike>,
  hasMemoizedOptionCommand: boolean,
  hasReturnedKeyedCursorConsumer: boolean,
  hasAdjacentEventBooleanConsumers: boolean,
  hasAdjacentEffectBooleanConsumers: boolean,
  hasMultiSurfaceBooleanConsumers: boolean,
  hasSourceEventScalarConsumers: boolean,
  hasReactiveHostPropScalarConsumer: boolean
): ClassifiedState {
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
  if (siblingRenderCut && usage.effectWrites === 0) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace \`${state.valueName}\` with a component-lifetime observable; keep the producer sibling command-only and subscribe only in the sibling ${siblingRenderCut.consumerLabel} boundary at line ${siblingRenderCut.consumerLine}, passing state-independent projection inputs as ordinary snapshots.`,
    };
  }
  if (
    branchUnmountMove &&
    (localComponents.has(branchUnmountMove.target) || sourceComponents.has(branchUnmountMove.target))
  ) {
    return {
      action: "move-state-down",
      confidence: "probable",
      message: `Move React state \`${state.valueName}\` into \`${branchUnmountMove.target}\`; every read and interactive write belongs to that branch, and the owner resets it only when that branch unmounts.`,
    };
  }
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
      message: unusedStateDeletionConfidence === "probable"
        ? `Delete React state \`${state.valueName}\`; replace each setter call with a \`void\` expression that evaluates the same argument at the same position, because the assigned value is never consumed but property evaluation must be preserved.`
        : `Delete React state \`${state.valueName}\` and its setter calls; assigned values are never consumed.`,
    };
  }
  const directCallSite = directUniqueReturnCallSite(usage, state.owner);
  const branchCallSite = directBranchReturnCallSite(usage, state.owner);
  const branchSubtree = branchCallSite
    ? ts.isJsxOpeningElement(branchCallSite.opening)
      ? branchCallSite.opening.parent
      : branchCallSite.opening
    : null;
  const hasIndependentTransportRenderCut = branchCallSite !== null &&
    branchSubtree !== null &&
    hasIndependentRenderCutWitness(
      branchCallSite.returned,
      [branchSubtree],
      localComponents,
      sourceComponents
    );
  const hasRepeatedOwnerRenderCut = branchSubtree !== null &&
    hasRepeatedJsxRenderWorkOutside(state.owner, branchSubtree);
  const hasVisibilityValueTransport = [...usage.valueProps.values()].some(props =>
    [...props].some(prop => /^(?:isOpen|isVisible|open|visible)$/.test(prop))
  );
  const hasCompactBooleanTransportCut = hasIndependentTransportRenderCut &&
    !hasCompanionWrites &&
    !hasReactiveMutationPath &&
    usage.setterTargets.size === 0 &&
    usage.setterCallNodes.every(call => setterCallEndsCommand(call, state.owner)) &&
    (hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) ||
      hasStateInitializer(state, ts.SyntaxKind.TrueKeyword));
  const descendantControlledCut = branchCallSite !== null &&
    branchSubtree !== null &&
    hasIndependentVisibilitySetterTransport &&
    setterOwnedByValueCallSite(usage, state.owner) &&
    hasIndependentTransportRenderCut;
  const callbackLeaf = findLazyCallbackLeaf(
    state,
    usage,
    localComponents,
    sourceComponents,
    LAZY_CALLBACK_LEAF_PROOFS
  );
  if (
    callbackLeaf &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    !hasCompanionWrites &&
    !hasReactiveMutationPath &&
    hasSafeCommands &&
    state.setterName !== null &&
    usage.setterCallNodes.some(call =>
      mutationRegionOnlyCallsStateSetters(
        nearestMutationFunction(call, state.owner),
        new Set([state.setterName!])
      )
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
  if (isAsyncLeafStatus) {
    const target = [...usage.valueTargets][0];
    const callSiteCount = usage.valueTransportSites.size;
    const boundary = callSiteCount > 1
      ? `${callSiteCount === 2 ? "two" : "three"} stable status call sites`
      : target
        ? `the stable \`${target}\` call site`
        : "the stable pending-control call site";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace async pending flag \`${state.valueName}\` with a component-lifetime observable and wrap ${boundary} in ${callSiteCount > 1 ? "separate leaf subscribers" : "a leaf subscriber"}; preserve the event command's async completion boundary exactly, changing only the true/false writes so pending transitions do not invalidate independent owner content.`,
    };
  }
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
  if (
    !isCustomHookOwner(state.owner) &&
    (
      jsxElementCount(state.owner) >= 12 ||
      hasCompactBooleanTransportCut ||
      (
        hasRepeatedOwnerRenderCut &&
        !usage.repeatedTransport &&
        usage.setterCallNodes.every(call => nearestRepeatedRenderCall(call, state.owner) === null)
      )
    ) &&
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences > 0 &&
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1 &&
    branchCallSite !== null &&
    !usage.repeatedValueTransport &&
    (
      !hasCompanionWrites ||
      (
        hasVisibilityValueTransport &&
        !hasNonClosingCompanionWrites &&
        (hasIndependentDirectEventWrite || hasIndependentVisibilitySetterTransport)
      )
    ) &&
    (!hasReactiveMutationPath ||
      hasIndependentDirectEventWrite ||
      hasIndependentVisibilitySetterTransport) &&
    hasSafeCommands &&
    hasDirectPrimitiveInitializer(state) &&
    !stateMayHoldCallable(state) &&
    !setterOwnedByValueCallSite(usage, state.owner) &&
    usage.setterReferences > 0 &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped
  ) {
    const target = [...usage.valueTargets][0] ?? "the receiving child";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace \`${state.valueName}\` with a component-lifetime observable and extract one stable call-site leaf wrapper around \`${target}\` (never define it inline); subscribe there, pass the same prop snapshot, and adapt every command-only setter call or prop to mutate without subscribing.${hasCompactBooleanTransportCut && jsxElementCount(state.owner) < 12 ? " The independent sibling render cut proves that these updates skip owner work." : hasRepeatedOwnerRenderCut && jsxElementCount(state.owner) < 12 ? " The leaf subscription skips the owner's repeated render work." : ""}`,
    };
  }
  if (
    !isCustomHookOwner(state.owner) &&
    jsxElementCount(state.owner) >= 12 &&
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences > 0 &&
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1 &&
    (localComponents.has([...usage.valueTargets][0] ?? "") ||
      sourceComponents.has([...usage.valueTargets][0] ?? "") ||
      descendantControlledCut) &&
    branchCallSite !== null &&
    (directCallSite === null || usage.unstableTransport) &&
    !usage.repeatedValueTransport &&
    !hasCompanionWrites &&
    hasSafeCommands &&
    hasDirectPrimitiveInitializer(state) &&
    !stateMayHoldCallable(state) &&
    (setterOwnedByValueTransitionCallSite(state, usage) || descendantControlledCut) &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped
  ) {
    const target = [...usage.valueTargets][0] ?? "the receiving child";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace call-site-owned state \`${state.valueName}\` with a component-lifetime observable and wrap the branch-local \`${target}\` call site in a leaf subscriber; keep ownership at this owner so alternate returns and conditional mounts preserve the existing state lifetime.`,
    };
  }
  if (
    isLiteralBooleanLeafState(
      state,
      usage,
      {
        branchCallSiteExists: branchCallSite !== null,
        hasCompanionWrites,
        hasReactiveMutationPath,
        isCustomHookOwner: isCustomHookOwner(state.owner),
        localComponents,
        sourceComponents,
        hasMemoizedOptionCommand,
      }
    )
  ) {
    const target = [...usage.valueTargets][0] ?? "the receiving child";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace boolean leaf state \`${state.valueName}\` with a component-lifetime observable and wrap the stable \`${target}\` call site in a leaf subscriber; preserve owner lifetime and change only the literal setter commands so external callbacks no longer invalidate the broad owner.`,
    };
  }
  const controlledLeafCut =
    !isCustomHookOwner(state.owner) &&
    !stateMayHoldCallable(state) &&
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads > 0 &&
    usage.transportedOccurrences > 0 &&
    !usage.repeatedTransport &&
    (!usage.setterUsesPreviousValue || isExactControlledArrayMembershipToggle(state, usage)) &&
    !usage.shadowed &&
    !usage.escaped &&
    (!hasCompanionWrites || hasIndependentDirectEventWrite) &&
    hasSafeCommands &&
    hasOnlyEventCommandReads(
      state,
      EMPTY_NODES,
      eventTransitionCallbacks
    ) &&
    controlledLeafRenderCut(state, usage, localComponents, sourceComponents);
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
  const cohesiveControlledLeaf = cohesiveControlledLeafOwner(state, usage);
  if (cohesiveControlledLeaf) {
    return {
      action: "keep-state",
      confidence: "certain",
      message: `Keep controlled state \`${state.valueName}\` in React; its value and setter are already confined to the cohesive \`${cohesiveControlledLeaf}\` leaf owner, so another observable subscriber would not narrow rendering.`,
    };
  }
  const controlledCallSiteProjection = !isCustomHookOwner(state.owner) &&
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
    hasOnlyEventCommandReads(
      state,
      new Set(usage.directRenderNodes),
      eventTransitionCallbacks
    )
      ? controlledSameCallSiteProjectionCut(
          state,
          usage,
          localComponents,
          sourceComponents
        )
      : null;
  if (controlledCallSiteProjection) {
    const target = [...usage.valueTargets][0] ?? "the controlled child";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace controlled state \`${state.valueName}\` with an owner-scoped observable and wrap \`${target}\` in one stable leaf subscriber; derive every state-dependent prop inside that wrapper, keep the callback API unchanged, and preserve the owner's state lifetime.`,
    };
  }
  const controlledProjectionCut = !isCustomHookOwner(state.owner) &&
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
    hasOnlyEventCommandReads(
      state,
      new Set(usage.directRenderNodes),
      eventTransitionCallbacks
    )
      ? controlledLeafProjectionCut(
          state,
          usage,
          localComponents,
          sourceComponents
        )
      : null;
  if (controlledProjectionCut) {
    const target = [...usage.valueTargets][0] ?? "the controlled child";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace controlled state \`${state.valueName}\` with an owner-scoped observable; wrap \`${target}\` and the sibling ${controlledProjectionCut.consumerLabel} projection at line ${controlledProjectionCut.consumerLine} in stable leaf subscribers, derive validation from the subscribed value, keep the input callback API unchanged, and use non-tracking reads in event commands.`,
    };
  }
  const hasFunctionalSnapshotHazard = functionalUpdaterPrecedesSnapshotRead(
    state,
    usage,
    nearestMutationFunction
  );
  const preservesFunctionalSnapshot = hasFunctionalSnapshotHazard &&
    functionalCounterUpdaterPreservesSnapshot(state, usage, nearestMutationFunction);
  const hasEventCommandReadProof = hasOnlyEventCommandReads(
    state,
    EMPTY_NODES,
    eventTransitionCallbacks
  );
  const hasCommandSnapshotHazard = refWouldChangeCommandSnapshot(
    state,
    usage,
    hasEventCommandReadProof
  );
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
        : undefined
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
  const effectCommandProjectionSubtree = subtree?.kind === "effect-command-projection" ? subtree : null;
  if (effectCommandProjectionSubtree && !hasCompanionWrites) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace presentation state \`${state.valueName}\` with an owner-scoped observable, preserve the memoized command, React effect and cleanup, dependencies, and statement order, and wrap the full ${effectCommandProjectionSubtree.label} render boundary at line ${effectCommandProjectionSubtree.line} in an always-mounted leaf subscriber.`,
    };
  }
  const splitEffectProjectionSubtree = subtree?.kind === "effect-split-projection" ? subtree : null;
  if (splitEffectProjectionSubtree && !hasCompanionWrites) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace effect-written scalar \`${state.valueName}\` with an owner-scoped observable; preserve the React effect, cleanup, dependencies, calculations, and write order, then subscribe only in its ${splitEffectProjectionSubtree.leafCount ?? 2} bounded presentation leaves. Keep keyed repeated rows keyed and calculate each existing projection once inside its containing subscriber.`,
    };
  }
  const effectProjectionSubtree = subtree?.kind === "effect-projection" ? subtree : null;
  if (effectProjectionSubtree && !hasCompanionWrites) {
    const selector = repeatedSubscriptionSuffix(effectProjectionSubtree);
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace effect-written presentation state \`${state.valueName}\` with an owner-scoped observable, preserve the React effect, cleanup, dependencies, and statement order, and wrap the full ${effectProjectionSubtree.label} render boundary at line ${effectProjectionSubtree.line} in an always-mounted leaf subscriber${selector}; evaluate the existing projection or gate inside that subscriber.`,
    };
  }
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
  const projectionSubtree = subtree?.kind === "projection" ? subtree : null;
  const gateSubtree = subtree?.kind === "gate" ? subtree : null;
  if (gateSubtree && !hasCompanionWrites) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace \`${state.valueName}\` with a component-lifetime observable and replace the full state-controlled render expression at the ${gateSubtree.label} boundary on line ${gateSubtree.line} with one always-mounted leaf subscriber; evaluate the complete gate and its selected content inside that wrapper so an initially hidden child can still open.`,
    };
  }
  if (
    projectionSubtree &&
    !hasCompanionWrites
  ) {
    const selector = repeatedSubscriptionSuffix(projectionSubtree);
    return {
      action: "use-observable",
      confidence: "probable",
      message: usage.transportedOccurrences > 0
        ? `Replace \`${state.valueName}\` with a component-lifetime observable and wrap the ${projectionSubtree.label} call site at line ${projectionSubtree.line} in a leaf subscriber${selector}; subscribe to the raw value once, pass that snapshot unchanged, derive every existing projection from the same snapshot, and leave the child API unchanged.`
        : `Replace \`${state.valueName}\` with a component-lifetime observable and wrap the ${projectionSubtree.label} call site at line ${projectionSubtree.line} in a leaf subscriber${selector}; evaluate its existing pure projections inside that wrapper and leave the child API unchanged.`,
    };
  }
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
  if (
    ownerLineSpan(state.owner, sourceFile) >= 150 &&
    jsxElementCount(state.owner) >= 12 &&
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
  if (isCohesiveDelayedPendingState(state, usage)) {
    return {
      action: "keep-state",
      confidence: "certain",
      message: `Keep \`${state.valueName}\` as React state; its cohesive button owner intentionally delays the pending transition and clears that timer before the final reset.`,
    };
  }
  if (usage.localRenderReads > 0) {
    if (isCustomHookOwner(state.owner) || jsxElementCount(state.owner) >= 5) {
      const boundary = isCustomHookOwner(state.owner)
        ? "its unknown hook consumers"
        : `this owner with ${jsxElementCount(state.owner)} JSX elements`;
      const competing = ownerObservableSubscriptions === 0
        ? ""
        : ownerObservableSubscriptions === 1
          ? " The owner also re-renders through an existing observable subscription; isolate this state only if it updates less often than that subscription."
          : ` The owner also re-renders through ${ownerObservableSubscriptions} existing observable subscriptions; isolate this state only if it updates less often than they do.`;
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
  if (
    !isCustomHookOwner(state.owner) &&
    jsxElementCount(state.owner) >= 12 &&
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
  if (
    childContracts &&
    usage.jsxTargets.size === 1 &&
    usage.localRenderReads === 0 &&
    stableOwnerLevelCallSite(usage, state.owner) !== null &&
    hasSafeCommands &&
    !hasReactiveMutationPath &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    usage.setterCalls >= 1 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.repeatedTransport &&
    !usage.shadowed &&
    !usage.escaped &&
    !stateMayHoldCallable(state) &&
    !callSiteIsKeyed(stableOwnerLevelCallSite(usage, state.owner)) &&
    usage.setterCallNodes.every(call =>
      call.arguments.length === 1 &&
      !!call.arguments[0] &&
      (call.arguments[0].kind === ts.SyntaxKind.TrueKeyword ||
        call.arguments[0].kind === ts.SyntaxKind.FalseKeyword)
    )
  ) {
    const [target] = [...usage.jsxTargets];
    const propNames = target ? usage.valueProps.get(target) : undefined;
    const propName = propNames && propNames.size === 1 ? [...propNames][0]! : null;
    const child = target ? childContracts.resolveComponent(target) : null;
    if (target && propName && child && propIsLeafRenderConsumer(child, propName)) {
      return {
        action: "use-observable",
        confidence: "probable",
        message: `Replace \`${state.valueName}\` with a component-lifetime observable and wrap the stable \`${target}\` call site in a leaf subscriber; subscribe once with \`useValue\`, pass the same plain value, and leave the child API unchanged. The child contract is verified: \`${target}\` renders the \`${propName}\` value directly and owns none of its lifecycle.`,
      };
    }
  }
  return {
    action: "review-state",
    confidence: "probable",
    message:
      isStructuralLegendCandidate(state, usage, sourceFile) ||
      [...usage.jsxTargets].some(target => sourceComponents.has(target))
        ? legendCandidateMessage(state, usage, sourceComponents)
        : `Review React state \`${state.valueName}\`; local evidence does not prove a render-boundary improvement.`,
  };
}

function controlledFilterLeafCut(
  state: StateCandidate,
  usage: StateUsage,
  childContracts: ChildContractResolver | null
): ControlledFilterLeafCut | null {
  if (
    !state.setterName ||
    !childContracts ||
    !ts.isStringLiteralLike(unwrapTransparentExpression(state.call.arguments[0] ?? state.call)) ||
    usage.setterReferences !== 1 ||
    usage.setterCalls !== 0 ||
    usage.setterTransportSites.size !== 1 ||
    usage.setterTargets.size !== 1 ||
    usage.valueTransportSites.size !== 0 ||
    usage.effectReads !== 0 ||
    usage.effectWrites !== 0 ||
    usage.deferredReads !== 0 ||
    usage.shadowed
  ) {
    return null;
  }

  const setterTransport = directSetterTransport(state);
  if (
    !setterTransport ||
    !childContracts.componentCallbackPropIsDeferred(
      setterTransport.target,
      setterTransport.attribute.name.getText()
    )
  ) {
    return null;
  }

  const reads = stateValueReferences(state);
  const filter = reads.length === 1 ? exactStringFilter(reads[0]!, state.owner) : null;
  if (!filter || !collectionBindingIsReadOnly(filter.sourceName, state.owner)) return null;

  const resultReferences = bindingReferences(state.owner, filter.resultName.text, filter.resultName);
  if (
    resultReferences.length === 0 ||
    resultReferences.some(reference => !isReadOnlyFilteredResultReference(reference, state.owner))
  ) {
    return null;
  }
  const repeated = commonContainingRepeatedRender(
    [setterTransport.reference, ...resultReferences],
    state.owner
  );
  const producer = repeated ? repeatedRenderBinding(repeated, state.owner) : null;
  const producerReferences = producer
    ? bindingReferences(state.owner, producer.text, producer)
    : [];
  const slot = producerReferences.length === 1
    ? directReturnedJsxSlot(producerReferences[0]!, state.owner)
    : null;
  const ownerElements = jsxElementCount(state.owner);
  const producerElements = repeated ? jsxElementCountIn(repeated) : ownerElements;
  if (
    !repeated ||
    !producer ||
    !slot ||
    ownerElements < 12 ||
    ownerElements - producerElements < 5 ||
    renderCollectionWorkOutside(state.owner, repeated, filter.call) < 2
  ) {
    return null;
  }
  return {
    line: slot.getSourceFile().getLineAndCharacterOfPosition(slot.getStart()).line + 1,
    producer: producer.text,
    target: setterTransport.target,
  };
}

function directSetterTransport(state: StateCandidate): {
  attribute: ts.JsxAttribute;
  reference: ts.Identifier;
  target: string;
} | null {
  if (!state.setterName || !state.owner.body) return null;
  const matches: Array<{
    attribute: ts.JsxAttribute;
    reference: ts.Identifier;
    target: string;
  }> = [];
  visit(state.owner.body, node => {
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
  visit(state.owner.body, node => {
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

function exactStringFilter(
  stateRead: ts.Identifier,
  owner: RuntimeFunctionLike
): { call: ts.CallExpression; resultName: ts.Identifier; sourceName: ts.Identifier } | null {
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
  const lowerCall = unwrapTransparentExpression(includesCall.expression.expression);
  if (
    !ts.isCallExpression(lowerCall) ||
    lowerCall.arguments.length !== 0 ||
    !ts.isPropertyAccessExpression(lowerCall.expression) ||
    lowerCall.expression.name.text !== "toLowerCase"
  ) {
    return null;
  }
  const callback = findAncestorUntil(includesCall, isRuntimeFunctionLike, owner);
  const parameter = callback?.parameters[0]?.name;
  if (
    !callback ||
    !ts.isArrowFunction(callback) ||
    ts.isBlock(callback.body) ||
    !parameter ||
    !ts.isIdentifier(parameter) ||
    !staticPropertyChainStartsAt(lowerCall.expression.expression, parameter) ||
    !isPureExpression(callback.body, call => call === includesCall || call === lowerCall)
  ) {
    return null;
  }
  const filterCall = callback.parent;
  const source = ts.isCallExpression(filterCall) &&
    ts.isPropertyAccessExpression(filterCall.expression)
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
  const result = filterCall.parent;
  return ts.isVariableDeclaration(result) &&
    result.initializer === filterCall &&
    ts.isIdentifier(result.name) &&
    ts.isVariableDeclarationList(result.parent) &&
    (result.parent.flags & ts.NodeFlags.Const) !== 0 &&
    bindingDeclarationCount(owner, result.name.text) === 1
    ? { call: filterCall, resultName: result.name, sourceName: source }
    : null;
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
  owner: RuntimeFunctionLike
): boolean {
  return bindingReferences(owner, declaration.text, declaration).every(reference => {
    const access = reference.parent;
    if (!ts.isPropertyAccessExpression(access) || access.expression !== reference) {
      return false;
    }
    if (access.name.text === "length" || access.name.text === "size") return true;
    return READ_ONLY_COLLECTION_METHODS.has(access.name.text) &&
      ts.isCallExpression(access.parent) &&
      access.parent.expression === access;
  });
}

function staticPropertyChainStartsAt(
  expression: ts.Expression,
  root: ts.Identifier
): boolean {
  let current = unwrapTransparentExpression(expression);
  while (ts.isPropertyAccessExpression(current)) {
    current = unwrapTransparentExpression(current.expression);
  }
  return ts.isIdentifier(current) && current.text === root.text;
}

function commonContainingRepeatedRender(
  nodes: readonly ts.Node[],
  owner: RuntimeFunctionLike
): ts.CallExpression | null {
  const first = nodes[0];
  if (!first) return null;
  for (let current: ts.Node | undefined = first; current && current !== owner; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ["map", "flatMap"].includes(current.expression.name.text) &&
      nodes.every(node => nodeWithin(node, current))
    ) {
      return current;
    }
  }
  return null;
}

function repeatedRenderBinding(
  repeated: ts.CallExpression,
  owner: RuntimeFunctionLike
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
  owner: RuntimeFunctionLike
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
  movedFilter: ts.CallExpression
): number {
  const body = owner.body;
  if (!body || !ts.isBlock(body)) return 0;
  let count = 0;
  visitSkippingNestedRuntimeFunctions(body, node => {
    const declaration = ts.isCallExpression(node)
      ? findAncestorUntil(node, ts.isVariableDeclaration, owner)
      : null;
    const statement = declaration?.parent.parent;
    if (
      !ts.isCallExpression(node) ||
      node === movedFilter ||
      node.questionDotToken !== undefined ||
      nodeWithin(node, repeated) ||
      node.getStart() >= repeated.getStart() ||
      !declaration ||
      !statement ||
      !ts.isVariableStatement(statement) ||
      statement.parent !== body ||
      isConditionallyEvaluatedWithin(node, declaration)
    ) {
      return;
    }
    const callee = node.expression;
    const receiver = ts.isPropertyAccessExpression(callee)
      ? unwrapTransparentExpression(callee.expression)
      : null;
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.questionDotToken === undefined &&
      (RENDER_COLLECTION_WORK_METHODS.has(callee.name.text) ||
        (callee.name.text === "from" &&
          !!receiver &&
          ts.isIdentifier(receiver) &&
          receiver.text === "Array"))
    ) {
      count += 1;
    }
  });
  return count;
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
  declaration: ts.Identifier
): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(owner.body, node => {
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
  owner: RuntimeFunctionLike
): boolean {
  const access = reference.parent;
  if (
    !ts.isPropertyAccessExpression(access) ||
    access.expression !== reference
  ) {
    return false;
  }
  if (access.name.text === "length") return !!findAncestorUntil(access, isJsxNode, owner);
  if (access.name.text !== "map" || !ts.isCallExpression(access.parent)) return false;
  const callback = access.parent.arguments[0];
  return !!callback &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    !!findAncestorUntil(access, isJsxNode, owner);
}

function repeatedSubscriptionSuffix(subtree: StateSubtree): string {
  if (subtree.uniqueRepeatedBranch) return " inside its uniquely selected branch";
  return subtree.repeated ? " with a per-item selector" : "";
}

function isCohesiveDelayedPendingState(
  state: StateCandidate,
  usage: StateUsage
): boolean {
  if (
    state.call.arguments[0]?.kind !== ts.SyntaxKind.FalseKeyword ||
    jsxElementCount(state.owner) > 5 ||
    usage.localRenderReads === 0 ||
    usage.localRenderReads !== usage.directRenderNodes.length ||
    usage.effectReads !== 0 ||
    usage.effectWrites !== 0 ||
    usage.deferredReads !== 0 ||
    usage.transportedOccurrences !== 0 ||
    usage.setterCallNodes.length !== 2 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.shadowed ||
    usage.escaped
  ) {
    return false;
  }
  const pending = usage.setterCallNodes.find(call =>
    call.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword
  );
  const reset = usage.setterCallNodes.find(call =>
    call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword
  );
  if (!pending || !reset) return false;

  const scheduled = nearestNestedFunction(pending, state.owner);
  if (!scheduled || !ts.isArrowFunction(scheduled) || !scheduledSetterIsExact(scheduled, pending)) {
    return false;
  }
  const timerCall = scheduled.parent;
  if (
    !ts.isCallExpression(timerCall) ||
    timerCall.arguments[0] !== scheduled ||
    !isNamedCall(timerCall, "setTimeout")
  ) {
    return false;
  }
  const timerDeclaration = timerCall.parent;
  if (
    !ts.isVariableDeclaration(timerDeclaration) ||
    timerDeclaration.initializer !== timerCall ||
    !ts.isIdentifier(timerDeclaration.name) ||
    !ts.isVariableDeclarationList(timerDeclaration.parent) ||
    (timerDeclaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return false;
  }
  const command = nearestMutationFunction(timerCall, state.owner);
  if (
    command === state.owner ||
    (!ts.isArrowFunction(command) &&
      !ts.isFunctionDeclaration(command) &&
      !ts.isFunctionExpression(command)) ||
    !command.body ||
    !ts.isBlock(command.body) ||
    !command.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    !callbackIsEventRooted(command, state.owner, "", new Set())
  ) {
    return false;
  }
  const tryStatement = findAncestorUntil(reset, ts.isTryStatement, command);
  const finalizer = tryStatement?.finallyBlock;
  if (
    !finalizer ||
    finalizer.statements.length !== 2 ||
    !ts.isExpressionStatement(finalizer.statements[0]!) ||
    !ts.isExpressionStatement(finalizer.statements[1]!) ||
    unwrapTransparentExpression(finalizer.statements[1]!.expression) !== reset
  ) {
    return false;
  }
  const clear = unwrapTransparentExpression(finalizer.statements[0]!.expression);
  if (
    !ts.isCallExpression(clear) ||
    !isNamedCall(clear, "clearTimeout") ||
    clear.arguments.length !== 1 ||
    !ts.isIdentifier(clear.arguments[0]!) ||
    clear.arguments[0]!.text !== timerDeclaration.name.text
  ) {
    return false;
  }
  let awaitsPending = false;
  visitSkippingNestedRuntimeFunctions(tryStatement.tryBlock, node => {
    if (ts.isAwaitExpression(node)) awaitsPending = true;
  });
  return awaitsPending;
}

function scheduledSetterIsExact(
  callback: ts.ArrowFunction,
  setter: ts.CallExpression
): boolean {
  if (!ts.isBlock(callback.body)) return unwrapTransparentExpression(callback.body) === setter;
  const statement = callback.body.statements[0];
  return callback.body.statements.length === 1 &&
    !!statement &&
    ts.isExpressionStatement(statement) &&
    unwrapTransparentExpression(statement.expression) === setter;
}

function isNamedCall(call: ts.CallExpression, name: string): boolean {
  const callee = call.expression;
  return ts.isIdentifier(callee)
    ? callee.text === name
    : ts.isPropertyAccessExpression(callee) && callee.name.text === name;
}

function setterOwnedByValueCallSite(
  usage: StateUsage,
  owner: RuntimeFunctionLike
): boolean {
  const valueSite = [...usage.valueTransportSites][0];
  if (valueSite === undefined || usage.setterReferences === 0) return false;
  if (
    usage.setterTargets.size === 1 &&
    usage.setterCalls === 0 &&
    [...usage.valueTargets][0] === [...usage.setterTargets][0] &&
    usage.setterTransportSites.size === 1 &&
    [...usage.setterTransportSites][0] === valueSite
  ) {
    return true;
  }
  const transportsSetterAtValueSite =
    usage.setterTargets.size === 1 &&
    usage.setterTransportSites.size === 1 &&
    [...usage.setterTransportSites][0] === valueSite;
  if (
    !usage.escaped &&
    (usage.setterReferences === usage.setterCalls || transportsSetterAtValueSite) &&
    usage.setterCallNodes.length > 0 &&
    owner.body
  ) {
    let valueSubtree: ts.Node | null = null;
    visitSkippingNestedRuntimeFunctions(owner.body, node => {
      if (
        valueSubtree === null &&
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.getStart() === valueSite
      ) {
        valueSubtree = ts.isJsxOpeningElement(node) ? node.parent : node;
      }
    });
    const subtree = valueSubtree;
    if (subtree && usage.setterCallNodes.every(call => nodeWithin(call, subtree))) {
      return true;
    }
  }
  return usage.setterReferences === usage.setterCalls &&
    usage.setterCallNodes.length > 0 &&
    usage.setterCallNodes.every(call => {
      const attribute = findAncestorUntil(call, ts.isJsxAttribute, owner);
      return attribute !== null && jsxTransportSite(attribute) === valueSite;
    });
}

function setterOwnedByValueTransitionCallSite(
  state: StateCandidate,
  usage: StateUsage
): boolean {
  const setterName = state.setterName;
  if (!setterName || !setterOwnedByValueCallSite(usage, state.owner)) return false;
  if (usage.setterCalls > 0) {
    return usage.setterCallNodes.every(call => {
      const attribute = findAncestorUntil(call, ts.isJsxAttribute, state.owner);
      const opening = attribute?.parent.parent;
      return attribute !== null &&
        opening !== undefined &&
        (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) &&
        isValueTransitionAttribute(opening, attribute.name.getText(), state.valueName);
    });
  }

  const valueSite = [...usage.valueTransportSites][0];
  if (valueSite === undefined || !state.owner.body) return false;
  let transition = false;
  visitSkippingNestedRuntimeFunctions(state.owner.body, node => {
    if (
      !transition &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.getStart() === valueSite &&
      hasDirectInteractionSetter(
        node,
        setterName,
        name => isValueTransitionAttribute(node, name, state.valueName)
      )
    ) {
      transition = true;
    }
  });
  return transition;
}

function controlledLeafRenderCut(
  state: StateCandidate,
  usage: StateUsage,
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>
): {
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  returned: ts.Expression;
} | null {
  const callSite = controlledLeafCallSite(state, usage, isValueTransitionProp);
  if (!callSite) return null;
  const controlled = callSite.opening;
  const controlledSubtree: ts.Node = ts.isJsxOpeningElement(controlled) ? controlled.parent : controlled;
  return hasIndependentRenderCutWitness(
    callSite.returned,
    [controlledSubtree],
    localComponents,
    sourceComponents
  ) ? callSite : null;
}

function controlledLeafProjectionCut(
  state: StateCandidate,
  usage: StateUsage,
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>
): ControlledProjectionCut | null {
  const callSite = controlledLeafCallSite(state, usage);
  if (!callSite) return null;
  const references = controlledProjectionRenderReferences(state, usage);
  if (
    !references ||
    references.some(reference => nearestRepeatedRenderCall(reference, state.owner) !== null)
  ) {
    return null;
  }
  const consumer = lowestCommonJsxSubtree(references, state.owner);
  if (!consumer || jsxElementCountIn(consumer) / jsxElementCount(state.owner) > 0.4) return null;
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
      sourceComponents
    )
  ) {
    return null;
  }
  return {
    consumerLabel: jsxSubtreeLabel(consumer),
    consumerLine: consumer.getSourceFile().getLineAndCharacterOfPosition(consumer.getStart()).line + 1,
  };
}

function controlledSameCallSiteProjectionCut(
  state: StateCandidate,
  usage: StateUsage,
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>
): boolean {
  const callSite = controlledLeafCallSite(state, usage, isValueTransitionProp);
  if (!callSite) return false;
  const references = controlledProjectionRenderReferences(state, usage);
  if (
    !references ||
    references.some(reference =>
      !nodeWithin(reference, callSite.opening) ||
      nearestRepeatedRenderCall(reference, state.owner) !== null
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
    sourceComponents
  );
}

function cohesiveControlledLeafOwner(
  state: StateCandidate,
  usage: StateUsage
): string | null {
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
  if (!directCallSite) return null;
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
  isInteractionProp: (name: string) => boolean = isControlledInteractionProp
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
    !usage.setterCallNodes.every(call => {
      const callback = nearestNestedFunction(call, state.owner);
      return callback !== null && !isSynchronousRenderCallback(callback);
    })
  ) {
    return null;
  }
  const callSite = directUniqueReturnCallSite(usage, state.owner) ??
    directBranchReturnCallSite(usage, state.owner);
  if (!callSite) return null;
  const isStateInteractionProp = (name: string): boolean =>
    isInteractionProp(name) || isPairedSetterProp(callSite.opening, name, state.valueName);
  if (
    !hasDirectInteractionSetter(callSite.opening, state.setterName, isStateInteractionProp) &&
      !hasInlineInteractionSetter(callSite.opening, state, usage, isStateInteractionProp) &&
      !hasInteractionSetterAdapter(callSite.opening, state, usage, isStateInteractionProp)
  ) {
    return null;
  }
  return callSite;
}

function stateReferencesConfinedTo(
  state: StateCandidate,
  boundary: ts.Node
): boolean {
  if (!state.owner.body) return false;
  let confined = true;
  visit(state.owner.body, node => {
    if (
      !confined ||
      !ts.isIdentifier(node) ||
      (node.text !== state.valueName && node.text !== state.setterName) ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (!nodeWithin(node, boundary)) confined = false;
  });
  return confined;
}

function ownerHasRefBackedRenderRead(owner: RuntimeFunctionLike): boolean {
  if (!owner.body) return false;
  let found = false;
  visitSkippingNestedRuntimeFunctions(owner.body, node => {
    if (
      !found &&
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "current"
    ) {
      found = true;
    }
  });
  return found;
}

function controlledProjectionRenderReferences(
  state: StateCandidate,
  usage: StateUsage
): readonly ts.Identifier[] | null {
  const references = oneHopRenderProjectionReferences(state.owner, usage.directRenderNodes);
  if (!references) return null;
  const renderReferences: ts.Identifier[] = [];
  for (const reference of references) {
    const attribute = findAncestorUntil(reference, ts.isJsxAttribute, state.owner);
    if (attribute) {
      if (!isSafeJsxProjectionReference(reference, state.owner)) return null;
      renderReferences.push(reference);
      continue;
    }
    const callback = nearestNestedFunction(reference, state.owner);
    if (
      !callback ||
      (!ts.isArrowFunction(callback) &&
        !ts.isFunctionDeclaration(callback) &&
        !ts.isFunctionExpression(callback)) ||
      !callbackIsEventRooted(callback, state.owner, reference.text, new Set())
    ) {
      return null;
    }
  }
  return renderReferences.length > 0 ? renderReferences : null;
}

function hasDirectInteractionSetter(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  setterName: string,
  isInteractionProp: (name: string) => boolean = isControlledInteractionProp
): boolean {
  return opening.attributes.properties.some(attribute =>
    ts.isJsxAttribute(attribute) &&
    isInteractionProp(attribute.name.getText()) &&
    attribute.initializer !== undefined &&
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression !== undefined &&
    ts.isIdentifier(attribute.initializer.expression) &&
    attribute.initializer.expression.text === setterName
  );
}

function hasInlineInteractionSetter(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  state: StateCandidate,
  usage: StateUsage,
  isInteractionProp: (name: string) => boolean = isControlledInteractionProp
): boolean {
  if (
    !state.setterName ||
    usage.setterCalls === 0 ||
    usage.setterTransportSites.size !== 0
  ) {
    return false;
  }
  return usage.setterCallNodes.some(call => {
    if (call.arguments.some(argument => containsCallExpression(argument))) return false;
    const attribute = findAncestorUntil(call, ts.isJsxAttribute, state.owner);
    if (
      !attribute ||
      !isInteractionProp(attribute.name.getText()) ||
      attribute.parent?.parent !== opening ||
      !attribute.initializer ||
      !ts.isJsxExpression(attribute.initializer)
    ) {
      return false;
    }
    const callback = attribute.initializer.expression;
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return false;
    if (nearestNestedFunction(call, state.owner) !== callback) return false;
    if (ts.isCallExpression(callback.body)) return callback.body === call;
    return ts.isBlock(callback.body) &&
      callback.body.statements.length === 1 &&
      ts.isExpressionStatement(callback.body.statements[0]!) &&
      callback.body.statements[0]!.expression === call;
  });
}

function hasInteractionSetterAdapter(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  state: StateCandidate,
  usage: StateUsage,
  isInteractionProp: (name: string) => boolean = isControlledInteractionProp
): boolean {
  if (
    !state.setterName ||
    usage.setterReferences !== 1 ||
    usage.setterCalls !== 1 ||
    usage.setterCallNodes.length !== 1 ||
    usage.setterTransportSites.size !== 0
  ) {
    return false;
  }
  const call = usage.setterCallNodes[0];
  if (
    !call ||
    (call.arguments.some(argument => containsCallExpression(argument)) &&
      !isExactControlledArrayMembershipToggle(state, usage))
  ) {
    return false;
  }
  const callback = nearestMutationFunction(call, state.owner);
  if (
    callback === state.owner ||
    (!ts.isArrowFunction(callback) &&
      !ts.isFunctionDeclaration(callback) &&
      !ts.isFunctionExpression(callback)) ||
    jsxProducerForSetterCall(call, state.owner) !== opening
  ) {
    return false;
  }
  const name = localCallbackBindingName(callback);
  if (!name) return false;
  const interaction = opening.attributes.properties.some(attribute =>
    ts.isJsxAttribute(attribute) &&
    isInteractionProp(attribute.name.getText()) &&
    attribute.initializer !== undefined &&
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression !== undefined &&
    ts.isIdentifier(attribute.initializer.expression) &&
    attribute.initializer.expression.text === name
  );
  if (!interaction || !callback.body) return false;
  if (ts.isCallExpression(callback.body)) return callback.body === call;
  return ts.isBlock(callback.body) &&
    callback.body.statements.length === 1 &&
    ts.isExpressionStatement(callback.body.statements[0]!) &&
    callback.body.statements[0]!.expression === call;
}

function isExactControlledArrayMembershipToggle(
  state: StateCandidate,
  usage: StateUsage
): boolean {
  if (
    usage.setterCalls !== 1 ||
    usage.setterReferences !== 1 ||
    usage.setterCallNodes.length !== 1
  ) {
    return false;
  }
  const setterCall = usage.setterCallNodes[0]!;
  const updater = setterCall.arguments[0] && unwrapTransparentExpression(setterCall.arguments[0]);
  if (
    !updater ||
    (!ts.isArrowFunction(updater) && !ts.isFunctionExpression(updater)) ||
    updater.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    updater.asteriskToken ||
    updater.parameters.length !== 1 ||
    !ts.isIdentifier(updater.parameters[0]!.name)
  ) {
    return false;
  }
  const previous = updater.parameters[0]!.name.text;
  const toggle = arrayMembershipToggle(updater);
  if (!toggle) return false;

  const value = arrayMembershipValue(toggle.condition, previous);
  if (!value) return false;
  const adapter = nearestMutationFunction(setterCall, state.owner);
  if (
    adapter === state.owner ||
    !adapter.parameters.some(parameter =>
      ts.isIdentifier(parameter.name) && parameter.name.text === value
    )
  ) {
    return false;
  }
  return isArrayMembershipRemoval(toggle.whenPresent, previous, value) &&
    isArrayMembershipAppend(toggle.whenAbsent, previous, value);
}

function arrayMembershipToggle(
  updater: ts.ArrowFunction | ts.FunctionExpression
): {
  condition: ts.Expression;
  whenAbsent: ts.Expression;
  whenPresent: ts.Expression;
} | null {
  const expression = returnedCallbackExpression(updater);
  if (expression && ts.isConditionalExpression(expression)) {
    return {
      condition: expression.condition,
      whenAbsent: expression.whenFalse,
      whenPresent: expression.whenTrue,
    };
  }
  if (!ts.isBlock(updater.body) || updater.body.statements.length !== 1) return null;
  const statement = updater.body.statements[0]!;
  if (!ts.isIfStatement(statement) || !statement.elseStatement) return null;
  const whenPresent = returnedStatementExpression(statement.thenStatement);
  const whenAbsent = returnedStatementExpression(statement.elseStatement);
  return whenPresent && whenAbsent
    ? { condition: statement.expression, whenAbsent, whenPresent }
    : null;
}

function returnedStatementExpression(statement: ts.Statement): ts.Expression | null {
  const returned = ts.isBlock(statement)
    ? statement.statements.length === 1 && ts.isReturnStatement(statement.statements[0]!)
      ? statement.statements[0]
      : null
    : ts.isReturnStatement(statement)
      ? statement
      : null;
  return returned?.expression ? unwrapTransparentExpression(returned.expression) : null;
}

function returnedCallbackExpression(
  callback: ts.ArrowFunction | ts.FunctionExpression
): ts.Expression | null {
  if (!ts.isBlock(callback.body)) return unwrapTransparentExpression(callback.body);
  const statement = callback.body.statements[0];
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
  value: string
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
  return comparison !== null &&
    ts.isBinaryExpression(comparison) &&
    comparison.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    isIdentifierNamed(comparison.left, item) &&
    isIdentifierNamed(comparison.right, value);
}

function isArrayMembershipAppend(
  expression: ts.Expression,
  previous: string,
  value: string
): boolean {
  const append = unwrapTransparentExpression(expression);
  if (!ts.isArrayLiteralExpression(append) || append.elements.length !== 2) return false;
  const [spread, member] = append.elements;
  return spread !== undefined &&
    ts.isSpreadElement(spread) &&
    isIdentifierNamed(spread.expression, previous) &&
    member !== undefined &&
    !ts.isSpreadElement(member) &&
    isIdentifierNamed(member, value);
}

function isIdentifierNamed(expression: ts.Expression, name: string): boolean {
  const value = unwrapTransparentExpression(expression);
  return ts.isIdentifier(value) && value.text === name;
}

function isValueTransitionAttribute(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
  valueName: string
): boolean {
  return isValueTransitionProp(name) || isPairedSetterProp(opening, name, valueName);
}

function isVisibilityTransitionAttribute(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
  valueName: string
): boolean {
  if (/^on(?:Open|Visible|Visibility)Change$/.test(name)) return true;
  if (!isPairedSetterProp(opening, name, valueName)) return false;
  return opening.attributes.properties.some(attribute =>
    ts.isJsxAttribute(attribute) &&
    /^(?:isOpen|isVisible|open|visible)$/.test(attribute.name.getText()) &&
    attribute.initializer !== undefined &&
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression !== undefined &&
    ts.isIdentifier(attribute.initializer.expression) &&
    attribute.initializer.expression.text === valueName
  );
}

function isPairedSetterProp(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement | undefined,
  name: string,
  valueName: string
): boolean {
  const setter = /^set([A-Z][A-Za-z0-9]*)$/.exec(name)?.[1];
  if (!opening || !setter) return false;
  const normalizedSetter = normalizeStatePropName(setter);
  return opening.attributes.properties.some(attribute => {
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
  return name.replace(/^is(?=[A-Z])/, "").toLowerCase();
}

function directUniqueReturnCallSite(
  usage: StateUsage,
  owner: RuntimeFunctionLike
): {
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  returned: ts.Expression;
} | null {
  const callSite = directBranchReturnCallSite(usage, owner);
  return callSite && uniqueReturnedExpression(owner) ? callSite : null;
}

function setterCallEndsCommand(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike
): boolean {
  const command = nearestMutationFunction(call, owner);
  if (!command.body) return false;
  if (!ts.isBlock(command.body)) {
    return unwrapTransparentExpression(command.body) === call;
  }
  const statement = call.parent;
  return ts.isExpressionStatement(statement) &&
    statement.expression === call &&
    statement.parent === command.body &&
    command.body.statements.at(-1) === statement;
}

function uniqueReturnedExpression(owner: RuntimeFunctionLike): ts.Expression | null {
  if (!owner.body) return null;
  const expressions: ts.Expression[] = [];
  visitSkippingNestedRuntimeFunctions(owner.body, node => {
    if (ts.isReturnStatement(node) && node.expression) expressions.push(node.expression);
  });
  return expressions.length === 1 ? expressions[0]! : null;
}

function directBranchReturnCallSite(
  usage: StateUsage,
  owner: RuntimeFunctionLike
): {
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  returned: ts.Expression;
} | null {
  const valueSite = [...usage.valueTransportSites][0];
  if (!owner.body || valueSite === undefined || usage.repeatedValueTransport) return null;
  const openings: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
  visitSkippingNestedRuntimeFunctions(owner.body, node => {
    if (
      openings.length === 0 &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.getStart() === valueSite
    ) {
      openings.push(node);
    }
  });
  const opening = openings[0];
  if (!opening) return null;

  for (
    let current: ts.Node | undefined = opening.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (ts.isVariableDeclaration(current) || isRuntimeFunctionLike(current)) return null;
    if (ts.isReturnStatement(current)) {
      return current.expression && nodeWithin(opening, current.expression)
        ? { opening, returned: current.expression }
        : null;
    }
  }
  return null;
}

function setterCallsDiscardConfidence(
  calls: readonly ts.CallExpression[]
): "certain" | "probable" | null {
  let confidence: "certain" | "probable" = "certain";
  for (const call of calls) {
    const argument = call.arguments[0];
    if (call.arguments.length !== 1 || !argument) return null;
    const argumentConfidence = discardableExpressionConfidence(argument);
    if (!argumentConfidence) return null;
    if (argumentConfidence === "probable") confidence = "probable";
  }
  return confidence;
}

function stateReadsOnlyCalculateOwnSetter(
  state: StateCandidate,
  usage: StateUsage
): boolean {
  if (
    usage.effectWrites > 0 ||
    usage.setterCallNodes.length === 0 ||
    usage.setterCallNodes.some(call =>
      nearestMutationFunction(call, state.owner) === state.owner ||
      call.arguments.length !== 1 ||
      !call.arguments[0] ||
      !isEvaluationInert(call.arguments[0])
    )
  ) {
    return false;
  }

  let reads = 0;
  let safe = true;
  visit(state.owner.body, node => {
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
    safe = usage.setterCallNodes.some(call =>
      call.arguments[0] !== undefined && nodeWithin(node, call.arguments[0])
    );
  });
  return safe && reads > 0;
}

function stateOnlyReceivesItsInitialPrimitive(
  state: StateCandidate,
  usage: StateUsage
): boolean {
  const initializer = state.call.arguments[0];
  if (
    !initializer ||
    usage.setterCallNodes.length === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.shadowed ||
    usage.escaped
  ) {
    return false;
  }
  return usage.setterCallNodes.every(call =>
    call.arguments.length === 1 &&
    call.arguments[0] !== undefined &&
    samePrimitiveLiteral(initializer, call.arguments[0])
  );
}

function samePrimitiveLiteral(left: ts.Expression, right: ts.Expression): boolean {
  const leftValue = unwrapTransparentExpression(left);
  const rightValue = unwrapTransparentExpression(right);
  if (leftValue.kind !== rightValue.kind) return false;
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

function discardableExpressionConfidence(
  node: ts.Expression
): "certain" | "probable" | null {
  if (isEvaluationInert(node)) return "certain";
  const value = unwrapTransparentExpression(node);
  if (ts.isPropertyAccessExpression(value)) {
    return discardableExpressionConfidence(value.expression) ? "probable" : null;
  }
  if (ts.isArrayLiteralExpression(value)) {
    return combineDiscardConfidence(
      value.elements.map(element =>
        ts.isSpreadElement(element) ? null : discardableExpressionConfidence(element)
      )
    );
  }
  if (ts.isObjectLiteralExpression(value)) {
    return combineDiscardConfidence(
      value.properties.map(property => {
        if (ts.isShorthandPropertyAssignment(property)) return "certain";
        return ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name)
          ? discardableExpressionConfidence(property.initializer)
          : null;
      })
    );
  }
  return null;
}

function combineDiscardConfidence(
  confidences: readonly ("certain" | "probable" | null)[]
): "certain" | "probable" | null {
  if (confidences.some(confidence => confidence === null)) return null;
  return confidences.some(confidence => confidence === "probable") ? "probable" : "certain";
}

interface StateSubtree {
  kind: "direct" | "effect-command-projection" | "effect-projection" | "effect-split-projection" | "gate" | "projection";
  leafCount?: number;
  label: string;
  line: number;
  node: JsxSubtreeNode;
  repeated: boolean;
  uniqueRepeatedBranch: boolean;
  unstable: boolean;
}

function analyzeStateSubtree(
  state: StateCandidate,
  usage: StateUsage,
  projectionAllowed: boolean,
  pureProjectionImports: ReadonlySet<string>,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
  effectOwnedMemoizedCommand: boolean,
  childContracts: ChildContractResolver | null
): StateSubtree | null {
  const ownerJsx = jsxElementCount(state.owner);
  const effectWrittenPresentation =
    usage.effectWrites > 0 &&
    usage.effectWrites === usage.setterCalls &&
    usage.setterReferences === usage.setterCalls &&
    usage.setterCallNodes.every(call => hasAncestorInSet(call, directEffectCalls)) &&
    usage.deferredReads === 0 &&
    !usage.setterUsesPreviousValue;
  const allowedProjectionCalls = effectWrittenPresentation
    ? new Set(
        [...pureProjectionImports].filter(name => !ownerDeclaresBinding(state.owner, name))
      )
    : EMPTY_BINDINGS;
  const splitEffectProjection = effectWrittenPresentation
    ? effectSplitProjectionSubtree(
        state,
        usage,
        ownerJsx,
        pureProjectionImports
      )
    : null;
  if (
    (ownerJsx < 8 && !effectWrittenPresentation) ||
    stateMayHoldCallable(state) ||
    usage.directRenderNodes.length === 0 ||
    usage.localRenderReads !== usage.directRenderNodes.length ||
    usage.setterCallNodes.length === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.effectReads > 0 ||
    (usage.effectWrites > 0 && !effectWrittenPresentation) ||
    (usage.deferredReads > 0 && !hasOnlyEventCommandReads(state)) ||
    usage.shadowed ||
    (usage.escaped && !splitEffectProjection)
  ) {
    return null;
  }

  const projectionNodes = effectWrittenPresentation
    ? multipleOneHopRenderProjectionReferences(state.owner, usage.directRenderNodes) ??
      usage.directRenderNodes
    : boundedRenderProjectionReferences(state.owner, usage.directRenderNodes) ??
      oneHopRenderProjectionReferences(state.owner, usage.directRenderNodes) ??
      usage.directRenderNodes;
  if (splitEffectProjection) return splitEffectProjection;
  const renderReadsInNestedCallbacks = projectionNodes.some(
    node => nearestNestedFunction(node, state.owner) !== null
  );
  const safeJsxChildProjection =
    renderReadsInNestedCallbacks &&
    sharesJsxChildRenderCallback(projectionNodes, state.owner) &&
    projectionWritesAreDeferred(usage, state.owner, directEffectCalls, childContracts);
  const uniqueRepeatedProjection =
    isUniquelySelectedRepeatedProjection(projectionNodes, state.owner);
  if (
    !effectWrittenPresentation &&
    usage.transportedOccurrences === 0 &&
    projectionAllowed &&
    !renderReadsInNestedCallbacks
  ) {
    const directNodes = [...usage.directRenderNodes, ...usage.setterCallNodes];
    const direct = lowestCommonJsxSubtree(directNodes, state.owner);
    if (direct) {
      const subtreeJsx = jsxElementCountIn(direct);
      if (ownerJsx >= 12 && subtreeJsx >= 2 && subtreeJsx / ownerJsx <= 0.4) {
        return stateSubtreeResult("direct", direct, directNodes, state);
      }
    }
  }

  const gateProjection = renderReadsInNestedCallbacks
    ? null
    : commonRenderGateSubtree(projectionNodes, state.owner);
  const safeProjectionReferences = projectionNodes.every(node =>
    isSafeJsxProjectionReference(node, state.owner, allowedProjectionCalls) ||
    (effectWrittenPresentation &&
      isSafeEffectPresentationReference(node, state.owner))
  );
  if (
    !projectionAllowed ||
    !(safeProjectionReferences || gateProjection) ||
    (renderReadsInNestedCallbacks &&
      !isKeyedRepeatedProjection(projectionNodes, state.owner) &&
      !uniqueRepeatedProjection &&
      !safeJsxChildProjection)
  ) {
    return null;
  }
  const projection = gateProjection ?? lowestCommonJsxSubtree(projectionNodes, state.owner);
  if (
    !projection ||
    !isMaterialStateSubtree(
      projection,
      ownerJsx,
      effectWrittenPresentation,
      uniqueRepeatedProjection
    ) ||
    (usage.transportedOccurrences > 0 &&
      !isSafeMixedProjectionTransport(
        state,
        usage,
        projection,
        effectWrittenPresentation
      ))
  ) {
    return null;
  }
  return stateSubtreeResult(
    effectOwnedMemoizedCommand
      ? "effect-command-projection"
      : effectWrittenPresentation
      ? "effect-projection"
      : gateProjection
        ? "gate"
        : "projection",
    projection,
    projectionNodes,
    state,
    uniqueRepeatedProjection
  );
}

function projectionWritesAreDeferred(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
  childContracts: ChildContractResolver | null
): boolean {
  return usage.setterCallNodes.every(call => {
    if (ancestorCallInSet(call, directEffectCalls, owner)) return true;
    const callback = nearestMutationFunction(call, owner);
    const attribute = callback === owner
      ? null
      : findAncestorUntil(callback, ts.isJsxAttribute, owner);
    const prop = attribute?.name.getText() ?? null;
    const target = attribute ? jsxTargetName(attribute) : null;
    if (!attribute || !prop || !target || !/^on[A-Z]/.test(prop)) return false;
    if (!isCustomJsxTarget(target)) return true;
    return childContracts?.frameworkEventComponent(target) === true ||
      childContracts?.componentCallbackPropIsDeferred(target, prop) === true;
  });
}

function sharesJsxChildRenderCallback(
  nodes: readonly ts.Node[],
  owner: RuntimeFunctionLike
): boolean {
  let common: ts.ArrowFunction | ts.FunctionExpression | null = null;
  for (const node of nodes) {
    const callback = nearestNestedFunction(node, owner);
    if (
      !callback ||
      (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
      (common !== null && common !== callback)
    ) {
      return false;
    }
    common = callback;
  }
  if (!common) return false;

  let expression: ts.Expression = common;
  while (
    (ts.isParenthesizedExpression(expression.parent) ||
      ts.isAsExpression(expression.parent) ||
      ts.isTypeAssertionExpression(expression.parent) ||
      ts.isSatisfiesExpression(expression.parent) ||
      ts.isNonNullExpression(expression.parent)) &&
    expression.parent.expression === expression
  ) {
    expression = expression.parent;
  }
  const container = expression.parent;
  return ts.isJsxExpression(container) &&
    (ts.isJsxElement(container.parent) || ts.isJsxFragment(container.parent));
}

/**
 * Keeps an effect-owned numeric source at owner lifetime while proving that
 * all of its render flow terminates in a small set of stable presentation
 * leaves. Local helper calls qualify only when their implementation is pure
 * and closes over inert module constants.
 */
function effectSplitProjectionSubtree(
  state: StateCandidate,
  usage: StateUsage,
  ownerJsx: number,
  pureProjectionImports: ReadonlySet<string>
): StateSubtree | null {
  if (
    ownerJsx < 12 ||
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
  const renderRoots = effectSplitRenderRoots(state, usage, allowedCalls);
  if (!renderRoots) return null;
  const terminals = terminalRenderProjectionReferences(
    state.owner,
    renderRoots,
    allowedCalls
  );
  if (!terminals || terminals.length < 2) return null;

  const leaves: JsxSubtreeNode[] = [];
  for (const terminal of terminals) {
    const repeated = nearestRepeatedRenderCall(terminal, state.owner);
    if (repeated) {
      const callback = repeated.arguments[0];
      const leaf = nearestJsxElement(repeated, state.owner);
      if (
        !callback ||
        (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
        !repeatedRenderHasStableItemKey(callback) ||
        !leaf ||
        jsxElementCountIn(leaf) > 9 ||
        !nodeWithin(terminal, leaf)
      ) {
        return null;
      }
      leaves.push(leaf);
      continue;
    }
    if (!isSafeJsxProjectionReference(terminal, state.owner, allowedCalls)) return null;
    const leaf = nearestJsxElement(terminal, state.owner);
    if (!leaf) return null;
    leaves.push(leaf);
  }

  const uniqueLeaves = [...new Map(leaves.map(leaf => [leaf.getStart(), leaf])).values()];
  if (uniqueLeaves.length < 2 || uniqueLeaves.length > 6) return null;
  const leafElements = uniqueLeaves.reduce((total, leaf) => total + jsxElementCountIn(leaf), 0);
  if (leafElements / ownerJsx > 0.4) return null;

  const common = lowestCommonJsxSubtree(uniqueLeaves, state.owner);
  if (!common) return null;
  const result = stateSubtreeResult(
    "effect-split-projection",
    common,
    terminals,
    state
  );
  result.leafCount = uniqueLeaves.length;
  return result;
}

function effectSplitRenderRoots(
  state: StateCandidate,
  usage: StateUsage,
  allowedCalls: ReadonlySet<string>
): readonly ts.Identifier[] | null {
  if (!state.owner.body) return null;
  const direct = new Set(usage.directRenderNodes);
  const roots: ts.Identifier[] = [];
  let safe = true;
  visit(state.owner.body, node => {
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
      call.arguments.some(argument => nodeWithin(node, argument)) &&
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
  const initializer = state.call.arguments[0];
  if (!initializer) return false;
  const value = unwrapTransparentExpression(initializer);
  return ts.isNumericLiteral(value) ||
    ts.isPrefixUnaryExpression(value) &&
      (value.operator === ts.SyntaxKind.PlusToken || value.operator === ts.SyntaxKind.MinusToken) &&
      ts.isNumericLiteral(unwrapTransparentExpression(value.operand));
}

function terminalRenderProjectionReferences(
  owner: RuntimeFunctionLike,
  roots: readonly ts.Node[],
  allowedCalls: ReadonlySet<string>
): readonly ts.Identifier[] | null {
  if (!owner.body || roots.some(root => !ts.isIdentifier(root))) return null;
  const pending = roots.map(root => ({ depth: 0, reference: root as ts.Identifier }));
  const terminals: ts.Identifier[] = [];
  const visited = new Set<number>();

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current.reference.getStart())) continue;
    visited.add(current.reference.getStart());
    const declaration = findAncestorUntil(current.reference, ts.isVariableDeclaration, owner);
    if (!declaration || !declaration.initializer || !nodeWithin(current.reference, declaration.initializer)) {
      terminals.push(current.reference);
      continue;
    }
    if (
      current.depth >= 3 ||
      !ts.isIdentifier(declaration.name) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
      bindingDeclarationCount(owner, declaration.name.text) !== 1 ||
      !isSafeProjectionExpression(
        declaration.initializer,
        current.reference,
        allowedCalls,
        projectionMathCalls(owner)
      )
    ) {
      return null;
    }
    const references: ts.Identifier[] = [];
    visit(owner.body, node => {
      if (
        ts.isIdentifier(node) &&
        node.text === declaration.name.getText() &&
        node !== declaration.name &&
        !isDeclarationName(node) &&
        !isNonValueIdentifier(node)
      ) {
        references.push(node);
      }
    });
    if (references.length === 0) return null;
    pending.push(...references.map(reference => ({ depth: current.depth + 1, reference })));
  }
  return terminals.length > 0 ? terminals : null;
}

function projectionMathCalls(owner: RuntimeFunctionLike): ReadonlySet<string> {
  if (sourceHasRuntimeBinding(owner.getSourceFile(), "Math")) return EMPTY_BINDINGS;
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
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer)) ||
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
  sourceFile: ts.SourceFile
): boolean {
  if (
    fn.asteriskToken ||
    fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    fn.parameters.length === 0 ||
    fn.parameters.some(parameter => !ts.isIdentifier(parameter.name) || parameter.initializer)
  ) {
    return false;
  }
  const expression = ts.isBlock(fn.body)
    ? fn.body.statements.length === 1 &&
      ts.isReturnStatement(fn.body.statements[0]!) &&
      fn.body.statements[0]!.expression
    : fn.body;
  if (!expression) return false;
  if (!isSafeProjectionExpression(expression, expression, EMPTY_BINDINGS, projectionMathCalls(fn))) {
    return false;
  }

  let safe = true;
  visit(fn.body, node => {
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
  boundary: ts.ArrowFunction | ts.FunctionExpression
): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (isRuntimeFunctionLike(current)) {
      const names = new Set<string>();
      for (const parameter of current.parameters) collectBindingNames(parameter.name, names);
      if (names.has(node.text)) return true;
    }
    if (current === boundary) return false;
  }
  return false;
}

function moduleConstIsEvaluationInert(sourceFile: ts.SourceFile, name: string): boolean {
  const matches: ts.VariableDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) matches.push(declaration);
    }
  }
  return matches.length === 1 && !!matches[0]!.initializer && isEvaluationInert(matches[0]!.initializer);
}

function nearestJsxElement(node: ts.Node, boundary: ts.Node): JsxSubtreeNode | null {
  return findAncestorUntil(
    node,
    (candidate): candidate is JsxSubtreeNode =>
      ts.isJsxElement(candidate) || ts.isJsxSelfClosingElement(candidate) || ts.isJsxFragment(candidate),
    boundary
  );
}

function isMaterialStateSubtree(
  subtree: JsxSubtreeNode,
  ownerJsx: number,
  effectWrittenPresentation: boolean,
  uniqueRepeatedProjection: boolean
): boolean {
  const subtreeJsx = jsxElementCountIn(subtree);
  return (ownerJsx >= 12 && subtreeJsx / ownerJsx <= 0.4) ||
    (uniqueRepeatedProjection && ownerJsx >= 8 && subtreeJsx / ownerJsx <= 0.25) ||
    (effectWrittenPresentation && ownerJsx < 12 && ownerJsx - subtreeJsx >= 5);
}

function multipleOneHopRenderProjectionReferences(
  owner: RuntimeFunctionLike,
  renderNodes: readonly ts.Node[]
): readonly ts.Identifier[] | null {
  const references = new Set<ts.Identifier>();
  for (const renderNode of renderNodes) {
    const projected = oneHopRenderProjectionReferences(owner, [renderNode]);
    if (!projected) return null;
    for (const reference of projected) references.add(reference);
  }
  return references.size > 0 ? [...references] : null;
}

function isSafeEffectPresentationReference(
  node: ts.Node,
  owner: RuntimeFunctionLike
): boolean {
  if (!findAncestorUntil(node, isJsxNode, owner)) return false;
  if (commonRenderGateSubtree([node], owner)) return true;
  const repeated = nearestRepeatedRenderCall(node, owner);
  if (
    !repeated ||
    !ts.isPropertyAccessExpression(repeated.expression) ||
    repeated.expression.expression !== node
  ) {
    return false;
  }
  const callback = repeated.arguments[0];
  return !!callback &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    repeatedRenderHasStableItemKey(callback);
}

function isKeyedRepeatedProjection(
  nodes: readonly ts.Node[],
  owner: RuntimeFunctionLike
): boolean {
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
  return !!binding && nodes.every(node => {
    const expression = jsxProjectionExpression(node, owner);
    return !!expression && expressionDependsOnBinding(expression, binding, callback);
  });
}

function jsxProjectionExpression(
  node: ts.Node,
  boundary: RuntimeFunctionLike
): ts.Expression | null {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, boundary);
  if (attribute?.initializer && ts.isJsxExpression(attribute.initializer)) {
    return attribute.initializer.expression ?? null;
  }
  return findAncestorUntil(node, ts.isJsxExpression, boundary)?.expression ?? null;
}

function stateSubtreeResult(
  kind: StateSubtree["kind"],
  node: JsxSubtreeNode,
  renderNodes: readonly ts.Node[],
  state: StateCandidate,
  uniqueRepeatedBranch = false
): StateSubtree {
  const lineNode = kind === "gate" && nearestNestedFunction(node, state.owner)
    ? renderNodes[0] ?? node
    : node;
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

function isSafeMixedProjectionTransport(
  state: StateCandidate,
  usage: StateUsage,
  common: JsxSubtreeNode,
  allowNestedSite = false
): boolean {
  const site = [...usage.valueTransportSites][0];
  const target = [...usage.valueTargets][0];
  if (
    usage.valueTransportSites.size !== 1 ||
    usage.setterTransportSites.size !== 0 ||
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
  return !!props && props.size > 0 && [...props].every(prop =>
    !/^(?:children|key|ref|render|on[A-Z])/.test(prop)
  );
}

function setterReactiveMutationPaths(
  state: StateCandidate,
  usage: StateUsage,
  mutationBindings: ReadonlySet<string>
): { all: boolean; any: boolean } {
  let any = false;
  let all = mutationBindings.size > 0 && usage.setterCallNodes.length > 0;
  for (const call of usage.setterCallNodes) {
    const pathHasMutation = mutationBindings.size > 0 && functionAncestors(call, state.owner).some(ancestor =>
      functionDirectlyCallsBinding(ancestor, mutationBindings)
    );
    any ||= pathHasMutation;
    all &&= pathHasMutation;
  }
  return { all, any };
}

function functionAncestors(
  node: ts.Node,
  owner: RuntimeFunctionLike
): RuntimeFunctionLike[] {
  const ancestors: RuntimeFunctionLike[] = [];
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (isRuntimeFunctionLike(current)) ancestors.push(current);
    if (current === owner) break;
  }
  return ancestors;
}

function functionDirectlyCallsBinding(
  fn: RuntimeFunctionLike,
  bindings: ReadonlySet<string>
): boolean {
  if (!fn.body) return false;
  let calls = false;
  visitSkippingNestedFunctions(fn.body, fn, node => {
    if (!ts.isCallExpression(node)) return;
    const expression = node.expression;
    if (ts.isIdentifier(expression) && bindings.has(expression.text)) calls = true;
    if (
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      bindings.has(`${expression.expression.text}.${expression.name.text}`)
    ) calls = true;
  });
  return calls;
}

function setterCallbackEscapesThroughUnknownHook(
  state: StateCandidate,
  usage: StateUsage
): boolean {
  return usage.setterCallNodes.some(call => {
    for (let current: ts.Node | undefined = call.parent; current && current !== state.owner; current = current.parent) {
      const hookName = ts.isCallExpression(current)
        ? ts.isIdentifier(current.expression)
          ? current.expression.text
          : ts.isPropertyAccessExpression(current.expression)
            ? current.expression.name.text
            : null
        : null;
      if (
        hookName &&
        /^use[A-Z0-9]/.test(hookName) &&
        !["useCallback", "useEffect"].includes(hookName) &&
        ts.isCallExpression(current) &&
        current.arguments.some(argument => nodeWithin(call, argument))
      ) {
        return true;
      }
    }
    return false;
  });
}

function isSourceProvenMemoizedOptionCommand(
  state: StateCandidate,
  usage: StateUsage,
  imports: HookImports,
  childContracts: ChildContractResolver
): boolean {
  if (
    !state.owner.body ||
    !hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) ||
    usage.localRenderReads !== 0 ||
    usage.effectReads !== 0 ||
    usage.effectWrites !== 0 ||
    usage.deferredReads !== 0 ||
    usage.valueTransportSites.size !== 1 ||
    usage.valueTargets.size !== 1 ||
    usage.setterCallNodes.length === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.setterUsesPreviousValue ||
    usage.shadowed ||
    usage.escaped ||
    usage.setterCallNodes.some(call => {
      const value = call.arguments[0];
      return call.arguments.length !== 1 ||
        !value ||
        (value.kind !== ts.SyntaxKind.TrueKeyword && value.kind !== ts.SyntaxKind.FalseKeyword);
    })
  ) {
    return false;
  }

  const deferredSetters = usage.setterCallNodes.filter(call =>
    !isInsideJsxEventCallback(call, state.owner)
  );
  if (deferredSetters.length === 0) return false;

  let memoCall: ts.CallExpression | null = null;
  let callbackProp: string | null = null;
  for (const setter of deferredSetters) {
    const containingMemo = findAncestorUntil(
      setter,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        isImportedHookCall(node, imports.useMemo, imports.reactNamespaces, "useMemo"),
      state.owner
    );
    const factory = containingMemo?.arguments[0];
    const property = factory
      ? findAncestorUntil(setter, ts.isPropertyAssignment, factory)
      : null;
    const propertyName = property ? staticPropertyName(property.name) : null;
    const callback = property
      ? nearestNestedFunction(setter, state.owner)
      : null;
    if (
      !containingMemo ||
      !factory ||
      (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) ||
      !property ||
      !propertyName ||
      !callback ||
      callback === factory ||
      !nodeWithin(callback, property) ||
      (memoCall !== null && memoCall !== containingMemo) ||
      (callbackProp !== null && callbackProp !== propertyName)
    ) {
      return false;
    }
    memoCall = containingMemo;
    callbackProp = propertyName;
  }
  if (!memoCall || !callbackProp) return false;

  const declaration = findAncestorUntil(memoCall, ts.isVariableDeclaration, state.owner);
  if (
    !declaration?.initializer ||
    unwrapTransparentExpression(declaration.initializer) !== memoCall ||
    !ts.isIdentifier(declaration.name) ||
    bindingDeclarationCount(state.owner, declaration.name.text) !== 1
  ) {
    return false;
  }
  const memoBinding = declaration.name.text;

  let target: string | null = null;
  let propName: string | null = null;
  let transportCount = 0;
  let safe = true;
  visit(state.owner.body, node => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== memoBinding ||
      node === declaration.name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (
      ts.isPropertyAccessExpression(node.parent) &&
      node.parent.expression === node &&
      node.parent.name.text === "length"
    ) {
      return;
    }
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
    if (!attribute || !isDirectJsxAttributeExpression(attribute, node)) {
      safe = false;
      return;
    }
    const opening = jsxOpeningForAttribute(attribute);
    const nextTarget = opening?.tagName.getText() ?? null;
    const nextProp = attribute.name.getText();
    if (
      !nextTarget ||
      transportCount > 0 ||
      (target !== null && target !== nextTarget) ||
      (propName !== null && propName !== nextProp)
    ) {
      safe = false;
      return;
    }
    target = nextTarget;
    propName = nextProp;
    transportCount += 1;
  });
  if (!safe || transportCount !== 1 || !target || !propName) return false;
  return childContracts.componentArrayItemCallbackIsDeferred(
    target,
    propName,
    callbackProp
  );
}

function staticPropertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

function isEffectOwnedMemoizedPresentationState(
  state: StateCandidate,
  usage: StateUsage,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
  imports: HookImports
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

  let memoCall: ts.CallExpression | null = null;
  for (const setterCall of usage.setterCallNodes) {
    const containingMemo = findAncestorUntil(
      setterCall,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        isImportedHookCall(
          node,
          imports.useMemo,
          imports.reactNamespaces,
          "useMemo"
        ),
      state.owner
    );
    if (!containingMemo || (memoCall !== null && memoCall !== containingMemo)) return false;
    memoCall = containingMemo;
  }
  if (!memoCall) return false;

  const factory = memoCall.arguments[0];
  const declaration = findAncestorUntil(memoCall, ts.isVariableDeclaration, state.owner);
  if (
    !factory ||
    (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) ||
    !declaration?.initializer ||
    unwrapTransparentExpression(declaration.initializer) !== memoCall ||
    !ts.isIdentifier(declaration.name) ||
    bindingDeclarationCount(state.owner, declaration.name.text) !== 1 ||
    !usage.setterCallNodes.every(call => nodeWithin(call, factory))
  ) {
    return false;
  }

  const binding = declaration.name.text;
  let invokedByEffect = false;
  let safe = true;
  visit(state.owner.body, node => {
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
    const effectCall = [...directEffectCalls].find(effect => nodeWithin(node, effect));
    if (!effectCall) {
      safe = false;
      return;
    }
    const directCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
    if (directCall) {
      invokedByEffect = true;
      return;
    }
    const memberCall = ts.isPropertyAccessExpression(node.parent) &&
      node.parent.expression === node &&
      ts.isCallExpression(node.parent.parent) &&
      node.parent.parent.expression === node.parent;
    const dependencies = effectCall.arguments[1];
    if (memberCall || (dependencies !== undefined && nodeWithin(node, dependencies))) return;
    safe = false;
  });
  return safe && invokedByEffect;
}

function isEffectOwnedSelfRefreshingCommandState(
  state: StateCandidate,
  usage: StateUsage,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
  imports: HookImports
): boolean {
  const setterCall = usage.setterCallNodes[0];
  if (
    !state.owner.body ||
    !setterCall ||
    usage.setterCallNodes.length !== 1 ||
    usage.setterReferences !== 1 ||
    usage.effectWrites !== 0 ||
    usage.setterUsesPreviousValue ||
    usage.localRenderReads !== 0 ||
    usage.transportedOccurrences !== 0
  ) {
    return false;
  }

  const memoCall = findAncestorUntil(
    setterCall,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      isImportedHookCall(
        node,
        imports.useCallback,
        imports.reactNamespaces,
        "useCallback"
      ),
    state.owner
  );
  const factory = memoCall?.arguments[0];
  const declaration = memoCall
    ? findAncestorUntil(memoCall, ts.isVariableDeclaration, state.owner)
    : null;
  if (
    !memoCall ||
    !factory ||
    (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) ||
    !declaration?.initializer ||
    unwrapTransparentExpression(declaration.initializer) !== memoCall ||
    !ts.isIdentifier(declaration.name) ||
    bindingDeclarationCount(state.owner, declaration.name.text) !== 1 ||
    factory.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  ) {
    return false;
  }

  let bodyReads = 0;
  let dependencyReads = 0;
  let unsafe = false;
  const reads: ts.Identifier[] = [];
  visit(state.owner.body, node => {
    if (unsafe || ts.isAwaitExpression(node) || ts.isYieldExpression(node)) {
      if (nodeWithin(node, factory)) unsafe = true;
      return;
    }
    if (
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      node.parent === state.call.parent ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const dependencies = memoCall.arguments[1];
    if (dependencies && nodeWithin(node, dependencies)) {
      dependencyReads += 1;
      return;
    }
    if (nodeWithin(node, factory.body)) {
      bodyReads += 1;
      reads.push(node);
      return;
    }
    unsafe = true;
  });
  if (unsafe || bodyReads === 0 || dependencyReads === 0) return false;

  const writeSites = memoizedCommandWriteSites(setterCall, factory, state.owner);
  if (
    !writeSites ||
    writeSites.some(write =>
      reads.some(read =>
        write.getStart() < read.getStart() &&
        !writeIsFollowedByReturnBeforeRead(write, read, factory)
      )
    )
  ) {
    return false;
  }

  const binding = declaration.name.text;
  let invokedByEffect = false;
  visit(state.owner.body, node => {
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
    const effectCall = [...directEffectCalls].find(effect => nodeWithin(node, effect));
    if (!effectCall) {
      unsafe = true;
      return;
    }
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      invokedByEffect = true;
      return;
    }
    const dependencies = effectCall.arguments[1];
    if (!dependencies || !nodeWithin(node, dependencies)) unsafe = true;
  });
  return !unsafe && invokedByEffect;
}

function memoizedCommandWriteSites(
  setterCall: ts.CallExpression,
  factory: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike
): readonly ts.CallExpression[] | null {
  const region = nearestMutationFunction(setterCall, owner);
  if (region === factory) return [setterCall];
  if (
    !ts.isArrowFunction(region) &&
    !ts.isFunctionDeclaration(region) &&
    !ts.isFunctionExpression(region)
  ) {
    return null;
  }
  const name = localCallbackBindingName(region);
  if (!name || bindingDeclarationCount(factory, name) !== 1) return null;

  const calls: ts.CallExpression[] = [];
  let safe = true;
  visit(factory.body, node => {
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
  boundary: ts.Node
): boolean {
  for (let current: ts.Node | undefined = write.parent; current && current !== boundary; current = current.parent) {
    if (!ts.isBlock(current) || nodeWithin(read, current)) continue;
    const writeIndex = current.statements.findIndex(statement => nodeWithin(write, statement));
    if (
      writeIndex >= 0 &&
      current.statements.slice(writeIndex + 1).some(statement => ts.isReturnStatement(statement))
    ) {
      return true;
    }
  }
  return false;
}

function commonRepeatedRender(
  nodes: readonly ts.Node[],
  boundary: ts.Node
): ts.CallExpression | null {
  const calls = nodes.map(node => nearestRepeatedRenderCall(node, boundary));
  const first = calls[0];
  return first && calls.every(call => call === first) ? first : null;
}




function jsxSubtreeLabel(node: JsxSubtreeNode): string {
  if (ts.isJsxFragment(node)) return "fragment";
  return ts.isJsxElement(node) ? `<${node.openingElement.tagName.getText()}>` : `<${node.tagName.getText()}>`;
}

function findingFor(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  fileName: string,
  hook: "useEffect" | "useState",
  name: string | null,
  classification: ClassifiedState | ClassifiedEffect,
  evidence: readonly string[] = []
): HookFinding {
  const position = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
  return {
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
    ...(hook === "useState" ? { stateModel: stateModelFor(classification.action as StateAction) } : {}),
  };
}

function dispositionFor(action: HookFinding["action"]): HookFinding["disposition"] {
  if (action === "keep-effect" || action === "keep-state") return "keep";
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
  sourceFile: ts.SourceFile
): boolean {
  return (
    ownerLineSpan(state.owner, sourceFile) >= 150 &&
    jsxElementCount(state.owner) >= 12 &&
    usage.localRenderReads === 0 &&
    usage.transportedOccurrences > 0
  );
}

function legendCandidateMessage(
  state: StateCandidate,
  usage: StateUsage,
  sourceComponents: ReadonlySet<string> = new Set()
): string {
  const targets = [...usage.jsxTargets].sort().join(", ") || "the receiving descendants";
  const resolved = [...usage.jsxTargets].filter(target => sourceComponents.has(target));
  const proof = resolved.length > 0
    ? ` Source declarations resolved for ${resolved.sort().join(", ")}, but their prop contracts and mount identity still need verification.`
    : "";
  return `Legend-first restructuring candidate: keep \`${state.valueName}\` in a stable observable owner and subscribe only inside ${targets}; verify the child contract before changing it.${proof}`;
}

function stateModelFor(action: StateAction): NonNullable<HookFinding["stateModel"]> {
  switch (action) {
    case "keep-state":
      return { ownership: "react", subscription: "owner-react" };
    case "move-state-down":
      return { ownership: "react", subscription: "leaf-react" };
    case "use-observable":
      return { ownership: "local-observable", subscription: "leaf-use-value" };
    case "use-value":
      return { ownership: "existing-observable", subscription: "owner-use-value" };
    case "delete-derived-state":
    case "delete-unused-state":
      return { ownership: "delete", subscription: "none" };
    case "use-ref":
      return { ownership: "ref", subscription: "none" };
    case "review-state":
      return { ownership: "review", subscription: "review" };
  }
}

function stateEvidence(
  state: StateCandidate,
  usage: StateUsage,
  sourceFile: ts.SourceFile
): readonly string[] {
  return [
    `${ownerEvidence(state.owner, sourceFile)}, JSX elements ${jsxElementCount(state.owner)}`,
    `reads: render ${usage.localRenderReads}, effects ${usage.effectReads}, deferred ${usage.deferredReads}, transported ${usage.transportedOccurrences}`,
    `writes: setter calls ${usage.setterCalls}, effect writes ${usage.effectWrites}`,
    `transport targets: ${[...usage.jsxTargets].sort().join(", ") || "none"}`,
  ];
}

function effectEvidence(
  effect: EffectCandidate,
  sourceFile: ts.SourceFile,
  stateBySetter: ReadonlyMap<string, StateCandidate>
): readonly string[] {
  const evidence = [effect.owner ? ownerEvidence(effect.owner, sourceFile) : "owner: unresolved"];
  evidence.push(`dependencies: ${effect.dependencies?.elements.length ?? "unresolved"}`);
  evidence.push(`cleanup: ${effect.callback ? callbackHasCleanup(effect.callback, stateBySetter) : "unresolved"}`);
  return evidence;
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
  if (owner.name && ts.isIdentifier(owner.name)) return owner.name.text;
  const parent = owner.parent;
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : null;
}

function isCustomHookOwner(owner: RuntimeFunctionLike): boolean {
  const name = runtimeFunctionName(owner);
  return name !== null && /^use[A-Z0-9]/.test(name);
}

function isEffectOwnedReturnedKeyedCursor(
  state: StateCandidate,
  usage: StateUsage,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
  childContracts: ChildContractResolver
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
  return !!state.setterName && childContracts.hookStateHasKeyedRowConsumer(
    hookName,
    state.valueName,
    state.setterName
  );
}

function hasNumericStateInitializer(state: StateCandidate): boolean {
  const initializer = state.call.arguments[0];
  if (!initializer) return false;
  const value = unwrapTransparentExpression(initializer);
  return ts.isNumericLiteral(value) ||
    (ts.isPrefixUnaryExpression(value) &&
      value.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(value.operand));
}

function returnsStateAndSetter(state: StateCandidate): boolean {
  if (!state.owner.body || !state.setterName) return false;
  let returns = 0;
  let matched = false;
  visitSkippingNestedRuntimeFunctions(state.owner.body, node => {
    if (!ts.isReturnStatement(node) || !node.expression) return;
    returns += 1;
    const value = unwrapTransparentExpression(node.expression);
    if (!ts.isObjectLiteralExpression(value)) return;
    const names = new Set(value.properties.flatMap(property => {
      if (ts.isShorthandPropertyAssignment(property)) return [property.name.text];
      if (!ts.isPropertyAssignment(property)) return [];
      const initializer = unwrapTransparentExpression(property.initializer);
      return ts.isIdentifier(property.name) &&
        ts.isIdentifier(initializer) &&
        property.name.text === initializer.text
        ? [initializer.text]
        : [];
    }));
    matched = names.has(state.valueName) && names.has(state.setterName!);
  });
  return returns === 1 && matched;
}

function effectCursorReadsAreDeferred(
  state: StateCandidate,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
  childContracts: ChildContractResolver
): boolean {
  if (!state.owner.body) return false;
  const nestedReadEffects = new Set<ts.CallExpression>();
  let safe = true;
  visit(state.owner.body, node => {
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
    const returned = findAncestorUntil(node, ts.isReturnStatement, state.owner);
    if (returned && returned.expression && ts.isObjectLiteralExpression(unwrapTransparentExpression(returned.expression))) {
      return;
    }
    const effect = ancestorCallInSet(node, directEffectCalls, state.owner);
    if (!effect) {
      safe = false;
      return;
    }
    const dependencies = effect.arguments[1];
    if (dependencies && nodeWithin(node, dependencies)) return;
    const callback = effect.arguments[0];
    const nested = nearestNestedFunction(node, state.owner);
    if (
      !callback ||
      (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
      !nested ||
      nested === callback ||
      (!ts.isArrowFunction(nested) && !ts.isFunctionExpression(nested)) ||
      !registeredCallbackHasEffectCleanup(nested, callback, childContracts)
    ) {
      safe = false;
      return;
    }
    nestedReadEffects.add(effect);
  });
  return safe && nestedReadEffects.size > 0 && [...nestedReadEffects].every(effect => {
    const callback = effect.arguments[0];
    const dependencies = effect.arguments[1];
    return !!callback &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      callbackHasCleanup(callback, EMPTY_STATE_CANDIDATES) &&
      !!dependencies &&
      ts.isArrayLiteralExpression(dependencies) &&
      dependencies.elements.some(element => {
        const value = unwrapTransparentExpression(element);
        return ts.isIdentifier(value) && value.text === state.valueName;
      });
  });
}

function registeredCallbackHasEffectCleanup(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  effect: ts.ArrowFunction | ts.FunctionExpression,
  childContracts: ChildContractResolver
): boolean {
  const call = callback.parent;
  const owner = findAncestor(effect, isRuntimeFunctionLike);
  if (
    !owner ||
    !ts.isCallExpression(call) ||
    !call.arguments.includes(callback) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    !ts.isIdentifier(call.expression.expression) ||
    bindingDeclarationCount(owner, call.expression.expression.text) > 0 ||
    !childContracts.callbackRegistrationIsDeferred(
      call.expression.expression.text,
      call.expression.name.text,
      call.arguments.indexOf(callback)
    )
  ) {
    return false;
  }
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
    return false;
  }
  const disposerName = declaration.name.text;
  const references: ts.Identifier[] = [];
  visit(effect.body, node => {
    if (
      ts.isIdentifier(node) &&
      node.text === disposerName &&
      node !== declaration.name &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references.length > 0 && references.every(reference => {
    const returned = findAncestorUntil(reference, ts.isReturnStatement, effect);
    if (!returned?.expression) return false;
    const cleanup = unwrapTransparentExpression(returned.expression);
    if (cleanup === reference) return true;
    if (!ts.isArrowFunction(cleanup) && !ts.isFunctionExpression(cleanup)) return false;
    return ts.isCallExpression(reference.parent) &&
      reference.parent.expression === reference &&
      nearestNestedFunction(reference, effect) === cleanup;
  });
}

function ancestorCallInSet(
  node: ts.Node,
  calls: ReadonlySet<ts.CallExpression>,
  boundary: ts.Node
): ts.CallExpression | null {
  for (let current: ts.Node | undefined = node.parent; current && current !== boundary; current = current.parent) {
    if (ts.isCallExpression(current) && calls.has(current)) return current;
  }
  return null;
}

function jsxTargetName(attribute: ts.JsxAttribute): string | null {
  const properties = attribute.parent;
  const opening = properties.parent;
  if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) return null;
  return opening.tagName.getText();
}


function isCustomJsxTarget(name: string): boolean {
  const first = name[0];
  return first !== undefined && (first === first.toUpperCase() || name.includes("."));
}

function jsxTransportSite(attribute: ts.JsxAttribute): number {
  return attribute.parent.parent.getStart();
}

function isInsideJsxCallback(node: ts.Node, boundary: RuntimeFunctionLike): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== boundary; current = current.parent) {
    if (!isRuntimeFunctionLike(current)) continue;
    const attribute = findAncestorUntil(current, ts.isJsxAttribute, boundary);
    if (attribute && isInsideJsxAttribute(current, attribute)) return true;
  }
  return false;
}


function hasUnstableJsxLifetime(node: ts.Node, boundary: ts.Node): boolean {
  const opening = node.parent.parent;
  if (
    (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) &&
    opening.attributes.properties.some(
      property => ts.isJsxAttribute(property) && property.name.getText() === "key"
    )
  ) {
    return true;
  }
  for (let current: ts.Node | undefined = opening.parent; current && current !== boundary; current = current.parent) {
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
  const parent = node.parent;
  return ts.isCallExpression(parent) && parent.expression !== node && parent.arguments.includes(node);
}

function isOriginalStateBinding(node: ts.Identifier, call: ts.CallExpression): boolean {
  const declaration = call.parent;
  return ts.isVariableDeclaration(declaration) && declaration.name.getStart() <= node.getStart() && node.end <= declaration.name.end;
}


function hasAncestorInSet(node: ts.Node, ancestors: ReadonlySet<ts.Node>): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ancestors.has(current)) return true;
  }
  return false;
}

function isInsideImportedCallback(node: ts.Node, hookNames: ReadonlySet<string>): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      hookNames.has(current.expression.text) &&
      current.arguments.some(argument => argument.getStart() <= node.getStart() && node.end <= argument.end)
    ) {
      return true;
    }
  }
  return false;
}


function collectLocalComponents(sourceFile: ts.SourceFile, imports: HookImports): ReadonlySet<string> {
  const names = new Set<string>();
  visit(sourceFile, node => {
    if (ts.isFunctionDeclaration(node) && node.name && isComponentName(node.name.text)) {
      names.add(node.name.text);
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isComponentName(node.name.text) &&
      node.initializer &&
      (
        ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer) ||
        isImportedReactLazyCall(node.initializer, imports)
      )
    ) {
      names.add(node.name.text);
    }
  });
  return names;
}

function isImportedReactLazyCall(node: ts.Expression, imports: HookImports): boolean {
  const value = unwrapTransparentExpression(node);
  if (!ts.isCallExpression(value)) return false;
  if (ts.isIdentifier(value.expression)) return imports.lazy.has(value.expression.text);
  return ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === "lazy" &&
    ts.isIdentifier(value.expression.expression) &&
    imports.reactNamespaces.has(value.expression.expression.text);
}

function collectPureProjectionImports(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "clsx" ||
      statement.importClause?.isTypeOnly
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) names.add(clause.name.text);
    if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
    for (const specifier of clause.namedBindings.elements) {
      if (
        !specifier.isTypeOnly &&
        (specifier.propertyName?.text ?? specifier.name.text) === "clsx"
      ) {
        names.add(specifier.name.text);
      }
    }
  }
  return names;
}

function ownerDeclaresBinding(owner: RuntimeFunctionLike, name: string): boolean {
  let declared = false;
  visit(owner, node => {
    if (
      node !== owner &&
      ts.isIdentifier(node) &&
      node.text === name &&
      isDeclarationName(node)
    ) {
      declared = true;
    }
  });
  return declared;
}

function isComponentName(name: string): boolean {
  const first = name[0];
  return first !== undefined && first === first.toUpperCase();
}

function stableOwnerLevelCallSite(
  usage: StateUsage,
  owner: RuntimeFunctionLike
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const valueSite = [...usage.valueTransportSites][0];
  if (valueSite === undefined || !owner.body) return null;
  const openings: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
  visit(owner.body, node => {
    if (
      openings.length === 0 &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.getStart() === valueSite
    ) {
      openings.push(node);
    }
  });
  const opening = openings[0];
  if (!opening) return null;
  for (
    let current: ts.Node | undefined = opening.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (isRuntimeFunctionLike(current)) return null;
  }
  return opening;
}

function callSiteIsKeyed(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement | null
): boolean {
  if (!opening) return true;
  return opening.attributes.properties.some(
    property => ts.isJsxAttribute(property) && property.name.getText() === "key"
  );
}
