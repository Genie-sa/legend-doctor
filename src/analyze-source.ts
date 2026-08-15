import path from "node:path";

import ts from "typescript";

import {
  bindingDeclarationCount,
  collectBindingNames,
  containsCallExpression,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isInsideJsxAttribute,
  isNonValueIdentifier,
  isPureExpression,
  unwrapTransparentExpression,
} from "./analysis-ast.js";
import {
  findAncestor,
  findAncestorUntil,
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
import { findAsyncLeafStatuses } from "./rules/async-leaf-status.js";
import {
  commonRenderGateSubtree,
  findDeferredRevealStates,
  hasStateInitializer,
  isRenderGateReference,
  jsxSubtreeAncestors,
  type JsxSubtreeNode,
} from "./rules/deferred-reveal.js";
import {
  findEffectSynchronizedDrafts,
  mutationRegionOnlyCallsStateSetters,
  type EffectDraftProofs,
} from "./rules/effect-drafts.js";
import { callbackHasCleanup, classifyEffect } from "./rules/effects.js";
import {
  analyzeKeyedSelections,
  isSelectionStateName,
  isSetOrMapState,
  setterCallUsesPreviousValue,
} from "./rules/keyed-selection.js";
import { isLiteralBooleanLeafState } from "./rules/literal-boolean-leaf.js";
import {
  findLazyCallbackLeaf,
  type LazyCallbackLeafProofs,
} from "./rules/lazy-callback-leaf.js";
import {
  callbackIsEventRooted,
  expressionDependsOnBinding,
  hasDirectPrimitiveInitializer,
  hasIndependentRenderCutWitness,
  hasOnlyEventCommandReads,
  isDirectPrimitiveExpression,
  isHookDependencyReference,
  isInsideJsxEventCallback,
  isJsxNode,
  isSafeJsxProjectionReference,
  isSynchronousRenderCallback,
  jsxElementCount,
  jsxElementCountIn,
  lowestCommonJsxSubtree,
  nearestRepeatedRenderCall,
  oneHopRenderProjectionReferences,
  repeatedRenderHasStableItemKey,
  stateMayHoldCallable,
} from "./rules/state-proofs.js";
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

const EFFECT_DRAFT_PROOFS: EffectDraftProofs = {
  directUniqueReturnCallSite,
  hasIndependentRenderCutWitness,
  isCustomHookOwner,
  nearestMutationFunction,
  setterMutationsCanCooccur: (left, right, region) =>
    branchesAreCompatible(mutationBranches(left, region), mutationBranches(right, region)),
  uniqueReturnedExpression,
};

const LAZY_CALLBACK_LEAF_PROOFS: LazyCallbackLeafProofs = {
  hasUnstableSubtreeLifetime,
  uniqueReturnedExpression,
};

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
  const imports = collectHookImports(sourceFile);
  const localComponents = collectLocalComponents(sourceFile);
  const states: StateCandidate[] = [];
  const unmatchedStateCalls: ts.CallExpression[] = [];
  const effects: EffectCandidate[] = [];
  const useValueBindingsByOwner = collectUseValueBindings(sourceFile, imports);
  const useObservableBindingsByOwner = collectStableUseObservableBindings(sourceFile, imports);
  const moduleScopeBindings = collectModuleScopeBindings(sourceFile);
  const reactiveMutationsByOwner = collectReactiveMutationBindings(sourceFile);

  visit(sourceFile, node => {
    if (!ts.isCallExpression(node)) return;
    if (isImportedHookCall(node, imports.useState, imports.reactNamespaces, "useState")) {
      const state = stateCandidate(node);
      if (state) states.push(state);
      else unmatchedStateCalls.push(node);
      return;
    }
    if (isImportedHookCall(node, imports.useEffect, imports.reactNamespaces, "useEffect")) {
      effects.push(effectCandidate(node));
    }
  });

  const effectNodes = new Set(effects.map(effect => effect.call));
  const usageByState = new Map(states.map(state => [state, collectStateUsage(state, effectNodes, imports)]));
  const subtreeByState = new Map<StateCandidate, StateSubtree>();
  const safeCommandStates = new Set<StateCandidate>();
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
    const projectionAllowed = !reactiveMutationPaths.all &&
      !setterCallbackEscapesThroughUnknownHook(state, usage) &&
      primitiveSetterUpdatersArePure(state, usage);
    if (projectionAllowed) safeCommandStates.add(state);
    const subtree = analyzeStateSubtree(state, usage, projectionAllowed);
    if (subtree) subtreeByState.set(state, subtree);
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
  const statesWithCompanionWrites = findStatesWithCompanionWrites(states);
  const independentStateWrites = findIndependentStateWrites(states);
  const asyncLeafStatuses = findAsyncLeafStatuses(
    states,
    usageByState,
    safeCommandStates,
    localComponents,
    sourceComponents
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
    const cut = siblingProducerConsumerCut(state, usage, effectNodes);
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
    EFFECT_DRAFT_PROOFS
  );
  const keyedSelections = analyzeKeyedSelections(
    states,
    usageByState,
    safeCommandStates,
    statesWithCompanionWrites
  );
  const observableClusters = findObservableStateClusters(
    states,
    usageByState,
    new Set([...localComponents, ...sourceComponents]),
    sourceFile
  );
  const subtreeClusters = findStateSubtreeClusters(
    subtreeByState,
    statesWithCompanionWrites
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
      moduleScopeBindings
    );
    effectClassifications.set(effect, classification);
    if (classification.derivedState) derivedStates.add(classification.derivedState);
  }

  const findings: HookFinding[] = [];
  for (const state of states) {
    const usage = usageByState.get(state);
    if (!usage) continue;
    const cluster = effectDrafts.clusters.get(state) ?? observableClusters.get(state) ?? subtreeClusters.get(state);
    const siblingCut = siblingRenderCuts.get(state);
    const classification = cluster
      ? {
          action: cluster.action,
          confidence: "probable" as const,
          message: cluster.message,
        }
      : effectDrafts.singletons.has(state)
      ? {
          action: "use-observable" as const,
          confidence: "probable" as const,
          message: siblingCut
            ? `Replace effect-synchronized React draft \`${state.valueName}\` with one component-lifetime observable; preserve the React synchronization effect and its dependencies, keep producer commands non-tracking, subscribe only in the sibling ${siblingCut.consumerLabel} boundary at line ${siblingCut.consumerLine}, and pass state-independent fallback inputs as ordinary snapshots.`
            : `Replace effect-synchronized React draft \`${state.valueName}\` with one component-lifetime observable; preserve the React synchronization effect and its dependencies, mutate from edit commands, snapshot once at command entry before deferred work, and subscribe only in rendered leaves.`,
        }
      : derivedStates.has(state)
      ? {
          action: "delete-derived-state" as const,
          confidence: "certain" as const,
          message: `Delete React state \`${state.valueName}\`; it is assigned only by a derivation effect and should be calculated directly.`,
        }
      : classifyState(
          state,
          usage,
          localComponents,
          sourceComponents,
          sourceFile,
          subtreeByState.get(state) ?? null,
          safeCommandStates.has(state),
          observableSelectionOwners.has(state.owner),
          statesWithCompanionWrites.has(state),
          independentStateWrites.directEventWrites.has(state),
          independentStateWrites.visibilitySetterTransports.has(state),
          reactiveMutationAffectedStates.has(state),
          asyncLeafStatuses.isolated.has(state),
          asyncLeafStatuses.cohesive.has(state),
          deferredRevealStates.has(state),
          keyedSelections.collectionStates.has(state),
          keyedSelections.scalarStates.has(state),
          keyedSelections.secondaryLeafStates.has(state),
          siblingCut ?? null
        );
    const finding = findingFor(
      state.call,
      sourceFile,
      fileName,
      "useState",
      state.valueName,
      classification,
      stateEvidence(state, usage, sourceFile)
    );
    if (cluster) {
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
    const classification = effectDrafts.effects.has(effect)
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

function effectCandidate(call: ts.CallExpression): EffectCandidate {
  const callbackArg = call.arguments[0];
  const dependenciesArg = call.arguments[1];
  return {
    call,
    callback:
      callbackArg && (ts.isArrowFunction(callbackArg) || ts.isFunctionExpression(callbackArg)) ? callbackArg : null,
    dependencies: dependenciesArg && ts.isArrayLiteralExpression(dependenciesArg) ? dependenciesArg : null,
    owner: findAncestor(call, isRuntimeFunctionLike),
  };
}

const EMPTY_BINDINGS: ReadonlySet<string> = new Set();
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

  visit(state.owner.body, node => {
    if (!ts.isIdentifier(node)) return;
    if (isNonValueIdentifier(node)) return;
    if (isDeclarationName(node)) {
      if (node.text === state.valueName || (state.setterName !== null && node.text === state.setterName)) {
        if (!isOriginalStateBinding(node, state.call)) usage.shadowed = true;
      }
      return;
    }

    if (state.setterName !== null && node.text === state.setterName) {
      classifySetterReference(node, state, effectNodes, imports, usage);
      return;
    }
    if (node.text === state.valueName) {
      classifyValueReference(node, state, effectNodes, imports, usage);
    }
  });

  const renderCallableSites = localCallableRenderSites(state);
  if (renderCallableSites.length > 0) {
    usage.localRenderReads += renderCallableSites.length;
    usage.directRenderNodes.push(...renderCallableSites);
  }

  return usage;
}

function localCallableRenderSites(state: StateCandidate): readonly ts.Identifier[] {
  const callableNames = new Set<string>();
  visit(state.owner.body, node => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.body &&
      functionReadsState(node, state) &&
      bindingDeclarationCount(state.owner, node.name.text) === 1
    ) {
      callableNames.add(node.name.text);
      return;
    }
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
    const callback = localCallableCallback(node.initializer);
    if (!callback || !functionReadsState(callback, state)) return;
    if (bindingDeclarationCount(state.owner, node.name.text) !== 1) return;
    callableNames.add(node.name.text);
  });
  if (callableNames.size === 0) return [];

  const sites: ts.Identifier[] = [];
  visit(state.owner.body, node => {
    if (
      ts.isIdentifier(node) &&
      callableNames.has(node.text) &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression === node &&
      (() => {
        if (isInsideJsxEventCallback(node, state.owner)) return false;
        const callback = nearestNestedFunction(node, state.owner);
        return findAncestorUntil(node.parent, isJsxNode, state.owner) !== null ||
          callback === null ||
          isSynchronousRenderCallback(callback);
      })()
    ) {
      sites.push(node);
    }
  });
  return sites;
}

