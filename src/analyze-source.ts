import path from "node:path";

import ts from "typescript";

import {
  findAncestor,
  findAncestorUntil,
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
import type { EffectAction, HookFinding, StateAction } from "./types.js";

interface StateCandidate {
  call: ts.CallExpression;
  owner: RuntimeFunctionLike;
  setterName: string | null;
  valueName: string;
}

interface EffectCandidate {
  call: ts.CallExpression;
  callback: ts.ArrowFunction | ts.FunctionExpression | null;
  dependencies: ts.ArrayLiteralExpression | null;
  owner: RuntimeFunctionLike | null;
}

interface StateUsage {
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

interface ClassifiedEffect {
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

interface EffectDraftAnalysis {
  clusters: ReadonlyMap<StateCandidate, StateCluster>;
  effects: ReadonlySet<EffectCandidate>;
  singletons: ReadonlySet<StateCandidate>;
}

interface SiblingRenderCut {
  consumerLabel: string;
  consumerLine: number;
}

interface ControlledProjectionCut {
  consumerLabel: string;
  consumerLine: number;
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
  for (const state of states) {
    const usage = usageByState.get(state);
    if (!usage) continue;
    const projectionAllowed = !allSetterPathsHaveReactiveMutation(
      state,
      usage,
      reactiveMutationsByOwner.get(state.owner) ?? EMPTY_BINDINGS
    ) &&
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
  const statesWithIndependentDirectEventWrites = findStatesWithIndependentDirectEventWrites(states);
  const asyncLeafStatuses = findAsyncLeafStatuses(states, usageByState, safeCommandStates);
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
    sourceComponents
  );
  const keyedLeafCollections = new Set(
    states.filter(state =>
      !statesWithCompanionWrites.has(state) &&
      safeCommandStates.has(state) &&
      isKeyedLeafCollectionState(state, usageByState.get(state))
    )
  );
  const keyedLeafScalars = new Set(
    states.filter(state => {
      const usage = usageByState.get(state);
      return safeCommandStates.has(state) &&
        (!statesWithCompanionWrites.has(state) || hasIndependentRepeatedEventWrite(state, usage)) &&
        isKeyedLeafScalarState(state, usage);
    })
  );
  const keyedScalarSecondaryLeaves = new Set(
    states.filter(state => {
      const usage = usageByState.get(state);
      return safeCommandStates.has(state) &&
        (!statesWithCompanionWrites.has(state) || hasIndependentRepeatedEventWrite(state, usage)) &&
        isKeyedScalarWithSecondaryLeaf(state, usage);
    })
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
          statesWithIndependentDirectEventWrites.has(state),
          asyncLeafStatuses.has(state),
          deferredRevealStates.has(state),
          keyedLeafCollections.has(state),
          keyedLeafScalars.has(state),
          keyedScalarSecondaryLeaves.has(state),
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
const EMPTY_NODES: ReadonlySet<ts.Node> = new Set();
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

function bindingDeclarationCount(owner: RuntimeFunctionLike, name: string): number {
  let count = 0;
  for (const parameter of owner.parameters) {
    if (bindingNameContains(parameter.name, name)) count += 1;
  }
  if (!owner.body) return count;
  visit(owner.body, node => {
    if (ts.isVariableDeclaration(node) && bindingNameContains(node.name, name)) count += 1;
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)) &&
      node.name?.text === name
    ) {
      count += 1;
    }
    if (isRuntimeFunctionLike(node) && node !== owner) {
      for (const parameter of node.parameters) {
        if (bindingNameContains(parameter.name, name)) count += 1;
      }
    }
  });
  return count;
}

function bindingNameContains(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(element =>
    !ts.isOmittedExpression(element) && bindingNameContains(element.name, name)
  );
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

function findEffectSynchronizedDrafts(
  effects: readonly EffectCandidate[],
  states: readonly StateCandidate[],
  scopes: ReadonlyMap<RuntimeFunctionLike, EffectStateScope>,
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  siblingRenderCuts: ReadonlyMap<StateCandidate, SiblingRenderCut>,
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>
): EffectDraftAnalysis {
  const clusters = new Map<StateCandidate, StateCluster>();
  const synchronizedEffects = new Set<EffectCandidate>();
  const singletons = new Set<StateCandidate>();

  for (const effect of effects) {
    if (
      !effect.owner ||
      !effect.callback ||
      !effect.dependencies ||
      effect.dependencies.elements.length === 0 ||
      isCustomHookOwner(effect.owner)
    ) {
      continue;
    }
    const scope = scopes.get(effect.owner);
    if (!scope) continue;
    const members = synchronousDraftSetters(effect.callback, scope.bySetter);
    if (!members || members.length === 0) continue;
    const ownerSetters = new Set(
      states.flatMap(state => state.owner === effect.owner && state.setterName ? [state.setterName] : [])
    );
    const editProofs = new Map(
      members.map(state => [state, draftEditProof(
        state,
        usageByState.get(state),
        effect,
        ownerSetters
      )] as const)
    );
    const complete = members.every(state => {
      const usage = usageByState.get(state);
      return !!usage &&
        stateIsWrittenOnlyByEffect(usage, effect, effects) &&
        usage.setterReferences > usage.effectWrites &&
        usage.effectReads === 0 &&
        !hasStaleUseCallbackCapture(state) &&
        usage.localRenderReads + usage.transportedOccurrences > 0 &&
        !usage.shadowed &&
        !usage.escaped &&
        !stateMayHoldCallable(state) &&
        editProofs.get(state)?.reachable === true &&
        !stateControlsHookOrRepeatedShape(state);
    });
    if (
      !complete ||
      !members.some(state => editProofs.get(state)?.independent) ||
      hasExternalCompanionWrites(effect.owner, members, states) ||
      !hasDraftRenderCut(
        effect.owner,
        members,
        usageByState,
        siblingRenderCuts,
        localComponents,
        sourceComponents
      )
    ) {
      continue;
    }

    synchronizedEffects.add(effect);
    const ordered = [...members].sort((left, right) => left.call.getStart() - right.call.getStart());
    if (ordered.length === 1) {
      singletons.add(ordered[0]!);
      continue;
    }
    const names = ordered.map(state => state.valueName);
    const cluster: StateCluster = {
      action: "use-observable",
      id: `state-cluster:effect-draft:${effect.owner.getStart()}:${effect.call.getStart()}`,
      members: ordered,
      message: `Replace the effect-synchronized React draft cluster (${names.map(name => `\`${name}\``).join(", ")}) with one component-lifetime observable model; preserve the React synchronization effect and its dependencies, assign the draft atomically there, mutate from edit commands, snapshot once at command entry before deferred work, and subscribe only in rendered leaves.`,
      primary: ordered[0]!,
    };
    for (const state of ordered) clusters.set(state, cluster);
  }
  return { clusters, effects: synchronizedEffects, singletons };
}

function draftEditProof(
  state: StateCandidate,
  usage: StateUsage | undefined,
  effect: EffectCandidate,
  ownerSetters: ReadonlySet<string>
): { independent: boolean; reachable: boolean } {
  if (!usage) return { independent: false, reachable: false };
  const direct = hasDirectJsxEventSetter(state);
  const edits = usage.setterCallNodes.filter(call => !nodeWithin(call, effect.call));
  const reachable = edits.filter(call => {
    const region = nearestMutationFunction(call, state.owner);
    return region !== state.owner &&
      (ts.isArrowFunction(region) || ts.isFunctionDeclaration(region) || ts.isFunctionExpression(region)) &&
      callbackIsEventRooted(region, state.owner, "", new Set());
  });
  const independent = direct || reachable.some(call => {
    const region = nearestMutationFunction(call, state.owner);
    return mutationRegionOnlyCallsStateSetters(region, ownerSetters) &&
      setterArgumentDiffersFromEffect(call, state, effect);
  });
  return { independent, reachable: direct || reachable.length > 0 };
}

function stateIsWrittenOnlyByEffect(
  usage: StateUsage,
  target: EffectCandidate,
  effects: readonly EffectCandidate[]
): boolean {
  const effectWrites = usage.setterCallNodes.filter(call =>
    effects.some(effect => nodeWithin(call, effect.call))
  );
  return effectWrites.length > 0 && effectWrites.every(call => nodeWithin(call, target.call));
}

function setterArgumentDiffersFromEffect(
  edit: ts.CallExpression,
  state: StateCandidate,
  effect: EffectCandidate
): boolean {
  const argument = edit.arguments[0];
  if (!argument || !state.setterName) return false;
  if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return true;
  const effectArguments: string[] = [];
  visitSkippingNestedFunctions(effect.callback!.body, effect.callback!, node => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === state.setterName &&
      node.arguments[0]
    ) {
      effectArguments.push(node.arguments[0].getText());
    }
  });
  return effectArguments.every(effectArgument => effectArgument !== argument.getText());
}

function hasDirectJsxEventSetter(state: StateCandidate): boolean {
  if (!state.setterName) return false;
  let found = false;
  visit(state.owner.body, node => {
    if (
      found ||
      !ts.isIdentifier(node) ||
      node.text !== state.setterName ||
      isDeclarationName(node)
    ) {
      return;
    }
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
    if (
      attribute &&
      /^(?:onChange|onChangeText|onSelect|onValueChange|onCheckedChange)$/.test(attribute.name.getText()) &&
      isDirectJsxAttributeExpression(attribute, node)
    ) {
      found = true;
    }
  });
  return found;
}

function mutationRegionOnlyCallsStateSetters(
  region: RuntimeFunctionLike,
  stateSetters: ReadonlySet<string>
): boolean {
  if (!region.body) return false;
  let sawSetter = false;
  let unsafeCall = false;
  visitSkippingNestedFunctions(region.body, region, node => {
    if (unsafeCall || !ts.isCallExpression(node)) return;
    if (ts.isIdentifier(node.expression) && stateSetters.has(node.expression.text)) {
      sawSetter = true;
      return;
    }
    unsafeCall = true;
  });
  return sawSetter && !unsafeCall;
}

function synchronousDraftSetters(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>
): readonly StateCandidate[] | null {
  if (!ts.isBlock(callback.body) || callbackHasCleanup(callback, stateBySetter)) return null;
  const members = new Set<StateCandidate>();
  const validStatement = (statement: ts.Statement): boolean => {
    if (ts.isBlock(statement)) return statement.statements.every(validStatement);
    if (ts.isIfStatement(statement)) {
      return validStatement(statement.thenStatement) &&
        (!statement.elseStatement || validStatement(statement.elseStatement));
    }
    if (ts.isReturnStatement(statement)) return statement.expression === undefined;
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
    const call = statement.expression;
    if (!ts.isIdentifier(call.expression)) return false;
    const state = stateBySetter.get(call.expression.text);
    const argument = call.arguments[0];
    if (
      !state ||
      call.arguments.length !== 1 ||
      !argument ||
      ts.isArrowFunction(argument) ||
      ts.isFunctionExpression(argument)
    ) {
      return false;
    }
    members.add(state);
    return true;
  };
  return callback.body.statements.every(validStatement) ? [...members] : null;
}

function stateControlsHookOrRepeatedShape(state: StateCandidate): boolean {
  let unsafe = false;
  visit(state.owner.body, node => {
    if (
      unsafe ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      node.parent === state.call.parent
    ) {
      return;
    }
    if (referenceControlsHookOrRepeatedShape(node, state.owner)) {
      unsafe = true;
      return;
    }
    const declaration = findAncestorUntil(node, ts.isVariableDeclaration, state.owner);
    if (
      !declaration?.initializer ||
      !ts.isIdentifier(declaration.name) ||
      !nodeWithin(node, declaration.initializer) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
      bindingDeclarationCount(state.owner, declaration.name.text) !== 1
    ) {
      return;
    }
    const aliasName = declaration.name.text;
    visit(state.owner.body, reference => {
      if (
        ts.isIdentifier(reference) &&
        reference.text === aliasName &&
        reference !== declaration.name &&
        !isDeclarationName(reference) &&
        !isNonValueIdentifier(reference) &&
        referenceControlsHookOrRepeatedShape(reference, state.owner)
      ) {
        unsafe = true;
      }
    });
  });
  return unsafe;
}

function referenceControlsHookOrRepeatedShape(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike
): boolean {
  for (let current: ts.Node | undefined = reference.parent; current && current !== owner; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      isHookCallOtherThan(current, new Set(["useCallback", "useMemo"])) &&
      current.arguments.some(argument => nodeWithin(reference, argument))
    ) {
      return true;
    }
    if (
      ts.isCallExpression(current) &&
      ["useCallback", "useMemo"].includes(hookCallName(current) ?? "") &&
      hookResultFeedsLifecycle(current, owner)
    ) {
      return true;
    }
  }
  const repeated = nearestRepeatedRenderCall(reference, owner);
  const repeatedOwner = repeated ? nearestNestedFunction(repeated, owner) : null;
  if (
    repeated &&
    (!repeatedOwner || isSynchronousRenderCallback(repeatedOwner)) &&
    ((!findAncestorUntil(reference, isJsxNode, repeated) &&
      !isOneHopKeyedRenderAlias(reference, repeated)) ||
      expressionControlsRepeatedItems(reference, repeated))
  ) {
    return true;
  }
  return nearestNestedFunction(reference, owner) === null &&
    !findAncestorUntil(reference, isJsxNode, owner) &&
    findAncestorUntil(reference, ts.isIfStatement, owner) !== null;
}

function isOneHopKeyedRenderAlias(
  reference: ts.Identifier,
  repeated: ts.CallExpression
): boolean {
  const callback = repeated.arguments[0];
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !repeatedRenderHasStableItemKey(callback)
  ) {
    return false;
  }
  const declaration = findAncestorUntil(reference, ts.isVariableDeclaration, callback);
  const binding = callback.parameters[0]?.name;
  if (
    !binding ||
    !declaration?.initializer ||
    !ts.isIdentifier(declaration.name) ||
    !nodeWithin(reference, declaration.initializer) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(callback, declaration.name.text) !== 1 ||
    !expressionDependsOnBinding(declaration.initializer, binding, callback)
  ) {
    return false;
  }
  const aliasName = declaration.name.text;
  let found = false;
  let safe = true;
  visit(callback.body, node => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== aliasName ||
      node === declaration.name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    found = true;
    safe = nearestRepeatedRenderCall(node, repeated.parent) === repeated &&
      findAncestorUntil(node, isJsxNode, repeated) !== null &&
      isSafeJsxProjectionReference(node, callback);
  });
  return found && safe;
}

function hasStaleUseCallbackCapture(state: StateCandidate): boolean {
  let stale = false;
  visit(state.owner.body, node => {
    if (
      stale ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      node.parent === state.call.parent
    ) {
      return;
    }
    const callback = nearestNestedFunction(node, state.owner);
    const call = callback?.parent;
    if (
      callback &&
      call &&
      ts.isCallExpression(call) &&
      hookCallName(call) === "useCallback" &&
      call.arguments[0] === callback
    ) {
      const dependencies = call.arguments[1];
      stale = !dependencies ||
        !ts.isArrayLiteralExpression(dependencies) ||
        !dependencies.elements.some(element =>
          ts.isIdentifier(element) && element.text === state.valueName
        );
    }
  });
  return stale;
}

function hookResultFeedsLifecycle(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const declaration = findAncestorUntil(call, ts.isVariableDeclaration, owner);
  if (!declaration || declaration.initializer !== call || !ts.isIdentifier(declaration.name)) return true;
  const name = declaration.name.text;
  let feedsLifecycle = false;
  visit(owner.body, node => {
    if (
      feedsLifecycle ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node)
    ) {
      return;
    }
    for (let current: ts.Node | undefined = node.parent; current && current !== owner; current = current.parent) {
      if (
        ts.isCallExpression(current) &&
        isHookCallOtherThan(current, new Set(["useCallback", "useMemo"])) &&
        current.arguments.some(argument => nodeWithin(node, argument))
      ) {
        feedsLifecycle = true;
        return;
      }
    }
  });
  return feedsLifecycle;
}

function isHookCallOtherThan(call: ts.CallExpression, allowed: ReadonlySet<string>): boolean {
  const name = hookCallName(call);
  return name !== null && /^use[A-Z0-9]/.test(name) && !allowed.has(name);
}

function hookCallName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;
}

function hasExternalCompanionWrites(
  owner: RuntimeFunctionLike,
  members: readonly StateCandidate[],
  allStates: readonly StateCandidate[]
): boolean {
  const memberSet = new Set(members);
  const stateBySetter = new Map(
    allStates.flatMap(state =>
      state.owner === owner && state.setterName ? [[state.setterName, state] as const] : []
    )
  );
  const mutations: SetterMutation[] = [];
  visit(owner.body, node => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    const state = stateBySetter.get(node.expression.text);
    if (!state) return;
    const region = nearestMutationFunction(node, owner);
    mutations.push({ branches: mutationBranches(node, region), call: node, region, state });
  });
  return mutations.some(memberMutation =>
    memberSet.has(memberMutation.state) &&
    mutations.some(other =>
      !memberSet.has(other.state) &&
      other.region === memberMutation.region &&
      branchesAreCompatible(other.branches, memberMutation.branches)
    )
  );
}

function expressionControlsRepeatedItems(node: ts.Node, repeated: ts.CallExpression): boolean {
  const receiver = ts.isPropertyAccessExpression(repeated.expression)
    ? repeated.expression.expression
    : null;
  return !!receiver && nodeWithin(node, receiver);
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

function oneHopRenderProjectionReferences(
  owner: RuntimeFunctionLike,
  renderNodes: readonly ts.Node[],
  isAllowedProjection: (expression: ts.Expression, reference: ts.Node) => boolean =
    isSafeProjectionExpression
): readonly ts.Identifier[] | null {
  if (renderNodes.length === 0 || renderNodes.some(node => !ts.isIdentifier(node))) return null;
  const declarations = new Set(
    renderNodes.map(node => findAncestorUntil(node, ts.isVariableDeclaration, owner))
  );
  const declaration = declarations.size === 1 ? [...declarations][0] : null;
  if (!declaration) return renderNodes as readonly ts.Identifier[];
  if (
    !declaration.initializer ||
    !ts.isIdentifier(declaration.name) ||
    !renderNodes.every(node => nodeWithin(node, declaration.initializer!)) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, declaration.name.text) !== 1 ||
    !renderNodes.every(node => isAllowedProjection(declaration.initializer!, node))
  ) {
    return null;
  }
  const declarationName = declaration.name;
  const references: ts.Identifier[] = [];
  visit(owner.body, node => {
    if (
      ts.isIdentifier(node) &&
      node.text === declarationName.text &&
      node !== declarationName &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references.length > 0 ? references : null;
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

function hasDraftRenderCut(
  owner: RuntimeFunctionLike,
  members: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  siblingRenderCuts: ReadonlyMap<StateCandidate, SiblingRenderCut>,
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>
): boolean {
  if (members.length === 1 && siblingRenderCuts.has(members[0]!)) return true;
  const ownerJsx = jsxElementCount(owner);
  const localUsages = members.map(member => usageByState.get(member));
  const localCuts: JsxSubtreeNode[] = [];
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index]!;
    const usage = localUsages[index];
    const directSetterRead = hasDirectJsxEventSetter(member) ? 1 : 0;
    if (
      !usage ||
      usage.transportedOccurrences !== 0 ||
      usage.directRenderNodes.length === 0 ||
      usage.localRenderReads !== usage.directRenderNodes.length + directSetterRead ||
      usage.directRenderNodes.some(node =>
        nearestNestedFunction(node, owner) !== null ||
        !isSafeJsxProjectionReference(node, owner)
      )
    ) {
      localCuts.length = 0;
      break;
    }
    const cut = lowestCommonJsxSubtree(usage.directRenderNodes, owner);
    if (!cut || jsxElementCountIn(cut) / ownerJsx > 0.4) {
      localCuts.length = 0;
      break;
    }
    localCuts.push(cut);
  }
  if (localCuts.length === members.length && owner.body) {
    const returned = uniqueReturnedExpression(owner);
    if (
      returned &&
      hasIndependentRenderCutWitness(
        returned,
        localCuts,
        localComponents,
        sourceComponents
      )
    ) {
      return true;
    }
  }
  if (
    ownerJsx >= 12 &&
    localUsages.every(usage => usage && draftValueTransportsAreBounded(usage, owner, ownerJsx))
  ) {
    return true;
  }
  if (localUsages.some(usage => !usage || usage.localRenderReads > 0)) return false;
  const sites = members.map(member => usageByState.get(member)?.valueTransportSites);
  if (sites.some(value => !value || value.size !== 1)) return false;
  const site = [...sites[0]!][0];
  if (site === undefined || !sites.every(value => [...value!][0] === site)) return false;
  const callSite = directUniqueReturnCallSite(usageByState.get(members[0]!)!, owner);
  if (!callSite) return false;
  const target = callSite.opening;
  const targetSubtree: ts.Node = ts.isJsxOpeningElement(target) ? target.parent : target;
  let independent = false;
  visitSkippingNestedRuntimeFunctions(callSite.returned, node => {
    if (
      !independent &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node !== target
    ) {
      const subtree: ts.Node = ts.isJsxOpeningElement(node) ? node.parent : node;
      independent = !nodeWithin(subtree, targetSubtree) && !nodeWithin(targetSubtree, subtree);
    }
  });
  return independent;
}

function draftValueTransportsAreBounded(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
  ownerJsx: number
): boolean {
  const body = owner.body;
  if (!body) return false;
  for (const site of usage.valueTransportSites) {
    let target: JsxSubtreeNode | null = null;
    visitSkippingNestedRuntimeFunctions(body, node => {
      if (
        target ||
        (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) ||
        node.getStart() !== site
      ) {
        return;
      }
      target = ts.isJsxOpeningElement(node) ? node.parent : node;
    });
    if (!target || jsxElementCountIn(target) / ownerJsx > 0.4) return false;
  }
  return true;
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

function findStatesWithIndependentDirectEventWrites(
  states: readonly StateCandidate[]
): ReadonlySet<StateCandidate> {
  const result = new Set<StateCandidate>();
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
        !/^on[A-Z]/.test(node.name.getText()) ||
        !node.initializer ||
        !ts.isJsxExpression(node.initializer) ||
        !node.initializer.expression
      ) {
        return;
      }
      const controlledInteraction = isControlledInteractionProp(node.name.getText());
      if (ts.isIdentifier(node.initializer.expression)) return;
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
      if (state) result.add(state);
    });
  }
  return result;
}

function findAsyncLeafStatuses(
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  safeCommandStates: ReadonlySet<StateCandidate>
): ReadonlySet<StateCandidate> {
  const result = new Set<StateCandidate>();
  for (const state of states) {
    const usage = usageByState.get(state);
    if (
      !state.setterName ||
      !hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) ||
      !safeCommandStates.has(state) ||
      !usage ||
      usage.setterCallNodes.length < 2 ||
      usage.setterReferences !== usage.setterCalls ||
      usage.setterUsesPreviousValue ||
      usage.shadowed ||
      usage.escaped ||
      !usage.setterCallNodes.every(call =>
        call.arguments.length === 1 &&
        (call.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword ||
          call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword)
      )
    ) {
      continue;
    }

    const regions = usage.setterCallNodes.map(call => nearestMutationFunction(call, state.owner));
    const region = regions[0];
    if (
      !region ||
      region === state.owner ||
      regions.some(candidate => candidate !== region) ||
      (!ts.isArrowFunction(region) &&
        !ts.isFunctionDeclaration(region) &&
        !ts.isFunctionExpression(region)) ||
      !callbackIsEventRooted(region, state.owner, "", new Set())
    ) {
      continue;
    }

    const pendingStart = usage.setterCallNodes.find(call =>
      call.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword &&
      startsAwaitedCommandSegment(call)
    );
    const ownerSetters = new Set(
      states
        .filter(candidate => candidate.owner === state.owner && candidate.setterName)
        .map(candidate => candidate.setterName!)
    );
    if (
      pendingStart &&
      !hasEarlierOwnerStateWrite(region, pendingStart, ownerSetters) &&
      usage.setterCallNodes.some(call =>
        call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword &&
        call.getStart() > pendingStart.getStart()
      )
    ) {
      result.add(state);
    }
  }
  return result;
}

function hasEarlierOwnerStateWrite(
  region: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  pendingStart: ts.CallExpression,
  ownerSetters: ReadonlySet<string>
): boolean {
  if (!region.body) return true;
  let found = false;
  visitSkippingNestedRuntimeFunctions(region.body, node => {
    if (
      node.getStart() < pendingStart.getStart() &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ownerSetters.has(node.expression.text)
    ) {
      found = true;
    }
  });
  return found;
}

function startsAwaitedCommandSegment(call: ts.CallExpression): boolean {
  const statement = call.parent;
  const block = statement.parent;
  if (
    !ts.isExpressionStatement(statement) ||
    !ts.isBlock(block) ||
    block.statements.length < 2
  ) {
    return false;
  }
  const index = block.statements.indexOf(statement);
  const next = index >= 0 ? block.statements[index + 1] : undefined;
  if (!next) return false;
  let containsAwait = false;
  visitSkippingNestedRuntimeFunctions(next, node => {
    if (ts.isAwaitExpression(node)) containsAwait = true;
  });
  return containsAwait;
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

function hasStateInitializer(state: StateCandidate, kind: ts.SyntaxKind): boolean {
  return state.call.arguments.length === 1 && state.call.arguments[0]?.kind === kind;
}

function hasDirectPrimitiveInitializer(state: StateCandidate): boolean {
  const initializer = state.call.arguments[0];
  return initializer !== undefined && isDirectPrimitiveExpression(initializer);
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

function isDirectPrimitiveExpression(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  if (
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value)
  ) {
    return true;
  }
  return ts.isPrefixUnaryExpression(value) &&
    (value.operator === ts.SyntaxKind.PlusToken || value.operator === ts.SyntaxKind.MinusToken) &&
    (ts.isNumericLiteral(value.operand) || ts.isBigIntLiteral(value.operand));
}

function stateMayHoldCallable(state: StateCandidate): boolean {
  const type = state.call.typeArguments?.[0];
  if (!type) return false;
  if (ts.isFunctionTypeNode(type) || ts.isConstructorTypeNode(type)) return true;
  if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type)) {
    return stateTypeMayBeCallable(type.type);
  }
  return ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)
    ? type.types.some(stateTypeMayBeCallable)
    : stateTypeMayBeCallable(type);
}

function stateTypeMayBeCallable(type: ts.TypeNode): boolean {
  if (ts.isFunctionTypeNode(type) || ts.isConstructorTypeNode(type)) return true;
  if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type)) {
    return stateTypeMayBeCallable(type.type);
  }
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.some(stateTypeMayBeCallable);
  }
  if (!ts.isTypeReferenceNode(type)) return false;
  const name = type.typeName.getText();
  return /(?:^|\.)(?:ComponentType|ComponentClass|FC|Function|JSXElementConstructor)$/.test(name);
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
  isAsyncLeafStatus: boolean,
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
  if (
    isAsyncLeafStatus &&
    jsxElementCount(state.owner) >= 12 &&
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences > 0 &&
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1 &&
    directCallSite !== null &&
    !usage.repeatedValueTransport &&
    !usage.shadowed &&
    !usage.escaped
  ) {
    const target = [...usage.valueTargets][0] ?? "the pending control";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace async pending flag \`${state.valueName}\` with a component-lifetime observable and wrap the stable \`${target}\` call site in a leaf subscriber; preserve the event command and its await boundary exactly, changing only the true/false writes so pending transitions do not invalidate the broad owner.`,
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
    !usage.repeatedValueTransport &&
    (!hasCompanionWrites || hasIndependentDirectEventWrite) &&
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
      message: `Replace \`${state.valueName}\` with a component-lifetime observable and extract one stable call-site leaf wrapper around \`${target}\` (never define it inline); subscribe there, pass the same prop snapshot, and adapt owner commands to mutate without subscribing.`,
    };
  }
  if (
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
    hasControlledLeafRenderCut(state, usage, localComponents, sourceComponents)
  ) {
    const target = [...usage.valueTargets][0] ?? "the controlled child";
    return {
      action: "use-observable",
      confidence: "probable",
      message: `Replace controlled state \`${state.valueName}\` with an owner-scoped observable and wrap \`${target}\` in a stable leaf subscriber; keep its value callback API unchanged and use non-tracking reads in submit or commit commands.`,
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
    setterOwnedByValueCallSite(usage, state.owner) &&
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
  return usage.setterReferences === usage.setterCalls &&
    usage.setterCallNodes.length > 0 &&
    usage.setterCallNodes.every(call => {
      const attribute = findAncestorUntil(call, ts.isJsxAttribute, owner);
      return attribute !== null && jsxTransportSite(attribute) === valueSite;
    });
}

function hasControlledLeafRenderCut(
  state: StateCandidate,
  usage: StateUsage,
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>
): boolean {
  const callSite = controlledLeafCallSite(state, usage);
  if (!callSite) return false;
  const controlled = callSite.opening;
  const controlledSubtree: ts.Node = ts.isJsxOpeningElement(controlled) ? controlled.parent : controlled;
  return hasIndependentRenderCutWitness(
    callSite.returned,
    [controlledSubtree],
    localComponents,
    sourceComponents
  );
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
  usage: StateUsage
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
  if (
    !callSite ||
    (!hasDirectInteractionSetter(callSite.opening, state.setterName) &&
      !hasInlineInteractionSetter(callSite.opening, state, usage) &&
      !hasInteractionSetterAdapter(callSite.opening, state, usage))
  ) {
    return null;
  }
  return callSite;
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

function hasIndependentRenderCutWitness(
  returned: ts.Expression,
  excluded: readonly ts.Node[],
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>
): boolean {
  let hasIndependentComponent = false;
  let independentElements = 0;
  visitSkippingNestedRuntimeFunctions(returned, node => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      (() => {
        const candidateSubtree: ts.Node = ts.isJsxOpeningElement(node) ? node.parent : node;
        const independent = excluded.every(subtree =>
          candidateSubtree !== subtree &&
          !nodeWithin(candidateSubtree, subtree) &&
          !nodeWithin(subtree, candidateSubtree)
        );
        if (!independent) return false;
        for (
          let current: ts.Node | undefined = candidateSubtree.parent;
          current && current !== returned;
          current = current.parent
        ) {
          if (
            (ts.isJsxElement(current) ||
              ts.isJsxFragment(current) ||
              ts.isJsxSelfClosingElement(current)) &&
            excluded.every(subtree =>
              current !== subtree &&
              !nodeWithin(current, subtree) &&
              !nodeWithin(subtree, current)
            )
          ) {
            return false;
          }
        }
        return true;
      })()
    ) {
      independentElements += 1;
      if (!hasIndependentComponent) {
        const candidateSubtree: ts.Node = ts.isJsxOpeningElement(node) ? node.parent : node;
        visit(candidateSubtree, descendant => {
          if (
            hasIndependentComponent ||
            (!ts.isJsxOpeningElement(descendant) && !ts.isJsxSelfClosingElement(descendant))
          ) {
            return;
          }
          const name = descendant.tagName.getText();
          hasIndependentComponent = localComponents.has(name) || sourceComponents.has(name);
        });
      }
    }
  });
  return hasIndependentComponent || independentElements >= 2;
}

function hasOnlyEventCommandReads(
  state: StateCandidate,
  ignored: ReadonlySet<ts.Node> = EMPTY_NODES
): boolean {
  let safe = true;
  visit(state.owner.body, node => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      node.parent === state.call.parent ||
      ignored.has(node)
    ) {
      return;
    }
    if (findAncestorUntil(node, isJsxNode, state.owner)) return;
    const callback = nearestNestedFunction(node, state.owner);
    if (
      callback &&
      (ts.isArrowFunction(callback) || ts.isFunctionDeclaration(callback) || ts.isFunctionExpression(callback))
    ) {
      safe = callbackIsEventRooted(callback, state.owner, state.valueName, new Set());
      return;
    }
    if (isHookDependencyReference(node, new Set(["useCallback"]))) {
      const call = findAncestorUntil(node, ts.isCallExpression, state.owner);
      const candidate = call?.arguments[0];
      safe = !!candidate &&
        (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) &&
        callbackIsEventRooted(candidate, state.owner, state.valueName, new Set());
      return;
    }
    safe = false;
  });
  return safe;
}

