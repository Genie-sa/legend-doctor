import type { EffectCandidate, StateCandidate, StateUsage } from "../analyze-source.js";
import {
  bindingDeclarationCount,
  hookCallName,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
} from "../analysis-ast.js";
import {
  callbackIsEventRooted,
  expressionDependsOnBinding,
  isJsxNode,
  isSafeJsxProjectionReference,
  isSynchronousRenderCallback,
  jsxElementCount,
  jsxElementCountIn,
  localFunctionBinding,
  lowestCommonJsxSubtree,
  nearestRepeatedRenderCall,
  repeatedRenderHasStableItemKey,
  stateMayHoldCallable,
  uniqueVariableDeclaration,
} from "./state-proofs.js";
import {
  findAncestorUntil,
  nearestNestedFunction,
  nodeWithin,
  visit,
  visitSkippingNestedFunctions,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import type { RenderCutWitnessQuery } from "./state-proofs.js";
import type { RuntimeFunctionLike } from "../ast.js";
import { callbackHasCleanup } from "./effects.js";
import ts from "typescript";

export interface EffectDraftScope {
  bySetter: ReadonlyMap<string, StateCandidate>;
}

export interface EffectDraftCluster {
  action: "use-observable";
  id: string;
  members: readonly StateCandidate[];
  message: string;
  primary: StateCandidate;
}

export interface EffectDraftAnalysis {
  clusters: ReadonlyMap<StateCandidate, EffectDraftCluster>;
  effects: ReadonlySet<EffectCandidate>;
  singletons: ReadonlySet<StateCandidate>;
}

type JsxSubtreeNode = ts.JsxElement | ts.JsxFragment | ts.JsxSelfClosingElement;

interface DirectReturnCallSite {
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  returned: ts.Expression;
}

/**
 * Shared structural proofs owned by the analyzer rather than this rule family.
 * Keeping them explicit prevents effect-draft logic from depending on application
 * names or path-specific exceptions while avoiding duplicate AST algorithms.
 */
export interface EffectDraftProofs {
  directUniqueReturnCallSite: (
    usage: StateUsage,
    owner: RuntimeFunctionLike,
  ) => DirectReturnCallSite | null;
  hasIndependentRenderCutWitness: (query: RenderCutWitnessQuery) => boolean;
  isCustomHookOwner: (owner: RuntimeFunctionLike) => boolean;
  nearestMutationFunction: (node: ts.Node, owner: RuntimeFunctionLike) => RuntimeFunctionLike;
  setterMutationsCanCooccur: (
    left: ts.CallExpression,
    right: ts.CallExpression,
    region: RuntimeFunctionLike,
  ) => boolean;
  uniqueReturnedExpression: (owner: RuntimeFunctionLike) => ts.Expression | null;
}

/** Inputs shared by every effect the draft search visits. */
interface DraftContext {
  effects: readonly EffectCandidate[];
  localComponents: ReadonlySet<string>;
  proofs: EffectDraftProofs;
  siblingRenderCuts: ReadonlyMap<StateCandidate, unknown>;
  sourceComponents: ReadonlySet<string>;
  states: readonly StateCandidate[];
  usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

interface DraftEffect {
  callback: ts.ArrowFunction | ts.FunctionExpression;
  context: DraftContext;
  effect: EffectCandidate;
  owner: RuntimeFunctionLike;
}

interface DraftMatch {
  draft: DraftEffect;
  members: readonly StateCandidate[];
}

interface DraftSynchronization {
  clusters: Map<StateCandidate, EffectDraftCluster>;
  effects: Set<EffectCandidate>;
  singletons: Set<StateCandidate>;
}

interface SetterMutation {
  call: ts.CallExpression;
  region: RuntimeFunctionLike;
  state: StateCandidate;
}

const MIN_OWNER_JSX = 12;
const MAX_CUT_SHARE = 0.4;

export interface EffectDraftSearch {
  readonly effects: readonly EffectCandidate[];
  readonly localComponents: ReadonlySet<string>;
  readonly proofs: EffectDraftProofs;
  readonly scopes: ReadonlyMap<RuntimeFunctionLike, EffectDraftScope>;
  readonly siblingRenderCuts: ReadonlyMap<StateCandidate, unknown>;
  readonly sourceComponents: ReadonlySet<string>;
  readonly states: readonly StateCandidate[];
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

export function findEffectSynchronizedDrafts({
  effects,
  localComponents,
  proofs,
  scopes,
  siblingRenderCuts,
  sourceComponents,
  states,
  usageByState,
}: EffectDraftSearch): EffectDraftAnalysis {
  const context: DraftContext = {
    effects,
    localComponents,
    proofs,
    siblingRenderCuts,
    sourceComponents,
    states,
    usageByState,
  };
  const analysis: DraftSynchronization = {
    clusters: new Map(),
    effects: new Set(),
    singletons: new Set(),
  };
  for (const effect of effects) {
    const match = synchronizedDraftMatch(effect, scopes, context);
    if (match) {
      recordDraftCluster(analysis, match);
    }
  }
  return {
    clusters: analysis.clusters,
    effects: analysis.effects,
    singletons: analysis.singletons,
  };
}

function synchronizedDraftMatch(
  effect: EffectCandidate,
  scopes: ReadonlyMap<RuntimeFunctionLike, EffectDraftScope>,
  context: DraftContext,
): DraftMatch | null {
  const { callback, dependencies, owner } = effect;
  if (!owner || !callback || !dependencies || dependencies.elements.length === 0) {
    return null;
  }
  const scope = scopes.get(owner);
  const members = scope ? synchronousDraftSetters(callback, scope.bySetter) : null;
  if (!members || members.length === 0 || context.proofs.isCustomHookOwner(owner)) {
    return null;
  }
  const draft: DraftEffect = { callback, context, effect, owner };
  return isCompleteDraftCluster(draft, members) ? { draft, members } : null;
}

function isCompleteDraftCluster(draft: DraftEffect, members: readonly StateCandidate[]): boolean {
  const ownerSetters = new Set(
    draft.context.states.flatMap((state) =>
      state.owner === draft.owner && state.setterName ? [state.setterName] : [],
    ),
  );
  const editProofs = members.map((state) => draftEditProof(state, draft, ownerSetters));
  if (
    !members.every((state) => isCompleteDraftMember(state, draft)) ||
    !editProofs.every((proof) => proof.reachable) ||
    !editProofs.some((proof) => proof.independent)
  ) {
    return false;
  }
  return !hasExternalCompanionWrites(draft, members) && hasDraftRenderCut(draft, members);
}

function isCompleteDraftMember(state: StateCandidate, draft: DraftEffect): boolean {
  const usage = draft.context.usageByState.get(state);
  return (
    usage !== undefined &&
    stateIsWrittenOnlyByEffect(usage, draft.effect, draft.context.effects) &&
    usage.setterReferences > usage.effectWrites &&
    usage.effectReads === 0 &&
    !hasStaleUseCallbackCapture(state) &&
    usage.localRenderReads + usage.transportedOccurrences > 0 &&
    !usage.shadowed &&
    !usage.escaped &&
    !stateMayHoldCallable(state) &&
    !stateControlsHookOrRepeatedBoundary(state)
  );
}

function recordDraftCluster(analysis: DraftSynchronization, match: DraftMatch): void {
  analysis.effects.add(match.draft.effect);
  const ordered = [...match.members].toSorted(
    (left, right) => left.call.getStart() - right.call.getStart(),
  );
  if (ordered.length === 1) {
    analysis.singletons.add(ordered[0]!);
    return;
  }
  const cluster = draftCluster(match.draft, ordered);
  for (const state of ordered) {
    analysis.clusters.set(state, cluster);
  }
}

function draftCluster(draft: DraftEffect, ordered: readonly StateCandidate[]): EffectDraftCluster {
  const names = ordered.map((state) => `\`${state.valueName}\``).join(", ");
  const initialization = ordered.some((state) => hasLazyStateInitializer(state))
    ? " Preserve every lazy initializer as a once-only owner snapshot; do not pass it to Legend as a computed function."
    : "";
  return {
    action: "use-observable",
    id: `state-cluster:effect-draft:${draft.owner.getStart()}:${draft.effect.call.getStart()}`,
    members: ordered,
    message: `Replace the effect-synchronized React draft cluster (${names}) with one component-lifetime observable model; preserve the React synchronization effect and its dependencies, assign the draft atomically there, mutate from edit commands, snapshot once at command entry before deferred work, and subscribe only in rendered leaves.${initialization}`,
    primary: ordered[0]!,
  };
}

export function hasLazyStateInitializer(state: StateCandidate): boolean {
  const [initializer] = state.call.arguments;
  return (
    initializer !== undefined &&
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
  );
}

interface DraftEditProof {
  readonly independent: boolean;
  readonly reachable: boolean;
}

function draftEditProof(
  state: StateCandidate,
  draft: DraftEffect,
  ownerSetters: ReadonlySet<string>,
): DraftEditProof {
  const usage = draft.context.usageByState.get(state);
  if (!usage) {
    return { independent: false, reachable: false };
  }
  const direct = hasDirectJsxEventSetter(state);
  const edits = usage.setterCallNodes.filter((call) => !nodeWithin(call, draft.effect.call));
  const reachable = edits.filter((call) =>
    isEventRootedEditRegion(call, state, draft.context.proofs),
  );
  const independent =
    direct || reachable.some((call) => isIndependentEdit(call, state, { draft, ownerSetters }));
  return { independent, reachable: direct || reachable.length > 0 };
}

function isEventRootedEditRegion(
  call: ts.CallExpression,
  state: StateCandidate,
  proofs: EffectDraftProofs,
): boolean {
  const region = proofs.nearestMutationFunction(call, state.owner);
  return (
    region !== state.owner &&
    (ts.isArrowFunction(region) ||
      ts.isFunctionDeclaration(region) ||
      ts.isFunctionExpression(region)) &&
    callbackIsEventRooted({
      callback: region,
      owner: state.owner,
      dependencyName: "",
      seen: new Set(),
    })
  );
}

function isIndependentEdit(
  call: ts.CallExpression,
  state: StateCandidate,
  scope: { draft: DraftEffect; ownerSetters: ReadonlySet<string> },
): boolean {
  const region = scope.draft.context.proofs.nearestMutationFunction(call, state.owner);
  return (
    (mutationRegionOnlyCallsStateSetters(region, scope.ownerSetters) ||
      mutationRegionForwardsDraftValue(region, call, {
        owner: state.owner,
        stateSetters: scope.ownerSetters,
      })) &&
    setterArgumentDiffersFromEffect(call, state, scope.draft.effect)
  );
}

function stateIsWrittenOnlyByEffect(
  usage: StateUsage,
  target: EffectCandidate,
  effects: readonly EffectCandidate[],
): boolean {
  const effectWrites = usage.setterCallNodes.filter((call) =>
    effects.some((effect) => nodeWithin(call, effect.call)),
  );
  return effectWrites.length > 0 && effectWrites.every((call) => nodeWithin(call, target.call));
}

function setterArgumentDiffersFromEffect(
  edit: ts.CallExpression,
  state: StateCandidate,
  effect: EffectCandidate,
): boolean {
  const [argument] = edit.arguments;
  if (!argument || !state.setterName) {
    return false;
  }
  if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
    return true;
  }
  const effectArguments: string[] = [];
  visitSkippingNestedFunctions(effect.callback!.body, effect.callback!, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === state.setterName &&
      node.arguments[0]
    ) {
      effectArguments.push(node.arguments[0].getText());
    }
  });
  return effectArguments.every((effectArgument) => effectArgument !== argument.getText());
}