function localCallableCallback(
  initializer: ts.Expression
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
  if (
    ts.isCallExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === "useCallback"
  ) {
    const callback = initializer.arguments[0];
    return callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback : null;
  }
  return null;
}

function functionReadsState(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  state: StateCandidate
): boolean {
  let reads = false;
  if (!callback.body) return false;
  visitSkippingNestedFunctions(callback.body, callback, node => {
    if (
      ts.isIdentifier(node) &&
      node.text === state.valueName &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      reads = true;
    }
  });
  return reads;
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
  sourceFile: ts.SourceFile
): ReadonlyMap<StateCandidate, StateCluster> {
  const result = new Map<StateCandidate, StateCluster>();
  const statesByOwner = new Map<RuntimeFunctionLike, StateCandidate[]>();
  for (const state of states) {
    const ownerStates = statesByOwner.get(state.owner) ?? [];
    ownerStates.push(state);
    statesByOwner.set(state.owner, ownerStates);
  }

  for (const [owner, ownerStates] of statesByOwner) {
    if (ownerLineSpan(owner, sourceFile) < 100 || jsxElementCount(owner) < 12) continue;
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
        branches: mutationBranches(node, owner),
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
        if (left.region !== right.region || !branchesAreCompatible(left.branches, right.branches)) continue;
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
      const clusterMembers = normalizeObservableDialogClusterMembers(
        members,
        usageByState,
        knownComponents,
        calls
      );
      if (!clusterMembers) continue;
      if (
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
        message: `Replace the co-written React state cluster (${names.map(name => `\`${name}\``).join(", ")}) with one component-lifetime observable dialog model; mutate it from commands and subscribe with \`useValue\` only inside ${[...targets].sort().join(", ")}.`,
        primary,
      };
      for (const member of sortedMembers) result.set(member, cluster);
    }
  }

  return result;
}