function callbackIsEventRooted(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  dependencyName: string,
  seen: ReadonlySet<string>
): boolean {
  if (callback.body && isInsideJsxEventCallback(callback.body, owner)) return true;
  const name = ts.isFunctionDeclaration(callback)
    ? callback.name?.text
    : ts.isVariableDeclaration(callback.parent) && ts.isIdentifier(callback.parent.name)
      ? callback.parent.name.text
      : ts.isCallExpression(callback.parent) &&
          ts.isVariableDeclaration(callback.parent.parent) &&
          ts.isIdentifier(callback.parent.parent.name)
        ? callback.parent.parent.name.text
        : undefined;
  if (!name || seen.has(name) || bindingDeclarationCount(owner, name) !== 1) return false;
  if (
    dependencyName &&
    ts.isCallExpression(callback.parent) &&
    hookCallName(callback.parent) === "useCallback"
  ) {
    const dependencies = callback.parent.arguments[1];
    if (
      !dependencies ||
      !ts.isArrayLiteralExpression(dependencies) ||
      !dependencies.elements.some(element => ts.isIdentifier(element) && element.text === dependencyName)
    ) {
      return false;
    }
  }

  const nextSeen = new Set(seen).add(name);
  let referenced = false;
  let safe = true;
  visit(owner.body, node => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    referenced = true;
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    if (
      attribute &&
      /^on[A-Z]/.test(attribute.name.getText()) &&
      isDirectJsxAttributeExpression(attribute, node)
    ) {
      return;
    }
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      const caller = nearestNestedFunction(node, owner);
      if (
        caller &&
        (ts.isArrowFunction(caller) || ts.isFunctionDeclaration(caller) || ts.isFunctionExpression(caller)) &&
        callbackIsEventRooted(caller, owner, dependencyName, nextSeen)
      ) {
        return;
      }
    }
    safe = false;
  });
  return referenced && safe;
}