function hasDirectJsxEventSetter(state: StateCandidate): boolean {
  if (!state.setterName) {
    return false;
  }
  let found = false;
  visit(state.owner.body, (node) => {
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
      /^(?:onChange|onChangeText|onSelect|onValueChange|onCheckedChange)$/u.test(
        attribute.name.getText(),
      ) &&
      isDirectJsxAttributeExpression(attribute, node)
    ) {
      found = true;
    }
  });
  return found;
}

export function mutationRegionOnlyCallsStateSetters(
  region: RuntimeFunctionLike,
  stateSetters: ReadonlySet<string>,
): boolean {
  if (!region.body) {
    return false;
  }
  let sawSetter = false;
  let unsafeCall = false;
  visitSkippingNestedFunctions(region.body, region, (node) => {
    if (unsafeCall || !ts.isCallExpression(node)) {
      return;
    }
    if (ts.isIdentifier(node.expression) && stateSetters.has(node.expression.text)) {
      sawSetter = true;
      return;
    }
    unsafeCall = true;
  });
  return sawSetter && !unsafeCall;
}

function mutationRegionForwardsDraftValue(
  region: RuntimeFunctionLike,
  edit: ts.CallExpression,
  scope: { owner: RuntimeFunctionLike; stateSetters: ReadonlySet<string> },
): boolean {
  const [argument] = edit.arguments;
  if (!region.body || !argument || !ts.isIdentifier(argument)) {
    return false;
  }
  const declaration = uniqueVariableDeclaration(region, argument.text);
  if (
    !declaration?.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    declaration.getStart() >= edit.getStart()
  ) {
    return false;
  }

  let forwardedCalls = 0;
  let safe = true;
  visitSkippingNestedFunctions(region.body, region, (node) => {
    if (
      !safe ||
      !ts.isCallExpression(node) ||
      (ts.isIdentifier(node.expression) && scope.stateSetters.has(node.expression.text))
    ) {
      return;
    }
    if (nodeWithin(node, declaration.initializer!)) {
      safe = !isLocalFunctionCall(node, scope.owner);
      return;
    }
    if (
      node.getStart() <= edit.getStart() ||
      !node.arguments.some((candidate) =>
        expressionDependsOnBinding(candidate, argument, region),
      ) ||
      isLocalFunctionCall(node, scope.owner)
    ) {
      safe = false;
      return;
    }
    forwardedCalls += 1;
  });
  return safe && forwardedCalls === 1;
}