function findStatesWithCompanionWrites(
  states: readonly StateCandidate[]
): ReadonlySet<StateCandidate> {
  const result = new Set<StateCandidate>();
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
      mutations.push({ branches: mutationBranches(node, region), call: node, region, state });
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
          !branchesAreCompatible(left.branches, right.branches)
        ) {
          continue;
        }
        result.add(left.state);
        result.add(right.state);
      }
    }
  }

  return result;
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
  branches: ReadonlyMap<number, string>;
  call: ts.CallExpression;
  region: RuntimeFunctionLike;
  state: StateCandidate;
}

function normalizeObservableDialogClusterMembers(
  members: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  knownComponents: ReadonlySet<string>,
  mutations: readonly SetterMutation[]
): readonly StateCandidate[] | null {
  if (members.length < 2) return null;
  const payloads = members.filter(state => hasStateInitializer(state, ts.SyntaxKind.NullKeyword));
  const flags = members.filter(state => hasStateInitializer(state, ts.SyntaxKind.FalseKeyword));
  if (payloads.length !== 1 || flags.length < 1 || payloads.length + flags.length !== members.length) {
    return null;
  }

  const payload = payloads[0];
  if (!payload) return null;
  const payloadMutations = mutations.filter(mutation => mutation.state === payload);
  const payloadOpenMutations = payloadMutations.filter(mutation => !callSetsLiteral(mutation, ts.SyntaxKind.NullKeyword));
  if (payloadOpenMutations.length === 0) return null;

  const targetSets: ReadonlySet<string>[] = [];
  for (const member of members) {
    const usage = usageByState.get(member);
    if (
      !usage ||
      usage.shadowed ||
      usage.escaped ||
      usage.effectReads > 0 ||
      usage.effectWrites > 0 ||
      usage.setterUsesPreviousValue
    ) {
      return null;
    }
    const targets = new Set([...usage.jsxTargets].filter(target => knownComponents.has(target)));
    if (
      targets.size === 0 &&
      member !== payload
    ) {
      return null;
    }
    if (member === payload && targets.size === 0 && usage.localRenderReads === 0 && usage.deferredReads === 0) {
      return null;
    }
    targetSets.push(targets);
  }

  for (const flag of flags) {
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
          branchesAreCompatible(flagMutation.branches, payloadMutation.branches)
      )
    );
    if (!pairedOpen) return null;
  }
  if (!targetSets.some(targets => targets.size > 0)) return null;

  const ownerGuardedPayload = payloadControlsOwnerJsx(payload, knownComponents);
  if (ownerGuardedPayload) return null;
  return members;
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
      isPureExpression(argument);
  });
}