function hasDirectInteractionSetter(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  setterName: string
): boolean {
  return opening.attributes.properties.some(attribute =>
    ts.isJsxAttribute(attribute) &&
    isControlledInteractionProp(attribute.name.getText()) &&
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
  usage: StateUsage
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
      !isControlledInteractionProp(attribute.name.getText()) ||
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
  usage: StateUsage
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
    isControlledInteractionProp(attribute.name.getText()) &&
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

function containsCallExpression(node: ts.Node): boolean {
  let found = false;
  visit(node, child => {
    if (ts.isCallExpression(child)) found = true;
  });
  return found;
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

function findDeferredRevealStates(
  effects: readonly EffectCandidate[],
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>
): ReadonlySet<StateCandidate> {
  const statesByOwner = new Map<RuntimeFunctionLike, StateCandidate[]>();
  for (const state of states) {
    const ownerStates = statesByOwner.get(state.owner) ?? [];
    ownerStates.push(state);
    statesByOwner.set(state.owner, ownerStates);
  }
  const result = new Set<StateCandidate>();
  for (const effect of effects) {
    if (!effect.owner) continue;
    const stateBySetter = new Map(
      (statesByOwner.get(effect.owner) ?? []).flatMap(state =>
        state.setterName ? [[state.setterName, state] as const] : []
      )
    );
    const state = deferredRevealState(effect, stateBySetter);
    if (!state || state.owner !== effect.owner || !hasStateInitializer(state, ts.SyntaxKind.FalseKeyword)) {
      continue;
    }
    const usage = usageByState.get(state);
    if (
      !usage ||
      usage.setterReferences !== 1 ||
      usage.setterCalls !== 1 ||
      usage.effectWrites !== 1 ||
      usage.effectReads > 0 ||
      usage.deferredReads > 0 ||
      usage.transportedOccurrences > 0 ||
      usage.directRenderNodes.length !== 1 ||
      usage.localRenderReads !== usage.directRenderNodes.length ||
      usage.shadowed ||
      usage.escaped ||
      !usage.directRenderNodes.every(node => isRenderGateReference(node, state.owner))
    ) {
      continue;
    }
    result.add(state);
  }
  return result;
}

function deferredRevealState(
  effect: EffectCandidate,
  stateBySetter: ReadonlyMap<string, StateCandidate>
): StateCandidate | null {
  if (
    !effect.callback ||
    !effect.dependencies ||
    effect.dependencies.elements.length !== 0 ||
    !ts.isBlock(effect.callback.body)
  ) {
    return null;
  }
  const schedulerDeclarations: Array<{
    handle: string;
    setter: StateCandidate;
  }> = [];
  const knownSetterCalls: ts.CallExpression[] = [];
  visit(effect.callback.body, node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && stateBySetter.has(node.expression.text)) {
      knownSetterCalls.push(node);
    }
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.initializer ||
      !ts.isCallExpression(node.initializer)
    ) {
      return;
    }
    const callback = node.initializer.arguments[0];
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return;
    const setterCall = soleLiteralTrueSetterCall(callback, stateBySetter);
    const setter = setterCall ? stateBySetter.get(setterCall.expression.text) : undefined;
    if (setter) schedulerDeclarations.push({ handle: node.name.text, setter });
  });
  if (schedulerDeclarations.length !== 1 || knownSetterCalls.length !== 1) return null;
  const scheduler = schedulerDeclarations[0];
  if (!scheduler || !callbackCancelsDeferredHandle(effect.callback, scheduler.handle)) {
    return null;
  }
  return scheduler.setter;
}