function isLocalFunctionCall(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  return (
    ts.isIdentifier(call.expression) && localFunctionBinding(owner, call.expression.text) !== null
  );
}

function synchronousDraftSetters(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): readonly StateCandidate[] | null {
  if (!ts.isBlock(callback.body) || callbackHasCleanup(callback, stateBySetter)) {
    return null;
  }
  const members = new Set<StateCandidate>();
  const synchronous = callback.body.statements.every((statement) =>
    isDraftStatement(statement, stateBySetter, members),
  );
  return synchronous ? [...members] : null;
}

function isDraftStatement(
  statement: ts.Statement,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
  members: Set<StateCandidate>,
): boolean {
  if (ts.isBlock(statement)) {
    return statement.statements.every((child) => isDraftStatement(child, stateBySetter, members));
  }
  if (ts.isIfStatement(statement)) {
    return (
      isDraftStatement(statement.thenStatement, stateBySetter, members) &&
      (!statement.elseStatement ||
        isDraftStatement(statement.elseStatement, stateBySetter, members))
    );
  }
  if (ts.isReturnStatement(statement)) {
    return statement.expression === undefined;
  }
  return isDraftSetterStatement(statement, stateBySetter, members);
}

function isDraftSetterStatement(
  statement: ts.Statement,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
  members: Set<StateCandidate>,
): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
    return false;
  }
  const call = statement.expression;
  const [argument] = call.arguments;
  const state = ts.isIdentifier(call.expression)
    ? stateBySetter.get(call.expression.text)
    : undefined;
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
}