function nearestMutationFunction(node: ts.Node, owner: RuntimeFunctionLike): RuntimeFunctionLike {
  return findAncestorUntil(node, isRuntimeFunctionLike, owner) ?? owner;
}

function mutationBranches(node: ts.Node, boundary: RuntimeFunctionLike): ReadonlyMap<number, string> {
  const branches = new Map<number, string>();
  for (let current: ts.Node = node; current.parent && current !== boundary; current = current.parent) {
    const parent = current.parent;
    if (ts.isIfStatement(parent)) {
      if (current === parent.thenStatement) branches.set(parent.getStart(), "then");
      if (current === parent.elseStatement) branches.set(parent.getStart(), "else");
    } else if (ts.isConditionalExpression(parent)) {
      if (current === parent.whenTrue) branches.set(parent.getStart(), "true");
      if (current === parent.whenFalse) branches.set(parent.getStart(), "false");
    } else if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
      const switchStatement = parent.parent.parent;
      if (ts.isSwitchStatement(switchStatement)) {
        branches.set(switchStatement.getStart(), `${parent.kind}:${parent.getStart()}`);
      }
    }
  }
  return branches;
}

function branchesAreCompatible(
  left: ReadonlyMap<number, string>,
  right: ReadonlyMap<number, string>
): boolean {
  for (const [branch, leftValue] of left) {
    const rightValue = right.get(branch);
    if (rightValue !== undefined && rightValue !== leftValue) return false;
  }
  return true;
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

function classifyState(
  state: StateCandidate,
  usage: StateUsage,
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>,
  sourceFile: ts.SourceFile,
  subtree: StateSubtree | null,
  hasSafeCommands: boolean,
  belongsToObservableSelection: boolean,
  hasCompanionWrites: boolean,
  hasIndependentDirectEventWrite: boolean,
  hasIndependentVisibilitySetterTransport: boolean,
  hasReactiveMutationPath: boolean,
  isAsyncLeafStatus: boolean,
  isCohesiveAsyncStatus: boolean,
  isDeferredReveal: boolean,
  isKeyedLeafCollection: boolean,
  isKeyedLeafScalar: boolean,
  isKeyedScalarWithSecondary: boolean,
  siblingRenderCut: SiblingRenderCut | null
): ClassifiedState {
  if (isNonProductionHarness(sourceFile.fileName)) {
    return {
      action: "keep-state",
      confidence: "certain",
      message: `Keep \`${state.valueName}\` in this test, story, or demo harness; production render-boundary migrations do not apply here.`,
    };
  }
  if (state.setterName === null) {
    return {
      action: "keep-state",
      confidence: "certain",
      message: `Keep \`${state.valueName}\` as React state; it owns a stable component-lifetime value and has no setter.`,
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
      message: `Replace keyed collection state \`${state.valueName}\` with a component-lifetime observable collection; extract the repeated row and subscribe there with a per-row \`useValue\` membership selector, while summary controls subscribe separately and commands read without subscribing.`,
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
  if (siblingRenderCut && usage.effectWrites === 0) {
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace \`${state.valueName}\` with a component-lifetime observable; keep the producer sibling command-only and subscribe only in the sibling ${siblingRenderCut.consumerLabel} boundary at line ${siblingRenderCut.consumerLine}, passing state-independent projection inputs as ordinary snapshots.`,
    };
  }
  const unusedStateDeletionConfidence = setterCallsDiscardConfidence(usage.setterCallNodes);
  if (
    usage.setterCalls > 0 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.escaped &&
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences === 0 &&
    unusedStateDeletionConfidence !== null
  ) {
    return {
      action: "delete-unused-state",
      confidence: unusedStateDeletionConfidence,
      message: `Delete React state \`${state.valueName}\` and its setter calls; assigned values are never consumed.`,
    };
  }
  const directCallSite = directUniqueReturnCallSite(usage, state.owner);
  const branchCallSite = directBranchReturnCallSite(usage, state.owner);
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
    const target = [...usage.valueTargets][0] ?? "the pending control";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace async pending flag \`${state.valueName}\` with a component-lifetime observable and wrap the stable \`${target}\` call site in a leaf subscriber; preserve the event command's async completion boundary exactly, changing only the true/false writes so pending transitions do not invalidate independent owner content.`,
    };
  }
  if (isCohesiveAsyncStatus) {
    return {
      action: "keep-state",
      confidence: "certain",
      message: `Keep async pending flag \`${state.valueName}\` as React state; its exact status consumer is already the cohesive owner boundary, so an observable cannot narrow rendering.`,
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
    branchCallSite !== null &&
    !usage.repeatedValueTransport &&
    (!hasCompanionWrites ||
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
      message: `Replace \`${state.valueName}\` with a component-lifetime observable and extract one stable call-site leaf wrapper around \`${target}\` (never define it inline); subscribe there, pass the same prop snapshot, and adapt every command-only setter call or prop to mutate without subscribing.`,
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
      sourceComponents.has([...usage.valueTargets][0] ?? "")) &&
    branchCallSite !== null &&
    (directCallSite === null || usage.unstableTransport) &&
    !usage.repeatedValueTransport &&
    !hasCompanionWrites &&
    hasSafeCommands &&
    hasDirectPrimitiveInitializer(state) &&
    !stateMayHoldCallable(state) &&
    setterOwnedByValueTransitionCallSite(state, usage) &&
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
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads > 0 &&
    usage.transportedOccurrences > 0 &&
    !usage.repeatedTransport &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped &&
    (!hasCompanionWrites || hasIndependentDirectEventWrite) &&
    hasSafeCommands &&
    hasOnlyEventCommandReads(state) &&
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
  const controlledProjectionCut = !isCustomHookOwner(state.owner) &&
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
    hasOnlyEventCommandReads(state, new Set(usage.directRenderNodes))
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
    const selector = projectionSubtree.repeated ? " with a per-item selector" : "";
    return {
      action: "use-observable",
      confidence: "probable",
      message: usage.transportedOccurrences > 0
        ? `Replace \`${state.valueName}\` with a component-lifetime observable and wrap the ${projectionSubtree.label} call site at line ${projectionSubtree.line} in a leaf subscriber${selector}; subscribe to the raw value once, pass that snapshot unchanged, derive every existing projection from the same snapshot, and leave the child API unchanged.`
        : `Replace \`${state.valueName}\` with a component-lifetime observable and wrap the ${projectionSubtree.label} call site at line ${projectionSubtree.line} in a leaf subscriber${selector}; evaluate its existing boolean, equality, or property projections inside that wrapper and leave the child API unchanged.`,
    };
  }
  if (
    ownerLineSpan(state.owner, sourceFile) >= 150 &&
    jsxElementCount(state.owner) >= 12 &&
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences > 0 &&
    usage.valueTargets.size === 1 &&
    localComponents.has([...usage.valueTargets][0] ?? "") &&
    usage.setterReferences > 0 &&
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
  if (usage.localRenderReads > 0) {
    if (isCustomHookOwner(state.owner) || jsxElementCount(state.owner) >= 5) {
      const boundary = isCustomHookOwner(state.owner)
        ? "its unknown hook consumers"
        : `this owner with ${jsxElementCount(state.owner)} JSX elements`;
      return {
        action: "review-state",
        confidence: "probable",
        message: `Legend-first restructuring candidate: replace \`${state.valueName}\` with observable ownership and move its subscription into the smallest rendered subtree; updates currently invalidate ${boundary}.`,
      };
    }
    return {
      action: "keep-state",
      confidence: "certain",
      message: `Keep \`${state.valueName}\` as React state for now; its owner is already a small render boundary.`,
    };
  }
  if (usage.repeatedTransport && usage.deferredReads === 0 && usage.setterCalls === 0) {
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
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.deferredReads > 0 &&
    usage.transportedOccurrences === 0 &&
    usage.jsxTargets.size === 0 &&
    (usage.eventReads === 0 || hasOnlyEventCommandReads(state))
  ) {
    return {
      action: "use-ref",
      confidence: "probable",
      message: `Replace \`${state.valueName}\` with a ref or observable handle; it is read only by deferred commands and does not render UI.`,
    };
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
  if (!call || call.arguments.some(argument => containsCallExpression(argument))) return false;
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

function isControlledInteractionProp(name: string): boolean {
  return /^(?:onChange|onChangeText|onCheckedChange|onSelect|onToggle|onValueChange)$/.test(name);
}

function isValueTransitionProp(name: string): boolean {
  return isControlledInteractionProp(name) ||
    /^on(?:Change|Select|Toggle|Update)[A-Z][A-Za-z0-9]*$/.test(name) ||
    /^on[A-Z][A-Za-z0-9]*(?:Change|Select|Toggle|Update)$/.test(name);
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

function discardableExpressionConfidence(
  node: ts.Expression
): "certain" | "probable" | null {
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return "certain";
  }
  if (ts.isPropertyAccessExpression(node)) {
    return discardableExpressionConfidence(node.expression) ? "probable" : null;
  }
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
    return discardableExpressionConfidence(node.expression);
  }
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
    return discardableExpressionConfidence(node.expression);
  }
  if (ts.isPrefixUnaryExpression(node)) {
    if (
      node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken
    ) {
      return null;
    }
    return discardableExpressionConfidence(node.operand);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return combineDiscardConfidence(
      node.elements.map(element =>
        ts.isSpreadElement(element) ? null : discardableExpressionConfidence(element)
      )
    );
  }
  if (ts.isObjectLiteralExpression(node)) {
    return combineDiscardConfidence(
      node.properties.map(property => {
        if (ts.isShorthandPropertyAssignment(property)) return "certain";
        return ts.isPropertyAssignment(property)
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
  kind: "direct" | "gate" | "projection";
  label: string;
  line: number;
  node: JsxSubtreeNode;
  repeated: boolean;
  unstable: boolean;
}

function analyzeStateSubtree(
  state: StateCandidate,
  usage: StateUsage,
  projectionAllowed: boolean
): StateSubtree | null {
  const ownerJsx = jsxElementCount(state.owner);
  if (
    ownerJsx < 12 ||
    usage.directRenderNodes.length === 0 ||
    usage.localRenderReads !== usage.directRenderNodes.length ||
    usage.setterCallNodes.length === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.effectReads > 0 ||
    usage.effectWrites > 0 ||
    (usage.deferredReads > 0 && !hasOnlyEventCommandReads(state)) ||
    usage.shadowed ||
    usage.escaped
  ) {
    return null;
  }

  const projectionNodes = oneHopRenderProjectionReferences(state.owner, usage.directRenderNodes) ??
    usage.directRenderNodes;
  const renderReadsInNestedCallbacks = projectionNodes.some(
    node => nearestNestedFunction(node, state.owner) !== null
  );
  if (
    usage.transportedOccurrences === 0 &&
    projectionAllowed &&
    !renderReadsInNestedCallbacks
  ) {
    const directNodes = [...usage.directRenderNodes, ...usage.setterCallNodes];
    const direct = lowestCommonJsxSubtree(directNodes, state.owner);
    if (direct) {
      const subtreeJsx = jsxElementCountIn(direct);
      if (subtreeJsx >= 2 && subtreeJsx / ownerJsx <= 0.4) {
        return stateSubtreeResult("direct", direct, directNodes, state);
      }
    }
  }

  const gateProjection = renderReadsInNestedCallbacks
    ? null
    : commonRenderGateSubtree(projectionNodes, state.owner);
  if (
    !projectionAllowed ||
    !(
      projectionNodes.every(node => isSafeJsxProjectionReference(node, state.owner)) ||
      gateProjection
    ) ||
    (renderReadsInNestedCallbacks &&
      !isKeyedRepeatedProjection(projectionNodes, state.owner))
  ) {
    return null;
  }
  const projection = gateProjection ?? lowestCommonJsxSubtree(projectionNodes, state.owner);
  if (
    !projection ||
    jsxElementCountIn(projection) / ownerJsx > 0.4 ||
    (usage.transportedOccurrences > 0 &&
      !isSafeMixedProjectionTransport(state, usage, projection))
  ) {
    return null;
  }
  return stateSubtreeResult(
    gateProjection ? "gate" : "projection",
    projection,
    projectionNodes,
    state
  );
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
  state: StateCandidate
): StateSubtree {
  return {
    kind,
    label: jsxSubtreeLabel(node),
    line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1,
    node,
    repeated: commonRepeatedRender(renderNodes, state.owner) !== null,
    unstable: hasUnstableSubtreeLifetime(node, state.owner),
  };
}

function isSafeMixedProjectionTransport(
  state: StateCandidate,
  usage: StateUsage,
  common: JsxSubtreeNode
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
    site !== common.getStart() ||
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

function hasUnstableSubtreeLifetime(node: JsxSubtreeNode, boundary: ts.Node): boolean {
  let renderReturns = 0;
  visitSkippingNestedRuntimeFunctions(boundary, current => {
    if (ts.isReturnStatement(current) && current.expression) renderReturns += 1;
  });
  if (renderReturns > 1) return true;
  for (let current: ts.Node | undefined = node; current && current !== boundary; current = current.parent) {
    if (
      (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) &&
      (ts.isJsxElement(current) ? current.openingElement : current).attributes.properties.some(
        property => ts.isJsxAttribute(property) && property.name.getText() === "key"
      )
    ) {
      return true;
    }
    if (
      ts.isConditionalExpression(current) ||
      ts.isIfStatement(current) ||
      ts.isSwitchStatement(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) ||
      (ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        ["map", "flatMap"].includes(current.expression.name.text))
    ) {
      return true;
    }
  }
  return false;
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


function collectLocalComponents(sourceFile: ts.SourceFile): ReadonlySet<string> {
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
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      names.add(node.name.text);
    }
  });
  return names;
}

function isComponentName(name: string): boolean {
  const first = name[0];
  return first !== undefined && first === first.toUpperCase();
}