function soleLiteralTrueSetterCall(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>
): (ts.CallExpression & { expression: ts.Identifier }) | null {
  const calls: Array<ts.CallExpression & { expression: ts.Identifier }> = [];
  visitSkippingNestedFunctions(callback.body, callback, node => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      stateBySetter.has(node.expression.text)
    ) {
      calls.push(node as ts.CallExpression & { expression: ts.Identifier });
    }
  });
  const call = calls[0];
  return calls.length === 1 &&
    call?.arguments.length === 1 &&
    call.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword
    ? call
    : null;
}

function callbackCancelsDeferredHandle(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  handle: string
): boolean {
  if (!ts.isBlock(callback.body)) return false;
  return callback.body.statements.some(statement => {
    if (!ts.isReturnStatement(statement) || !statement.expression) return false;
    const cleanup = statement.expression;
    if (!ts.isArrowFunction(cleanup) && !ts.isFunctionExpression(cleanup)) return false;
    const cleanupBindings = localBindingNames(cleanup, null);
    if (cleanupBindings.has(handle)) return false;
    const call = ts.isBlock(cleanup.body)
      ? (() => {
          const only = cleanup.body.statements[0];
          return cleanup.body.statements.length === 1 && only && ts.isExpressionStatement(only)
            ? only.expression
            : null;
        })()
      : cleanup.body;
    if (!call || !ts.isCallExpression(call)) return false;
    if (
      ts.isPropertyAccessExpression(call.expression) &&
      ts.isIdentifier(call.expression.expression) &&
      call.expression.expression.text === handle &&
      /^(?:cancel|clear|remove)$/.test(call.expression.name.text) &&
      call.arguments.length === 0
    ) {
      return true;
    }
    const argument = call.arguments[0];
    return ts.isIdentifier(call.expression) &&
      /^(?:cancel|clear|remove)/.test(call.expression.text) &&
      call.arguments.length === 1 &&
      !!argument &&
      ts.isIdentifier(argument) &&
      argument.text === handle;
  });
}

function isRenderGateReference(node: ts.Node, boundary: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current && current !== boundary; current = current.parent) {
    if (ts.isConditionalExpression(current) && nodeWithin(node, current.condition)) return true;
    if (
      ts.isIfStatement(current) &&
      nodeWithin(node, current.expression) &&
      statementContainsRenderableReturn(current.thenStatement, boundary)
    ) {
      return true;
    }
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      nodeWithin(node, current.left) &&
      expressionContainsJsx(current.right)
    ) {
      return true;
    }
  }
  return false;
}

function commonRenderGateSubtree(
  nodes: readonly ts.Node[],
  boundary: ts.Node
): JsxSubtreeNode | null {
  const subtrees = nodes.map(node => renderGateSubtree(node, boundary));
  const first = subtrees[0];
  return first && subtrees.every(subtree => subtree === first) ? first : null;
}

function renderGateSubtree(node: ts.Node, boundary: ts.Node): JsxSubtreeNode | null {
  for (let current: ts.Node | undefined = node.parent; current && current !== boundary; current = current.parent) {
    if (
      ts.isConditionalExpression(current) &&
      nodeWithin(node, current.condition) &&
      isSafeProjectionExpression(current.condition, node)
    ) {
      return jsxSubtreeAncestors(current, boundary)[0] ?? null;
    }
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      nodeWithin(node, current.left) &&
      isSafeProjectionExpression(current.left, node)
    ) {
      const subtree = directJsxSubtree(current.right);
      if (subtree) return subtree;
    }
  }
  return null;
}

function directJsxSubtree(expression: ts.Expression): JsxSubtreeNode | null {
  const current = unwrapTransparentExpression(expression);
  return ts.isJsxElement(current) || ts.isJsxFragment(current) || ts.isJsxSelfClosingElement(current)
    ? current
    : null;
}

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function statementContainsRenderableReturn(statement: ts.Statement, boundary: ts.Node): boolean {
  let found = false;
  visitSkippingNestedRuntimeFunctions(statement, node => {
    if (
      ts.isReturnStatement(node) &&
      !!node.expression &&
      (expressionContainsJsx(node.expression) ||
        (ts.isIdentifier(node.expression) &&
          uniqueConstJsxInitializer(boundary, node.expression.text) !== null))
    ) {
      found = true;
    }
  });
  return found;
}

function uniqueConstJsxInitializer(boundary: ts.Node, name: string): ts.Expression | null {
  const declarations: ts.VariableDeclaration[] = [];
  visitSkippingNestedRuntimeFunctions(boundary, node => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      declarations.push(node);
    }
  });
  const declaration = declarations[0];
  if (
    declarations.length !== 1 ||
    !declaration?.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    !expressionContainsJsx(declaration.initializer)
  ) {
    return null;
  }
  return declaration.initializer;
}

function expressionContainsJsx(expression: ts.Expression): boolean {
  let found = false;
  visit(expression, node => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node) || ts.isJsxSelfClosingElement(node)) found = true;
  });
  return found;
}

interface StateSubtree {
  kind: "direct" | "gate" | "projection";
  label: string;
  line: number;
  node: JsxSubtreeNode;
  repeated: boolean;
  unstable: boolean;
}

type JsxSubtreeNode = ts.JsxElement | ts.JsxFragment | ts.JsxSelfClosingElement;

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

function allSetterPathsHaveReactiveMutation(
  state: StateCandidate,
  usage: StateUsage,
  mutationBindings: ReadonlySet<string>
): boolean {
  return mutationBindings.size > 0 &&
    usage.setterCallNodes.length > 0 &&
    usage.setterCallNodes.every(call =>
      functionAncestors(call, state.owner).some(ancestor =>
        functionDirectlyCallsBinding(ancestor, mutationBindings)
      )
    );
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
      if (
        ts.isCallExpression(current) &&
        ts.isIdentifier(current.expression) &&
        /^use[A-Z0-9]/.test(current.expression.text) &&
        !["useCallback", "useEffect"].includes(current.expression.text) &&
        current.arguments.some(argument => nodeWithin(call, argument))
      ) {
        return true;
      }
    }
    return false;
  });
}

function isSafeJsxProjectionReference(
  node: ts.Node,
  boundary: ts.Node,
  allowedIdentifierCalls: ReadonlySet<string> = EMPTY_BINDINGS
): boolean {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, boundary);
  if (attribute) {
    if (attribute.name.getText() === "key") return false;
    const initializer = attribute.initializer;
    return !!initializer &&
      ts.isJsxExpression(initializer) &&
      !!initializer.expression &&
      isSafeProjectionExpression(initializer.expression, node, allowedIdentifierCalls);
  }
  const expression = findAncestorUntil(node, ts.isJsxExpression, boundary);
  return !!expression?.expression &&
    isSafeProjectionExpression(expression.expression, node, allowedIdentifierCalls);
}

function isSafeProjectionExpression(
  expression: ts.Expression,
  reference: ts.Node,
  allowedIdentifierCalls: ReadonlySet<string> = EMPTY_BINDINGS
): boolean {
  if (!nodeWithin(reference, expression)) return false;
  let safe = true;
  visit(expression, node => {
    if (
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isDeleteExpression(node) ||
      ts.isPostfixUnaryExpression(node) ||
      (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) ||
      (ts.isCallExpression(node) && !isSafeProjectionCall(node, allowedIdentifierCalls))
    ) {
      safe = false;
    }
  });
  return safe;
}

function isSafeProjectionCall(
  call: ts.CallExpression,
  allowedIdentifierCalls: ReadonlySet<string>
): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return allowedIdentifierCalls.has(callee.text);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const name = callee.name.text;
  if (["filter", "findIndex", "join", "slice", "trim"].includes(name)) return true;
  const root = callRootIdentifier(callee);
  return root === "styles" || root === "cn";
}

function commonRepeatedRender(
  nodes: readonly ts.Node[],
  boundary: ts.Node
): ts.CallExpression | null {
  const calls = nodes.map(node => nearestRepeatedRenderCall(node, boundary));
  const first = calls[0];
  return first && calls.every(call => call === first) ? first : null;
}

function nearestRepeatedRenderCall(node: ts.Node, boundary: ts.Node): ts.CallExpression | null {
  for (let current: ts.Node | undefined = node; current && current !== boundary; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ["map", "flatMap"].includes(current.expression.name.text)
    ) {
      return current;
    }
  }
  return null;
}

function lowestCommonJsxSubtree(
  nodes: readonly ts.Node[],
  boundary: ts.Node
): JsxSubtreeNode | null {
  const ancestorLists = nodes.map(node => jsxSubtreeAncestors(node, boundary));
  const first = ancestorLists[0];
  if (!first || ancestorLists.some(ancestors => ancestors.length === 0)) return null;
  return first.find(candidate => ancestorLists.every(ancestors => ancestors.includes(candidate))) ?? null;
}

function jsxSubtreeAncestors(node: ts.Node, boundary: ts.Node): JsxSubtreeNode[] {
  const ancestors: JsxSubtreeNode[] = [];
  for (let current: ts.Node | undefined = node; current && current !== boundary; current = current.parent) {
    if (ts.isJsxElement(current) || ts.isJsxFragment(current) || ts.isJsxSelfClosingElement(current)) {
      ancestors.push(current);
    }
  }
  return ancestors;
}

function jsxElementCountIn(node: JsxSubtreeNode): number {
  let count = 0;
  visit(node, current => {
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) count += 1;
  });
  return count;
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

function isNonProductionHarness(fileName: string): boolean {
  return /(?:^|\/)(?:__tests__|stories|demos)(?:\/|$)|\.(?:spec|test|stories?)\.[cm]?[jt]sx?$/i.test(
    fileName.split(path.sep).join("/")
  );
}