function stateControlsHookOrRepeatedBoundary(state: StateCandidate): boolean {
  let unsafe = false;
  visit(state.owner.body, (node) => {
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
    if (referenceControlsHookOrRepeatedBoundary(node, state.owner)) {
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
    visit(state.owner.body, (reference) => {
      if (
        ts.isIdentifier(reference) &&
        reference.text === aliasName &&
        reference !== declaration.name &&
        !isDeclarationName(reference) &&
        !isNonValueIdentifier(reference) &&
        referenceControlsHookOrRepeatedBoundary(reference, state.owner)
      ) {
        unsafe = true;
      }
    });
  });
  return unsafe;
}

function referenceControlsHookOrRepeatedBoundary(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
): boolean {
  for (
    let current: ts.Node | undefined = reference.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (
      ts.isCallExpression(current) &&
      isHookCallOtherThan(current, new Set(["useCallback", "useMemo"])) &&
      current.arguments.some((argument) => nodeWithin(reference, argument))
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
  return (
    nearestNestedFunction(reference, owner) === null &&
    !findAncestorUntil(reference, isJsxNode, owner) &&
    findAncestorUntil(reference, ts.isIfStatement, owner) !== null
  );
}

function isOneHopKeyedRenderAlias(reference: ts.Identifier, repeated: ts.CallExpression): boolean {
  const [callback] = repeated.arguments;
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
  return aliasStaysInKeyedRender(declaration.name, { callback, repeated });
}

function aliasStaysInKeyedRender(
  declarationName: ts.Identifier,
  scope: { callback: ts.ArrowFunction | ts.FunctionExpression; repeated: ts.CallExpression },
): boolean {
  let found = false;
  let safe = true;
  visit(scope.callback.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== declarationName.text ||
      node === declarationName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    found = true;
    safe =
      nearestRepeatedRenderCall(node, scope.repeated.parent) === scope.repeated &&
      findAncestorUntil(node, isJsxNode, scope.repeated) !== null &&
      isSafeJsxProjectionReference(node, scope.callback);
  });
  return found && safe;
}

function hasStaleUseCallbackCapture(state: StateCandidate): boolean {
  let stale = false;
  visit(state.owner.body, (node) => {
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
      const [, dependencies] = call.arguments;
      stale =
        !dependencies ||
        !ts.isArrayLiteralExpression(dependencies) ||
        !dependencies.elements.some(
          (element) => ts.isIdentifier(element) && element.text === state.valueName,
        );
    }
  });
  return stale;
}

function hookResultFeedsLifecycle(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const declaration = findAncestorUntil(call, ts.isVariableDeclaration, owner);
  if (!declaration || declaration.initializer !== call || !ts.isIdentifier(declaration.name)) {
    return true;
  }
  const name = declaration.name.text;
  let feedsLifecycle = false;
  visit(owner.body, (node) => {
    if (feedsLifecycle || !ts.isIdentifier(node) || node.text !== name || isDeclarationName(node)) {
      return;
    }
    for (
      let current: ts.Node | undefined = node.parent;
      current && current !== owner;
      current = current.parent
    ) {
      if (
        ts.isCallExpression(current) &&
        isHookCallOtherThan(current, new Set(["useCallback", "useMemo"])) &&
        current.arguments.some((argument) => nodeWithin(node, argument))
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
  return name !== null && /^use[A-Z0-9]/u.test(name) && !allowed.has(name);
}

function hasExternalCompanionWrites(
  draft: DraftEffect,
  members: readonly StateCandidate[],
): boolean {
  const memberSet = new Set(members);
  const stateBySetter = new Map(
    draft.context.states.flatMap((state) =>
      state.owner === draft.owner && state.setterName ? [[state.setterName, state] as const] : [],
    ),
  );
  const mutations = collectSetterMutations(draft.owner, stateBySetter, draft.context.proofs);
  return mutations.some(
    (memberMutation) =>
      memberSet.has(memberMutation.state) &&
      mutations.some(
        (other) =>
          !memberSet.has(other.state) &&
          other.region === memberMutation.region &&
          draft.context.proofs.setterMutationsCanCooccur(
            other.call,
            memberMutation.call,
            memberMutation.region,
          ),
      ),
  );
}

function collectSetterMutations(
  owner: RuntimeFunctionLike,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
  proofs: EffectDraftProofs,
): SetterMutation[] {
  const mutations: SetterMutation[] = [];
  visit(owner.body, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
      return;
    }
    const state = stateBySetter.get(node.expression.text);
    if (state) {
      mutations.push({ call: node, region: proofs.nearestMutationFunction(node, owner), state });
    }
  });
  return mutations;
}

function expressionControlsRepeatedItems(node: ts.Node, repeated: ts.CallExpression): boolean {
  const receiver = ts.isPropertyAccessExpression(repeated.expression)
    ? repeated.expression.expression
    : null;
  return receiver !== null && nodeWithin(node, receiver);
}

function hasDraftRenderCut(draft: DraftEffect, members: readonly StateCandidate[]): boolean {
  if (members.length === 1 && draft.context.siblingRenderCuts.has(members[0]!)) {
    return true;
  }
  const ownerJsx = jsxElementCount(draft.owner);
  const usages = members.map((member) => draft.context.usageByState.get(member));
  if (hasLocalRenderCutWitness(draft, members, ownerJsx)) {
    return true;
  }
  if (
    ownerJsx >= MIN_OWNER_JSX &&
    usages.every((usage) => usage && draftValueTransportsAreBounded(usage, draft.owner, ownerJsx))
  ) {
    return true;
  }
  return hasSharedTransportRenderCut(draft, members, usages);
}

function hasLocalRenderCutWitness(
  draft: DraftEffect,
  members: readonly StateCandidate[],
  ownerJsx: number,
): boolean {
  const localCuts = localRenderCuts(draft, members, ownerJsx);
  if (!localCuts || !draft.owner.body) {
    return false;
  }
  const returned = draft.context.proofs.uniqueReturnedExpression(draft.owner);
  return (
    returned !== null &&
    draft.context.proofs.hasIndependentRenderCutWitness({
      excluded: localCuts,
      localComponents: draft.context.localComponents,
      returned,
      sourceComponents: draft.context.sourceComponents,
    })
  );
}

function localRenderCuts(
  draft: DraftEffect,
  members: readonly StateCandidate[],
  ownerJsx: number,
): JsxSubtreeNode[] | null {
  const cuts: JsxSubtreeNode[] = [];
  for (const member of members) {
    const cut = memberRenderCut(member, draft, ownerJsx);
    if (!cut) {
      return null;
    }
    cuts.push(cut);
  }
  return cuts;
}

function memberRenderCut(
  member: StateCandidate,
  draft: DraftEffect,
  ownerJsx: number,
): JsxSubtreeNode | null {
  const usage = draft.context.usageByState.get(member);
  if (!usage || !memberRenderReadsAreDirect(usage, member, draft.owner)) {
    return null;
  }
  const cut = lowestCommonJsxSubtree(usage.directRenderNodes, draft.owner);
  return cut && jsxElementCountIn(cut) / ownerJsx <= MAX_CUT_SHARE ? cut : null;
}

function memberRenderReadsAreDirect(
  usage: StateUsage,
  member: StateCandidate,
  owner: RuntimeFunctionLike,
): boolean {
  const directSetterRead = hasDirectJsxEventSetter(member) ? 1 : 0;
  return (
    usage.transportedOccurrences === 0 &&
    usage.directRenderNodes.length > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length + directSetterRead &&
    usage.directRenderNodes.every(
      (node) =>
        nearestNestedFunction(node, owner) === null && isSafeJsxProjectionReference(node, owner),
    )
  );
}

function hasSharedTransportRenderCut(
  draft: DraftEffect,
  members: readonly StateCandidate[],
  usages: readonly (StateUsage | undefined)[],
): boolean {
  if (usages.some((usage) => !usage || usage.localRenderReads > 0)) {
    return false;
  }
  const sites = usages.map((usage) => usage?.valueTransportSites);
  const [first] = sites;
  const site = first?.size === 1 ? [...first][0] : undefined;
  if (
    site === undefined ||
    !sites.every((value) => value !== undefined && value.size === 1 && [...value][0] === site)
  ) {
    return false;
  }
  const usage = draft.context.usageByState.get(members[0]!);
  const callSite = usage
    ? draft.context.proofs.directUniqueReturnCallSite(usage, draft.owner)
    : null;
  return callSite !== null && hasIndependentSiblingSubtree(callSite);
}

function hasIndependentSiblingSubtree(callSite: DirectReturnCallSite): boolean {
  const target = callSite.opening;
  const targetSubtree: ts.Node = ts.isJsxOpeningElement(target) ? target.parent : target;
  let independent = false;
  visitSkippingNestedRuntimeFunctions(callSite.returned, (node) => {
    if (
      independent ||
      (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) ||
      node === target
    ) {
      return;
    }
    const subtree: ts.Node = ts.isJsxOpeningElement(node) ? node.parent : node;
    independent = !nodeWithin(subtree, targetSubtree) && !nodeWithin(targetSubtree, subtree);
  });
  return independent;
}

function draftValueTransportsAreBounded(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
  ownerJsx: number,
): boolean {
  const { body } = owner;
  if (!body) {
    return false;
  }
  for (const site of usage.valueTransportSites) {
    let target: JsxSubtreeNode | null = null;
    visitSkippingNestedRuntimeFunctions(body, (node) => {
      if (
        target ||
        (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) ||
        node.getStart() !== site
      ) {
        return;
      }
      target = ts.isJsxOpeningElement(node) ? node.parent : node;
    });
    if (!target || jsxElementCountIn(target) / ownerJsx > MAX_CUT_SHARE) {
      return false;
    }
  }
  return true;
}