function classifyEffect(
  effect: EffectCandidate,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
  stateByValue: ReadonlyMap<string, StateCandidate>,
  usageBySetter: ReadonlyMap<string, StateUsage>,
  useValueBindings: ReadonlySet<string>,
  useObservableBindings: ReadonlySet<string>,
  moduleScopeBindings: ReadonlySet<string>
): ClassifiedEffect {
  if (!effect.callback) {
    return {
      action: "review-effect",
      confidence: "probable",
      derivedState: null,
      message: "Review this effect; its callback is not defined inline, so execution and cleanup ownership are unresolved.",
    };
  }

  const derivedState = findPureDerivedSetter(
    effect.callback,
    effect.dependencies,
    stateBySetter,
    usageBySetter
  );
  if (derivedState) {
    return {
      action: "delete-effect",
      confidence: "certain",
      derivedState,
      message: `Delete this effect and calculate the value passed to \`${derivedState.setterName}\` directly during render.`,
    };
  }

  const eventReset = findMutationSiteReset(
    effect,
    stateBySetter,
    stateByValue,
    usageBySetter
  );
  if (eventReset) {
    return {
      action: "move-to-event",
      confidence: "probable",
      derivedState: null,
      message: `Move the \`${eventReset.target.valueName}\` reset into every ${eventReset.sources.map(source => `\`${source.valueName}\``).join(", ")} mutation—inside the same observable action if this state is migrated—then delete this effect.`,
    };
  }

  const hasCleanup = callbackHasCleanup(effect.callback, stateBySetter);
  if (effect.dependencies?.elements.length === 0) {
    if (isCleanupOnly(effect.callback)) {
      return {
        action: "use-unmount",
        confidence: "probable",
        derivedState: null,
        message: "Replace this teardown-only empty-dependency effect with `useUnmount` if once-only Legend lifecycle semantics are intended.",
      };
    }
    if (
      !hasCleanup &&
      effect.owner &&
      callbackIsCommittedRefIntegration(effect.callback, effect.owner, true)
    ) {
      return committedRefEffect();
    }
    if (
      !hasCleanup &&
      effect.owner &&
      isSetupOnlyMountCandidate(effect.callback, effect.owner, stateBySetter, moduleScopeBindings)
    ) {
      return {
        action: "use-mount",
        confidence: "probable",
        derivedState: null,
        message: "Replace this module-global, setup-only effect with `useMount` if suppressing React Strict Mode's development replay is intended.",
      };
    }
    if (!hasCleanup && !callbackCallsKnownSetter(effect.callback, stateBySetter)) {
      return {
        action: "review-effect",
        confidence: "probable",
        derivedState: null,
        message: "Review this empty-dependency setup before choosing `useMount`; suppressing React Strict Mode's development replay changes lifecycle semantics.",
      };
    }
    return {
      action: "keep-effect",
      confidence: "certain",
      derivedState: null,
      message: "Keep this React effect; it owns paired mount setup and cleanup semantics.",
    };
  }

  if (
    !hasCleanup &&
    effect.owner &&
    callbackIsCommittedRefIntegration(effect.callback, effect.owner)
  ) {
    return committedRefEffect();
  }

  if (effect.dependencies && effect.dependencies.elements.length > 0 && !hasCleanup) {
    const dependencyNames = effect.dependencies.elements.flatMap(element =>
      ts.isIdentifier(element) ? [element.text] : []
    );
    const directUseValueDependencies = dependencyNames.filter(name => useValueBindings.has(name));
    if (
      dependencyNames.length === effect.dependencies.elements.length &&
      dependencyNames.length > 0 &&
      directUseValueDependencies.length > 0 &&
      dependencyNames.every(name => useValueBindings.has(name) || useObservableBindings.has(name)) &&
      directUseValueDependencies.every(name => callbackReadsUnshadowedIdentifier(effect.callback!, name))
    ) {
      return {
        action: "use-observe-effect",
        confidence: "probable",
        derivedState: null,
        message: "Rewrite this post-mount reaction with `useObserveEffect`, reading its observable sources directly; dependencies are `useValue` snapshots or stable `useObservable` handles.",
      };
    }
  }

  if (hasCleanup) {
    return {
      action: "keep-effect",
      confidence: "certain",
      derivedState: null,
      message: "Keep this React effect; it owns an explicit setup and cleanup lifecycle.",
    };
  }
  return {
    action: "review-effect",
    confidence: "probable",
    derivedState: null,
    message: "Review this effect's causal owner before choosing React lifecycle, an event handler, or an observable reaction.",
  };
}

function committedRefEffect(): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "certain",
    derivedState: null,
    message: "Keep this React effect; it operates on a committed ref and depends on React post-commit ordering.",
  };
}

function callbackIsCommittedRefIntegration(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  rejectSnapshotCaptures = false
): boolean {
  if (!owner.body) return false;
  const refs = new Set<string>();
  visitSkippingNestedRuntimeFunctions(owner.body, node => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      hookCallName(node.initializer) === "useRef"
    ) {
      refs.add(node.name.text);
    }
  });
  if (refs.size === 0) return false;

  if (rejectSnapshotCaptures) {
    const ownerLocals = localBindingNames(owner, callback);
    const callbackLocals = localBindingNames(callback, null);
    let capturesSnapshot = false;
    visit(callback.body, node => {
      if (
        !capturesSnapshot &&
        ts.isIdentifier(node) &&
        ownerLocals.has(node.text) &&
        !refs.has(node.text) &&
        !callbackLocals.has(node.text) &&
        !isNonValueIdentifier(node)
      ) {
        capturesSnapshot = true;
      }
    });
    if (capturesSnapshot) return false;
  }

  const readsCommittedRef = (node: ts.Node): boolean => {
    let reads = false;
    visit(node, child => {
      if (
        reads ||
        !ts.isPropertyAccessExpression(child) ||
        child.name.text !== "current" ||
        !ts.isIdentifier(child.expression) ||
        !refs.has(child.expression.text)
      ) {
        return;
      }
      const parent = child.parent;
      const directAssignment = ts.isBinaryExpression(parent) &&
        parent.left === child &&
        isAssignmentOperator(parent.operatorToken.kind);
      const directUpdate = (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        parent.operand === child;
      if (!directAssignment && !directUpdate) reads = true;
    });
    return reads;
  };
  const expressionIsRefIntegration = (expression: ts.Expression): boolean => {
    if (!ts.isCallExpression(expression) || !readsCommittedRef(expression)) return false;
    let safe = true;
    visit(expression, node => {
      if (safe && ts.isCallExpression(node) && !readsCommittedRef(node)) safe = false;
    });
    return safe;
  };
  const statementIsRefIntegration = (statement: ts.Statement): boolean => {
    if (ts.isBlock(statement)) return statement.statements.every(statementIsRefIntegration);
    if (ts.isIfStatement(statement)) {
      return !containsCallExpression(statement.expression) &&
        statementIsRefIntegration(statement.thenStatement) &&
        (!statement.elseStatement || statementIsRefIntegration(statement.elseStatement));
    }
    return ts.isExpressionStatement(statement) && expressionIsRefIntegration(statement.expression);
  };
  if (ts.isBlock(callback.body)) {
    return callback.body.statements.length > 0 && callback.body.statements.every(statementIsRefIntegration);
  }
  return expressionIsRefIntegration(callback.body);
}

function isSetupOnlyMountCandidate(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
  moduleScopeBindings: ReadonlySet<string>
): boolean {
  if (!ts.isBlock(callback.body) || callback.body.statements.length === 0) return false;
  if (callbackCallsKnownSetter(callback, stateBySetter)) return false;
  if (
    !callback.body.statements.every(
      statement => ts.isExpressionStatement(statement) && expressionContainsCall(statement.expression)
    )
  ) {
    return false;
  }

  let ownsLifetimeApi = false;
  let callsUnresolvedSetup = false;
  visit(callback.body, node => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : "";
    if (/^(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|addEventListener|subscribe)$/.test(name)) {
      ownsLifetimeApi = true;
    }
    const root = callRootIdentifier(callee);
    if (root && !moduleScopeBindings.has(root) && !KNOWN_GLOBAL_OBJECTS.has(root)) {
      callsUnresolvedSetup = true;
    }
  });
  if (ownsLifetimeApi || callsUnresolvedSetup) return false;

  const ownerLocals = localBindingNames(owner, callback);
  const callbackLocals = localBindingNames(callback, null);
  let capturesOwnerLocal = false;
  visit(callback.body, node => {
    if (
      ts.isIdentifier(node) &&
      ownerLocals.has(node.text) &&
      !callbackLocals.has(node.text) &&
      !isNonValueIdentifier(node)
    ) {
      capturesOwnerLocal = true;
    }
  });
  return !capturesOwnerLocal;
}

const KNOWN_GLOBAL_OBJECTS = new Set(["console", "Date", "Math", "JSON", "Promise", "globalThis"]);

function callRootIdentifier(expression: ts.LeftHandSideExpression): string | null {
  let current: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

function expressionContainsCall(expression: ts.Expression): boolean {
  let contains = false;
  visit(expression, node => {
    if (ts.isCallExpression(node)) contains = true;
  });
  return contains;
}

function localBindingNames(owner: RuntimeFunctionLike, excluded: ts.Node | null): ReadonlySet<string> {
  const names = new Set<string>();
  for (const parameter of owner.parameters) collectBindingNames(parameter.name, names);
  function walk(node: ts.Node): void {
    if (node === excluded) return;
    if (ts.isVariableDeclaration(node)) collectBindingNames(node.name, names);
    if (ts.isFunctionDeclaration(node) && node.name) names.add(node.name.text);
    node.forEachChild(walk);
  }
  if (owner.body) walk(owner.body);
  return names;
}

function collectBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) collectBindingNames(element.name, names);
  }
}

function callbackReadsUnshadowedIdentifier(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  name: string
): boolean {
  let reads = false;
  let shadowed = callback.parameters.some(
    parameter => ts.isIdentifier(parameter.name) && parameter.name.text === name
  );
  visit(callback.body, node => {
    if (ts.isIdentifier(node) && isDeclarationName(node) && node.text === name) {
      shadowed = true;
      return;
    }
    if (ts.isIdentifier(node) && node.text === name && !isNonValueIdentifier(node)) reads = true;
  });
  return reads && !shadowed;
}

function findPureDerivedSetter(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  dependencies: ts.ArrayLiteralExpression | null,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
  usageBySetter: ReadonlyMap<string, StateUsage>
): StateCandidate | null {
  if (!dependencies || dependencies.elements.length === 0) return null;
  const statements = ts.isBlock(callback.body)
    ? callback.body.statements
    : [ts.factory.createExpressionStatement(callback.body)];
  if (statements.length !== 1) return null;
  const statement = statements[0];
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return null;
  const call = statement.expression;
  if (!ts.isIdentifier(call.expression) || !stateBySetter.has(call.expression.text) || call.arguments.length !== 1) {
    return null;
  }
  const state = stateBySetter.get(call.expression.text);
  const usage = usageBySetter.get(call.expression.text);
  if (
    !state ||
    !usage ||
    usage.setterCalls !== 1 ||
    usage.setterReferences !== 1 ||
    usage.escaped ||
    usage.shadowed
  ) {
    return null;
  }
  const value = call.arguments[0];
  if (!value || !isPureExpression(value)) return null;
  return state;
}

interface MutationSiteReset {
  sources: readonly StateCandidate[];
  target: StateCandidate;
}

function findMutationSiteReset(
  effect: EffectCandidate,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
  stateByValue: ReadonlyMap<string, StateCandidate>,
  usageBySetter: ReadonlyMap<string, StateUsage>
): MutationSiteReset | null {
  if (
    !effect.callback ||
    !effect.owner ||
    !effect.dependencies ||
    effect.dependencies.elements.length === 0 ||
    isNonProductionHarness(effect.call.getSourceFile().fileName)
  ) {
    return null;
  }
  const sourceNames = effect.dependencies.elements.flatMap(element =>
    ts.isIdentifier(element) ? [element.text] : []
  );
  if (sourceNames.length !== effect.dependencies.elements.length) return null;
  const sources = sourceNames.flatMap(name => {
    const state = stateByValue.get(name);
    return state && state.owner === effect.owner ? [state] : [];
  });
  if (sources.length !== sourceNames.length || new Set(sources).size !== sources.length) return null;

  const setterCall = soleDirectSetterCall(effect.callback, stateBySetter);
  if (!setterCall) return null;
  const target = stateBySetter.get(setterCall.expression.text);
  if (!target || target.owner !== effect.owner || sources.includes(target)) return null;
  const initializer = target.call.arguments[0];
  const reset = setterCall.arguments[0];
  if (!initializer || !reset || !nodesHaveSameText(initializer, reset)) return null;
  const targetUsage = target.setterName ? usageBySetter.get(target.setterName) : undefined;
  if (!targetUsage || targetUsage.setterCalls <= targetUsage.effectWrites) return null;

  for (const source of sources) {
    if (!source.setterName) return null;
    const usage = usageBySetter.get(source.setterName);
    if (
      !usage ||
      usage.shadowed ||
      usage.escaped ||
      usage.effectWrites > 0 ||
      usage.setterReferences === 0 ||
      !allSetterReferencesAreEventBoundaries(source)
    ) {
      return null;
    }
  }
  return { sources, target };
}

function soleDirectSetterCall(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>
): (ts.CallExpression & { expression: ts.Identifier }) | null {
  const expression = ts.isBlock(callback.body)
    ? (() => {
        const statement = callback.body.statements[0];
        return callback.body.statements.length === 1 && statement && ts.isExpressionStatement(statement)
          ? statement.expression
          : null;
      })()
    : callback.body;
  if (
    !expression ||
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    !stateBySetter.has(expression.expression.text) ||
    expression.arguments.length !== 1
  ) {
    return null;
  }
  return expression as ts.CallExpression & { expression: ts.Identifier };
}

function nodesHaveSameText(left: ts.Node, right: ts.Node): boolean {
  return left.getText(left.getSourceFile()) === right.getText(right.getSourceFile());
}

function allSetterReferencesAreEventBoundaries(state: StateCandidate): boolean {
  if (!state.setterName) return false;
  let references = 0;
  let valid = true;
  visit(state.owner.body, node => {
    if (!valid || !ts.isIdentifier(node) || node.text !== state.setterName) return;
    if (node.parent === state.call.parent || isDeclarationName(node)) return;
    references += 1;
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
    if (!attribute) {
      valid = false;
      return;
    }
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      const callback = nearestNestedFunction(node, state.owner);
      if (
        !/^on[A-Z]/.test(attribute.name.getText()) ||
        !callback ||
        !isInsideJsxAttribute(callback, attribute)
      ) {
        valid = false;
      }
      return;
    }
    if (isDirectJsxAttributeExpression(attribute, node)) {
      if (!/^on[A-Z]/.test(attribute.name.getText())) valid = false;
      return;
    }
    const property = findAncestorUntil(node, ts.isPropertyAssignment, attribute);
    if (
      !property ||
      property.initializer !== node ||
      !/^on[A-Z]/.test(property.name.getText())
    ) {
      valid = false;
    }
  });
  return valid && references > 0;
}

function isInsideJsxAttribute(node: ts.Node, attribute: ts.JsxAttribute): boolean {
  return attribute.getStart() <= node.getStart() && node.end <= attribute.end;
}

function isPureExpression(node: ts.Node): boolean {
  let pure = true;
  visit(node, current => {
    if (
      ts.isAwaitExpression(current) ||
      ts.isYieldExpression(current) ||
      ts.isNewExpression(current) ||
      ts.isCallExpression(current) ||
      (ts.isPropertyAccessExpression(current) && current.name.text === "current") ||
      ts.isDeleteExpression(current) ||
      ts.isPostfixUnaryExpression(current) ||
      (ts.isPrefixUnaryExpression(current) &&
        (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isBinaryExpression(current) && isAssignmentOperator(current.operatorToken.kind))
    ) {
      pure = false;
    }
  });
  return pure;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function callbackHasCleanup(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>
): boolean {
  if (!ts.isBlock(callback.body)) {
    if (
      ts.isCallExpression(callback.body) &&
      ts.isIdentifier(callback.body.expression) &&
      stateBySetter.has(callback.body.expression.text)
    ) {
      return false;
    }
    return (
      ts.isArrowFunction(callback.body) ||
      ts.isFunctionExpression(callback.body) ||
      ts.isIdentifier(callback.body) ||
      ts.isPropertyAccessExpression(callback.body) ||
      (ts.isCallExpression(callback.body) && isSubscriptionCall(callback.body))
    );
  }
  return callback.body.statements.some(
    statement => ts.isReturnStatement(statement) && statement.expression !== undefined
  );
}

function isSubscriptionCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return /^(?:subscribe|listen|observe|register)/.test(callee.text);
  if (ts.isPropertyAccessExpression(callee)) {
    return /^(?:subscribe|listen|observe|register|addListener|on[A-Z])/.test(callee.name.text);
  }
  return false;
}

function isCleanupOnly(callback: ts.ArrowFunction | ts.FunctionExpression): boolean {
  if (!ts.isBlock(callback.body)) return ts.isArrowFunction(callback.body) || ts.isFunctionExpression(callback.body);
  if (callback.body.statements.length !== 1) return false;
  const statement = callback.body.statements[0];
  return statement !== undefined && ts.isReturnStatement(statement) && statement.expression !== undefined;
}

function callbackCallsKnownSetter(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>
): boolean {
  let callsSetter = false;
  visit(callback.body, node => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      stateBySetter.has(node.expression.text)
    ) {
      callsSetter = true;
    }
  });
  return callsSetter;
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
  if (action === "review-effect" || action === "review-state" || action === "use-mount") return "candidate";
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

function jsxElementCount(owner: RuntimeFunctionLike): number {
  let count = 0;
  visit(owner.body, node => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) count += 1;
  });
  return count;
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

function isSetOrMapState(call: ts.CallExpression): boolean {
  const type = call.typeArguments?.[0];
  if (type && /^(?:Readonly)?(?:Set|Map)</.test(type.getText())) return true;
  const initial = call.arguments[0];
  if (!initial) return false;
  if (isSetOrMapConstruction(initial)) return true;
  if (ts.isArrowFunction(initial) || ts.isFunctionExpression(initial)) {
    if (ts.isBlock(initial.body)) {
      return initial.body.statements.some(
        statement => ts.isReturnStatement(statement) && !!statement.expression && isSetOrMapConstruction(statement.expression)
      );
    }
    return isSetOrMapConstruction(initial.body);
  }
  return false;
}

function isSetOrMapConstruction(node: ts.Expression): boolean {
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === "Set" || node.expression.text === "Map")
  );
}

function isArrayState(call: ts.CallExpression): boolean {
  const type = call.typeArguments?.[0];
  if (
    type &&
    (ts.isArrayTypeNode(type) ||
      (ts.isTypeReferenceNode(type) &&
        ["Array", "ReadonlyArray"].includes(type.typeName.getText())))
  ) {
    return true;
  }
  const initial = call.arguments[0];
  return initial !== undefined && ts.isArrayLiteralExpression(unwrapTransparentExpression(initial));
}

function localSetAliasForArrayState(state: StateCandidate): ts.VariableDeclaration | null {
  if (!isArrayState(state.call) || !state.owner.body) return null;
  const matches: ts.VariableDeclaration[] = [];
  visitSkippingNestedRuntimeFunctions(state.owner.body, node => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.initializer ||
      !ts.isVariableDeclarationList(node.parent) ||
      (node.parent.flags & ts.NodeFlags.Const) === 0
    ) {
      return;
    }
    const initializer = unwrapTransparentExpression(node.initializer);
    if (
      !ts.isNewExpression(initializer) ||
      !ts.isIdentifier(initializer.expression) ||
      initializer.expression.text !== "Set" ||
      initializer.arguments?.length !== 1
    ) {
      return;
    }
    const source = unwrapTransparentExpression(initializer.arguments[0]!);
    if (ts.isIdentifier(source) && source.text === state.valueName) matches.push(node);
  });
  const match = matches.length === 1 ? matches[0]! : null;
  return match && bindingDeclarationCount(state.owner, match.name.getText()) === 1 ? match : null;
}

function hasIndependentRepeatedEventWrite(
  state: StateCandidate,
  usage: StateUsage | undefined
): boolean {
  if (!state.setterName || !usage) return false;
  return usage.setterCallNodes.some(call => {
    const repeated = nearestRepeatedRenderCall(call, state.owner);
    const event = nearestNestedFunction(call, state.owner);
    if (
      !repeated ||
      !event ||
      event === repeated.arguments[0] ||
      (!ts.isArrowFunction(event) && !ts.isFunctionExpression(event))
    ) {
      return false;
    }
    const expression = event.parent;
    const attribute = ts.isJsxExpression(expression) ? expression.parent : null;
    return !!attribute &&
      ts.isJsxAttribute(attribute) &&
      /^on[A-Z]/.test(attribute.name.getText()) &&
      mutationRegionOnlyCallsStateSetters(event, new Set([state.setterName!]));
  });
}

function isKeyedLeafScalarState(
  state: StateCandidate,
  usage: StateUsage | undefined
): boolean {
  return !!usage &&
    hasDirectPrimitiveInitializer(state) &&
    !stateMayHoldCallable(state) &&
    jsxElementCount(state.owner) >= 12 &&
    usage.directRenderNodes.length > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.transportedOccurrences === 0 &&
    usage.setterCalls > 0 &&
    usage.setterReferences === usage.setterCalls &&
    usage.setterCallNodes.every(call =>
      call.arguments.length === 1 &&
      !!call.arguments[0] &&
      isPureExpression(call.arguments[0])
    ) &&
    (usage.deferredReads === 0 || hasOnlyEventCommandReads(state)) &&
    !usage.shadowed &&
    !usage.escaped &&
    usage.directRenderNodes.every(node => isRepeatedScalarKeyProjection(node, state));
}

function isKeyedScalarWithSecondaryLeaf(
  state: StateCandidate,
  usage: StateUsage | undefined
): boolean {
  if (
    !usage ||
    !hasSupportedKeyedSelectionInitializer(state) ||
    stateMayHoldCallable(state) ||
    jsxElementCount(state.owner) < 12 ||
    usage.directRenderNodes.length === 0 ||
    usage.localRenderReads !== usage.directRenderNodes.length ||
    usage.effectReads > 0 ||
    usage.effectWrites > 0 ||
    usage.transportedOccurrences > 0 ||
    usage.setterCalls === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.setterCallNodes.some(call =>
      call.arguments.length !== 1 ||
      !call.arguments[0] ||
      !isPureExpression(call.arguments[0])
    ) ||
    usage.shadowed ||
    usage.escaped ||
    !hasOnlyEventCommandReads(state, new Set(usage.directRenderNodes))
  ) {
    return false;
  }

  const producer = repeatedScalarSelectionProducer(state, usage);
  if (!producer) return false;

  const secondaryNodes: ts.Node[] = [];
  for (const node of usage.directRenderNodes) {
    if (isRepeatedScalarKeyProjection(node, state)) {
      if (nearestRepeatedRenderCall(node, state.owner) !== producer) return false;
      continue;
    }
    secondaryNodes.push(node);
  }
  const secondaryReferences = oneHopRenderProjectionReferences(
    state.owner,
    secondaryNodes,
    (initializer, reference) =>
      isPureExpression(initializer) ||
      (ts.isIdentifier(reference) && isSelectedItemLookup(initializer, reference))
  );
  if (!secondaryReferences) return false;

  const renderReferences: ts.Identifier[] = [];
  for (const reference of secondaryReferences) {
    const callback = nearestNestedFunction(reference, state.owner);
    if (callback) {
      if (
        (ts.isArrowFunction(callback) ||
          ts.isFunctionDeclaration(callback) ||
          ts.isFunctionExpression(callback)) &&
        callbackIsEventRooted(callback, state.owner, reference.text, new Set())
      ) {
        continue;
      }
      return false;
    }
    if (findAncestorUntil(reference, isJsxNode, state.owner)) {
      if (
        nearestRepeatedRenderCall(reference, state.owner) ||
        (isRenderGateReference(reference, state.owner) &&
          !findAncestorUntil(reference, ts.isJsxAttribute, state.owner)) ||
        !isSafeJsxProjectionReference(reference, state.owner, new Set(["cn"]))
      ) {
        return false;
      }
      renderReferences.push(reference);
      continue;
    }
    if (isHookDependencyReference(reference, new Set(["useCallback"]))) {
      const call = findAncestorUntil(reference, ts.isCallExpression, state.owner);
      const candidate = call?.arguments[0];
      if (
        candidate &&
        (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) &&
        callbackIsEventRooted(candidate, state.owner, reference.text, new Set())
      ) {
        continue;
      }
    }
    return false;
  }

  const consumer = lowestCommonJsxSubtree(renderReferences, state.owner);
  const producerReturn = findAncestorUntil(producer, ts.isReturnStatement, state.owner);
  const consumerReturn = consumer
    ? findAncestorUntil(consumer, ts.isReturnStatement, state.owner)
    : null;
  return !!consumer &&
    jsxElementCountIn(consumer) / jsxElementCount(state.owner) <= 0.4 &&
    producerReturn !== null &&
    producerReturn === consumerReturn &&
    !nodeWithin(producer, consumer) &&
    !nodeWithin(consumer, producer);
}

function hasSupportedKeyedSelectionInitializer(state: StateCandidate): boolean {
  if (hasDirectPrimitiveInitializer(state)) return true;
  if (state.call.arguments.length !== 0) return false;
  const type = state.call.typeArguments?.[0];
  return !!type && primitiveScalarType(type);
}

function primitiveScalarType(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type)) {
    return primitiveScalarType(type.type);
  }
  if (ts.isUnionTypeNode(type)) return type.types.every(primitiveScalarType);
  if (ts.isLiteralTypeNode(type)) return true;
  return [
    ts.SyntaxKind.StringKeyword,
    ts.SyntaxKind.NumberKeyword,
    ts.SyntaxKind.BooleanKeyword,
    ts.SyntaxKind.BigIntKeyword,
    ts.SyntaxKind.NullKeyword,
    ts.SyntaxKind.UndefinedKeyword,
  ].includes(type.kind);
}

function repeatedScalarSelectionProducer(
  state: StateCandidate,
  usage: StateUsage
): ts.CallExpression | null {
  if (!state.setterName) return null;
  const producers = new Set<ts.CallExpression>();
  for (const call of usage.setterCallNodes) {
    const repeated = nearestRepeatedRenderCall(call, state.owner);
    const callback = repeated?.arguments[0];
    const event = nearestNestedFunction(call, state.owner);
    const argument = call.arguments[0];
    if (
      !repeated ||
      !callback ||
      (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
      !event ||
      event === callback ||
      (!ts.isArrowFunction(event) && !ts.isFunctionExpression(event)) ||
      !argument ||
      !callback.parameters.some(parameter =>
        expressionDependsOnBinding(argument, parameter.name, callback)
      ) ||
      !repeatedRenderHasStableItemKey(callback) ||
      !isInsideJsxEventCallback(call, state.owner) ||
      !mutationRegionOnlyCallsStateSetters(event, new Set([state.setterName]))
    ) {
      continue;
    }
    producers.add(repeated);
  }
  return producers.size === 1 ? [...producers][0]! : null;
}

function isSelectedItemLookup(
  initializer: ts.Expression,
  stateReference: ts.Identifier
): boolean {
  let expression = unwrapTransparentExpression(initializer);
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    unwrapTransparentExpression(expression.right).kind === ts.SyntaxKind.NullKeyword
  ) {
    expression = unwrapTransparentExpression(expression.left);
  }
  if (
    !ts.isCallExpression(expression) ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.name.text !== "find" ||
    expression.arguments.length !== 1
  ) {
    return false;
  }
  const callback = expression.arguments[0];
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    ts.isBlock(callback.body) ||
    callback.parameters.length !== 1
  ) {
    return false;
  }
  const comparison = unwrapTransparentExpression(callback.body);
  if (
    !ts.isBinaryExpression(comparison) ||
    comparison.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return false;
  }
  const left = unwrapTransparentExpression(comparison.left);
  const right = unwrapTransparentExpression(comparison.right);
  const other = left === stateReference
    ? right
    : right === stateReference
      ? left
      : null;
  if (
    !other ||
    !expressionDependsOnBinding(other, callback.parameters[0]!.name, callback)
  ) {
    return false;
  }
  let stateReads = 0;
  visit(initializer, node => {
    if (
      ts.isIdentifier(node) &&
      node.text === stateReference.text &&
      !isNonValueIdentifier(node)
    ) {
      stateReads += 1;
    }
  });
  return stateReads === 1;
}

function isRepeatedScalarKeyProjection(
  node: ts.Node,
  state: StateCandidate
): boolean {
  if (!ts.isIdentifier(node)) return false;
  const repeated = nearestRepeatedRenderCall(node, state.owner);
  const callback = repeated?.arguments[0];
  if (
    !repeated ||
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    nearestNestedFunction(node, state.owner) !== callback ||
    !repeatedRenderHasStableItemKey(callback) ||
    !scalarComparisonUsesRepeatedKey(node, callback)
  ) {
    return false;
  }

  const declaration = findAncestorUntil(node, ts.isVariableDeclaration, callback);
  if (
    declaration?.initializer &&
    ts.isIdentifier(declaration.name) &&
    nodeWithin(node, declaration.initializer)
  ) {
    if (
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
      bindingDeclarationCount(callback, declaration.name.text) !== 1
    ) {
      return false;
    }
    const references: ts.Identifier[] = [];
    visit(callback.body, reference => {
      if (
        ts.isIdentifier(reference) &&
        reference.text === declaration.name.getText() &&
        reference !== declaration.name &&
        !isDeclarationName(reference) &&
        !isNonValueIdentifier(reference)
      ) {
        references.push(reference);
      }
    });
    return references.length > 0 && references.every(reference =>
      nearestRepeatedRenderCall(reference, state.owner) === repeated &&
      !isMembershipMountGate(reference, callback) &&
      !!findAncestorUntil(reference, isJsxNode, callback) &&
      isSafeJsxProjectionReference(reference, callback, new Set(["cn"]))
    );
  }

  return !isMembershipMountGate(node, callback) &&
    !!findAncestorUntil(node, isJsxNode, callback) &&
    isSafeJsxProjectionReference(node, callback, new Set(["cn"]));
}

function scalarComparisonUsesRepeatedKey(
  node: ts.Identifier,
  callback: ts.ArrowFunction | ts.FunctionExpression
): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== callback; current = current.parent) {
    if (
      !ts.isBinaryExpression(current) ||
      ![
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(current.operatorToken.kind)
    ) {
      continue;
    }
    const other = nodeWithin(node, current.left)
      ? current.right
      : nodeWithin(node, current.right)
        ? current.left
        : null;
    if (
      other &&
      callback.parameters.some(parameter =>
        expressionDependsOnBinding(other, parameter.name, callback)
      )
    ) {
      return true;
    }
  }
  return false;
}

const KEYED_COLLECTION_PROPERTIES = new Set(["entries", "has", "keys", "size", "values"]);

function isKeyedLeafCollectionState(
  state: StateCandidate,
  usage: StateUsage | undefined
): boolean {
  if (
    !usage ||
    !isKeyedCollectionName(state.valueName) ||
    usage.effectReads > 0
  ) {
    return false;
  }

  const directCollection = isSetOrMapState(state.call);
  const arraySetAlias = directCollection ? null : localSetAliasForArrayState(state);
  if ((!directCollection && !arraySetAlias) || jsxElementCount(state.owner) < 12) return false;
  const aliasName = arraySetAlias?.name.getText() ?? null;

  let repeatedMembership = false;
  let unsafe = false;
  visit(state.owner.body, node => {
    if (
      unsafe ||
      !ts.isIdentifier(node) ||
      (node.text !== state.valueName && node.text !== aliasName)
    ) {
      return;
    }
    if (isDeclarationName(node) || isNonValueIdentifier(node)) return;
    if (arraySetAlias && node.text === state.valueName && nodeWithin(node, arraySetAlias.initializer!)) {
      return;
    }
    const property = ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
      ? node.parent
      : null;
    if (arraySetAlias && node.text === state.valueName) {
      if (property?.name.text === "length") {
        if (collectionSummaryControlsRepeatedRendering(property, state.owner)) unsafe = true;
        return;
      }
      if (isDeferredCollectionRead(node, state.owner)) return;
      if (isHookDependencyReference(node, MEMO_CALLBACK_HOOKS)) return;
      if (isListExtraDataReference(node, state.owner)) return;
      unsafe = true;
      return;
    }
    if (property && KEYED_COLLECTION_PROPERTIES.has(property.name.text)) {
      if (property.name.text === "size") {
        if (collectionSummaryControlsRepeatedRendering(property, state.owner)) unsafe = true;
        return;
      }
      if (["entries", "keys", "values"].includes(property.name.text)) return;
      if (
        property.name.text !== "has" ||
        !ts.isCallExpression(property.parent) ||
        property.parent.expression !== property ||
        !isRepeatedMembershipRender(property.parent, state.owner)
      ) {
        unsafe = true;
        return;
      }
      if (membershipControlsRepeatedMount(property.parent, state.owner)) unsafe = true;
      else repeatedMembership = true;
      return;
    }
    if (ts.isSpreadElement(node.parent)) return;
    if (isCollectionCopyArgument(node) && isDeferredCollectionRead(node, state.owner)) return;
    if (isHookDependencyReference(node, MEMO_CALLBACK_HOOKS)) return;
    if (isListExtraDataReference(node, state.owner)) return;
    unsafe = true;
  });
  return repeatedMembership && !unsafe;
}

function collectionSummaryControlsRepeatedRendering(
  summary: ts.PropertyAccessExpression,
  owner: RuntimeFunctionLike
): boolean {
  if (!owner.body) return true;
  if (nearestRepeatedRenderCall(summary, owner)) return true;
  const declaration = findAncestorUntil(summary, ts.isVariableDeclaration, owner);
  if (
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    !nodeWithin(summary, declaration.initializer)
  ) {
    return referenceControlsRepeatedRendering(summary, owner);
  }
  if (bindingDeclarationCount(owner, declaration.name.text) !== 1) return true;
  const references: ts.Identifier[] = [];
  visit(owner.body, node => {
    if (
      ts.isIdentifier(node) &&
      node.text === declaration.name.getText() &&
      node !== declaration.name &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references.some(reference => referenceControlsRepeatedRendering(reference, owner));
}

function referenceControlsRepeatedRendering(node: ts.Node, owner: RuntimeFunctionLike): boolean {
  const repeated = nearestRepeatedRenderCall(node, owner);
  if (repeated) {
    const callback = repeated.arguments[0];
    if (
      callback &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      summaryFeedsStableRowProjection(node, callback)
    ) {
      return false;
    }
    return true;
  }
  for (let current: ts.Node | undefined = node.parent; current && current !== owner; current = current.parent) {
    if (
      (ts.isBinaryExpression(current) &&
        nodeWithin(node, current.left) &&
        containsRepeatedRender(current.right)) ||
      (ts.isConditionalExpression(current) &&
        nodeWithin(node, current.condition) &&
        (containsRepeatedRender(current.whenTrue) ||
          containsRepeatedRender(current.whenFalse))) ||
      (ts.isIfStatement(current) &&
        nodeWithin(node, current.expression) &&
        (containsRepeatedRender(current.thenStatement) ||
          (!!current.elseStatement && containsRepeatedRender(current.elseStatement))))
    ) {
      return true;
    }
  }
  return false;
}

function summaryFeedsStableRowProjection(
  summaryReference: ts.Node,
  callback: ts.ArrowFunction | ts.FunctionExpression
): boolean {
  const declaration = findAncestorUntil(summaryReference, ts.isVariableDeclaration, callback);
  if (
    !declaration?.initializer ||
    !ts.isIdentifier(declaration.name) ||
    !nodeWithin(summaryReference, declaration.initializer) ||
    !isSafeProjectionExpression(declaration.initializer, summaryReference)
  ) {
    return false;
  }
  const projectionName = declaration.name.text;
  const references: ts.Identifier[] = [];
  visitSkippingNestedFunctions(callback.body, callback, node => {
    if (
      ts.isIdentifier(node) &&
      node.text === projectionName &&
      node !== declaration.name &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references.length > 0 && references.every(reference =>
    !isMembershipMountGate(reference, callback) &&
    !!findAncestorUntil(reference, isJsxNode, callback) &&
    isSafeJsxProjectionReference(reference, callback, new Set(["cn"]))
  );
}

function containsRepeatedRender(root: ts.Node): boolean {
  let found = false;
  visitSkippingNestedRuntimeFunctions(root, node => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["map", "flatMap"].includes(node.expression.name.text)
    ) {
      found = true;
    }
  });
  return found;
}

function isDeferredCollectionRead(node: ts.Identifier, owner: RuntimeFunctionLike): boolean {
  const callback = nearestNestedFunction(node, owner);
  if (!callback || isSynchronousRenderCallback(callback) || renderedListCallback(node, owner)) return false;
  const attribute = findAncestorUntil(callback, ts.isJsxAttribute, owner);
  return !attribute || /^on[A-Z]/.test(attribute.name.getText());
}

function isRepeatedMembershipRender(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const repeated = nearestRepeatedRenderCall(call, owner);
  const callback = repeated?.arguments[0] ?? renderedListCallback(call, owner);
  return !!callback &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    membershipUsesCallbackKey(call, callback) &&
    (!repeated || repeatedRenderHasStableItemKey(callback));
}

function membershipUsesCallbackKey(
  call: ts.CallExpression,
  callback: ts.ArrowFunction | ts.FunctionExpression
): boolean {
  const argument = call.arguments[0];
  const parameter = callback.parameters[0]?.name;
  if (!argument || !parameter) return false;
  return expressionDependsOnBinding(argument, parameter, callback);
}

function repeatedRenderHasStableItemKey(
  callback: ts.ArrowFunction | ts.FunctionExpression
): boolean {
  const parameter = callback.parameters[0]?.name;
  if (!parameter) return false;
  let stable = false;
  visitSkippingNestedRuntimeFunctions(callback.body, node => {
    if (!ts.isJsxAttribute(node) || node.name.getText() !== "key" || !node.initializer) return;
    const expression = ts.isJsxExpression(node.initializer) ? node.initializer.expression : null;
    if (!expression) return;
    if (expressionDependsOnBinding(expression, parameter, callback)) stable = true;
  });
  return stable;
}

function expressionDependsOnBinding(
  expression: ts.Expression,
  binding: ts.BindingName,
  boundary: ts.Node
): boolean {
  let found = false;
  visit(expression, node => {
    if (!ts.isIdentifier(node)) return;
    if (bindingContainsName(binding, node.text)) {
      found = true;
      return;
    }
    const declaration = uniqueVariableDeclaration(boundary, node.text);
    if (declaration?.initializer && expressionDependsOnBinding(declaration.initializer, binding, declaration)) {
      found = true;
    }
  });
  return found;
}

function bindingContainsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    element => ts.isBindingElement(element) && bindingContainsName(element.name, name)
  );
}

function uniqueVariableDeclaration(boundary: ts.Node, name: string): ts.VariableDeclaration | null {
  const matches: ts.VariableDeclaration[] = [];
  visitSkippingNestedRuntimeFunctions(boundary, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) matches.push(node);
  });
  return matches.length === 1 ? matches[0]! : null;
}

function renderedListCallback(
  node: ts.Node,
  owner: RuntimeFunctionLike
): ts.ArrowFunction | ts.FunctionExpression | null {
  const callback = nearestNestedFunction(node, owner);
  if (!callback) return null;
  const initializer = callback.parent;
  const declaration = ts.isCallExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      initializer.expression.text === "useCallback"
    ? initializer.parent
    : callback.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return null;
  const bindingName = declaration.name.text;
  let rendered = false;
  visit(owner.body, current => {
    if (
      ts.isIdentifier(current) &&
      current.text === bindingName &&
      isListRenderAttributeReference(current)
    ) {
      rendered = true;
    }
  });
  return rendered ? callback as ts.ArrowFunction | ts.FunctionExpression : null;
}

function isListRenderAttributeReference(node: ts.Identifier): boolean {
  const expression = node.parent;
  if (!ts.isJsxExpression(expression) || expression.expression !== node) return false;
  const attribute = expression.parent;
  return ts.isJsxAttribute(attribute) && attribute.name.getText() === "renderItem";
}

function isListExtraDataReference(node: ts.Identifier, owner: RuntimeFunctionLike): boolean {
  const expression = node.parent;
  if (!ts.isJsxExpression(expression) || expression.expression !== node) return false;
  const attribute = expression.parent;
  return ts.isJsxAttribute(attribute) &&
    attribute.name.getText() === "extraData" &&
    isInsideOwner(attribute, owner);
}

function isInsideOwner(node: ts.Node, owner: RuntimeFunctionLike): boolean {
  return node.getStart() >= owner.getStart() && node.end <= owner.end;
}

function isKeyedCollectionName(name: string): boolean {
  return /(?:selected|selection|added|checked|chosen|open|expanded|requested)/i.test(name) &&
    !/(?:mounted|failed|loaded|requestedAt)/i.test(name);
}

function isCollectionCopyArgument(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.includes(node) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    ts.isIdentifier(parent.expression.expression) &&
    parent.expression.expression.text === "Array" &&
    parent.expression.name.text === "from"
  ) {
    return true;
  }
  return (
    ts.isNewExpression(parent) &&
    parent.arguments?.includes(node) === true &&
    ts.isIdentifier(parent.expression) &&
    (parent.expression.text === "Set" || parent.expression.text === "Map")
  );
}

const MEMO_CALLBACK_HOOKS = new Set(["useCallback", "useMemo"]);

function isHookDependencyReference(
  node: ts.Identifier,
  hookNames: ReadonlySet<string>
): boolean {
  const array = node.parent;
  if (!ts.isArrayLiteralExpression(array) || !array.elements.includes(node)) return false;
  const call = array.parent;
  return ts.isCallExpression(call) &&
    call.arguments[1] === array &&
    ts.isIdentifier(call.expression) &&
    hookNames.has(call.expression.text);
}

function membershipControlsRepeatedMount(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const repeated = nearestRepeatedRenderCall(call, owner);
  const callback = repeated?.arguments[0] ?? renderedListCallback(call, owner);
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return true;
  const declaration = findAncestorUntil(call, ts.isVariableDeclaration, callback);
  if (
    declaration &&
    ts.isIdentifier(declaration.name) &&
    declaration.initializer &&
    nodeWithin(call, declaration.initializer)
  ) {
    const aliasName = declaration.name.text;
    const references: ts.Identifier[] = [];
    visitSkippingNestedFunctions(callback.body, callback, node => {
      if (
        ts.isIdentifier(node) &&
        node.text === aliasName &&
        node !== declaration.name &&
        !isNonValueIdentifier(node)
      ) {
        references.push(node);
      }
    });
    return references.length > 0 && references.every(reference => isMembershipMountGate(reference, callback));
  }
  return isMembershipMountGate(call, callback);
}

function isMembershipMountGate(node: ts.Node, callback: RuntimeFunctionLike): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== callback; current = current.parent) {
    if (
      (ts.isIfStatement(current) &&
        nodeWithin(node, current.expression) &&
        statementContainsReturn(current.thenStatement)) ||
      (ts.isConditionalExpression(current) &&
        nodeWithin(node, current.condition) &&
        !findAncestorUntil(current, ts.isJsxAttribute, callback) &&
        (expressionIsNullish(current.whenTrue) || expressionIsNullish(current.whenFalse))) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
        nodeWithin(node, current.left) &&
        expressionContainsJsx(current.right))
    ) {
      return true;
    }
  }
  return false;
}

function statementContainsReturn(statement: ts.Statement): boolean {
  let found = false;
  visitSkippingNestedRuntimeFunctions(statement, node => {
    if (ts.isReturnStatement(node)) found = true;
  });
  return found;
}

function expressionIsNullish(expression: ts.Expression): boolean {
  return expression.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expression) && expression.text === "undefined");
}

function isSelectionStateName(name: string): boolean {
  return /(?:selected|selection|added|checked)/i.test(name);
}

function setterCallUsesPreviousValue(call: ts.CallExpression): boolean {
  const argument = call.arguments[0];
  if (!argument || (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument))) return false;
  const parameter = argument.parameters[0];
  if (!parameter || !ts.isIdentifier(parameter.name)) return false;
  const parameterName = parameter.name.text;
  let referenced = false;
  visit(argument.body, node => {
    if (ts.isIdentifier(node) && node.text === parameterName && node !== parameter.name) referenced = true;
  });
  return referenced;
}

function jsxTargetName(attribute: ts.JsxAttribute): string | null {
  const properties = attribute.parent;
  const opening = properties.parent;
  if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) return null;
  return opening.tagName.getText();
}

function isDirectJsxAttributeExpression(attribute: ts.JsxAttribute, node: ts.Identifier): boolean {
  const initializer = attribute.initializer;
  return initializer !== undefined &&
    ts.isJsxExpression(initializer) &&
    initializer.expression !== undefined &&
    unwrapTransparentExpression(initializer.expression) === node;
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

function isInsideJsxEventCallback(node: ts.Node, boundary: RuntimeFunctionLike): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== boundary; current = current.parent) {
    if (!isRuntimeFunctionLike(current)) continue;
    const attribute = findAncestorUntil(current, ts.isJsxAttribute, boundary);
    if (
      attribute &&
      isInsideJsxAttribute(current, attribute) &&
      /^on[A-Z]/.test(attribute.name.getText())
    ) {
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

function isSynchronousRenderCallback(node: ts.FunctionLikeDeclaration): boolean {
  const parent = node.parent;
  if (!ts.isCallExpression(parent)) return false;
  if (ts.isIdentifier(parent.expression) && parent.expression.text === "useMemo") return true;
  return (
    ts.isPropertyAccessExpression(parent.expression) &&
    ["every", "filter", "find", "findIndex", "flatMap", "map", "reduce", "reduceRight", "some"].includes(
      parent.expression.name.text
    )
  );
}

function isDirectArgumentToUnknownCall(node: ts.Identifier): boolean {
  const parent = node.parent;
  return ts.isCallExpression(parent) && parent.expression !== node && parent.arguments.includes(node);
}

function isOriginalStateBinding(node: ts.Identifier, call: ts.CallExpression): boolean {
  const declaration = call.parent;
  return ts.isVariableDeclaration(declaration) && declaration.name.getStart() <= node.getStart() && node.end <= declaration.name.end;
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionExpression(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node)
  );
}

function isNonValueIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isJsxAttribute(parent) && parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node && !ts.isComputedPropertyName(parent.name)) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.propertyName === node) ||
    (ts.isExportSpecifier(parent) && parent.propertyName === node)
  );
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

function isJsxNode(
  node: ts.Node
): node is ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxExpression | ts.JsxAttribute | ts.JsxFragment {
  return (
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxExpression(node) ||
    ts.isJsxAttribute(node) ||
    ts.isJsxFragment(node)
  );
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
