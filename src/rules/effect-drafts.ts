import ts from "typescript";

import {
  bindingDeclarationCount,
  hookCallName,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
} from "../analysis-ast.js";
import {
  findAncestorUntil,
  nearestNestedFunction,
  nodeWithin,
  visit,
  visitSkippingNestedFunctions,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import type { RuntimeFunctionLike } from "../ast.js";
import type { EffectCandidate, StateCandidate, StateUsage } from "../analyze-source.js";
import { callbackHasCleanup } from "./effects.js";
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
  directUniqueReturnCallSite(
    usage: StateUsage,
    owner: RuntimeFunctionLike,
  ): DirectReturnCallSite | null;
  hasIndependentRenderCutWitness(
    returned: ts.Expression,
    excluded: readonly ts.Node[],
    localComponents: ReadonlySet<string>,
    sourceComponents: ReadonlySet<string>,
  ): boolean;
  isCustomHookOwner(owner: RuntimeFunctionLike): boolean;
  nearestMutationFunction(node: ts.Node, owner: RuntimeFunctionLike): RuntimeFunctionLike;
  setterMutationsCanCooccur(
    left: ts.CallExpression,
    right: ts.CallExpression,
    region: RuntimeFunctionLike,
  ): boolean;
  uniqueReturnedExpression(owner: RuntimeFunctionLike): ts.Expression | null;
}

export function findEffectSynchronizedDrafts(
  effects: readonly EffectCandidate[],
  states: readonly StateCandidate[],
  scopes: ReadonlyMap<RuntimeFunctionLike, EffectDraftScope>,
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  siblingRenderCuts: ReadonlyMap<StateCandidate, unknown>,
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>,
  proofs: EffectDraftProofs,
): EffectDraftAnalysis {
  const clusters = new Map<StateCandidate, EffectDraftCluster>(),
    synchronizedEffects = new Set<EffectCandidate>(),
    singletons = new Set<StateCandidate>();

  for (const effect of effects) {
    if (
      !effect.owner ||
      !effect.callback ||
      !effect.dependencies ||
      effect.dependencies.elements.length === 0 ||
      proofs.isCustomHookOwner(effect.owner)
    ) {
      continue;
    }
    const scope = scopes.get(effect.owner);
    if (!scope) {
      continue;
    }
    const members = synchronousDraftSetters(effect.callback, scope.bySetter);
    if (!members || members.length === 0) {
      continue;
    }
    const ownerSetters = new Set(
        states.flatMap((state) =>
          state.owner === effect.owner && state.setterName ? [state.setterName] : [],
        ),
      ),
      editProofs = new Map(
        members.map(
          (state) =>
            [
              state,
              draftEditProof(state, usageByState.get(state), effect, ownerSetters, proofs),
            ] as const,
        ),
      ),
      complete = members.every((state) => {
        const usage = usageByState.get(state);
        return (
          !!usage &&
          stateIsWrittenOnlyByEffect(usage, effect, effects) &&
          usage.setterReferences > usage.effectWrites &&
          usage.effectReads === 0 &&
          !hasStaleUseCallbackCapture(state) &&
          usage.localRenderReads + usage.transportedOccurrences > 0 &&
          !usage.shadowed &&
          !usage.escaped &&
          !stateMayHoldCallable(state) &&
          editProofs.get(state)?.reachable === true &&
          !stateControlsHookOrRepeatedShape(state)
        );
      });
    if (
      !complete ||
      !members.some((state) => editProofs.get(state)?.independent) ||
      hasExternalCompanionWrites(effect.owner, members, states, proofs) ||
      !hasDraftRenderCut(
        effect.owner,
        members,
        usageByState,
        siblingRenderCuts,
        localComponents,
        sourceComponents,
        proofs,
      )
    ) {
      continue;
    }

    synchronizedEffects.add(effect);
    const ordered = [...members].sort(
      (left, right) => left.call.getStart() - right.call.getStart(),
    );
    if (ordered.length === 1) {
      singletons.add(ordered[0]!);
      continue;
    }
    const names = ordered.map((state) => state.valueName),
      initialization = ordered.some(hasLazyStateInitializer)
        ? " Preserve every lazy initializer as a once-only owner snapshot; do not pass it to Legend as a computed function."
        : "",
      cluster: EffectDraftCluster = {
        action: "use-observable",
        id: `state-cluster:effect-draft:${effect.owner.getStart()}:${effect.call.getStart()}`,
        members: ordered,
        message: `Replace the effect-synchronized React draft cluster (${names.map((name) => `\`${name}\``).join(", ")}) with one component-lifetime observable model; preserve the React synchronization effect and its dependencies, assign the draft atomically there, mutate from edit commands, snapshot once at command entry before deferred work, and subscribe only in rendered leaves.${initialization}`,
        primary: ordered[0]!,
      };
    for (const state of ordered) {
      clusters.set(state, cluster);
    }
  }
  return { clusters, effects: synchronizedEffects, singletons };
}

export function hasLazyStateInitializer(state: StateCandidate): boolean {
  const initializer = state.call.arguments[0];
  return !!initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
}

function draftEditProof(
  state: StateCandidate,
  usage: StateUsage | undefined,
  effect: EffectCandidate,
  ownerSetters: ReadonlySet<string>,
  proofs: EffectDraftProofs,
): { independent: boolean; reachable: boolean } {
  if (!usage) {
    return { independent: false, reachable: false };
  }
  const direct = hasDirectJsxEventSetter(state),
    edits = usage.setterCallNodes.filter((call) => !nodeWithin(call, effect.call)),
    reachable = edits.filter((call) => {
      const region = proofs.nearestMutationFunction(call, state.owner);
      return (
        region !== state.owner &&
        (ts.isArrowFunction(region) ||
          ts.isFunctionDeclaration(region) ||
          ts.isFunctionExpression(region)) &&
        callbackIsEventRooted(region, state.owner, "", new Set())
      );
    }),
    independent =
      direct ||
      reachable.some((call) => {
        const region = proofs.nearestMutationFunction(call, state.owner);
        return (
          (mutationRegionOnlyCallsStateSetters(region, ownerSetters) ||
            mutationRegionForwardsDraftValue(region, call, ownerSetters, state.owner)) &&
          setterArgumentDiffersFromEffect(call, state, effect)
        );
      });
  return { independent, reachable: direct || reachable.length > 0 };
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
  const argument = edit.arguments[0];
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
      /^(?:onChange|onChangeText|onSelect|onValueChange|onCheckedChange)$/.test(
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
  let sawSetter = false,
    unsafeCall = false;
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
  stateSetters: ReadonlySet<string>,
  owner: RuntimeFunctionLike,
): boolean {
  const argument = edit.arguments[0];
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

  let forwardedCalls = 0,
    safe = true;
  visitSkippingNestedFunctions(region.body, region, (node) => {
    if (!safe || !ts.isCallExpression(node)) {
      return;
    }
    if (ts.isIdentifier(node.expression) && stateSetters.has(node.expression.text)) {
      return;
    }
    if (nodeWithin(node, declaration.initializer!)) {
      safe = !isLocalFunctionCall(node, owner);
      return;
    }
    if (
      node.getStart() <= edit.getStart() ||
      !node.arguments.some((candidate) =>
        expressionDependsOnBinding(candidate, argument, region),
      ) ||
      isLocalFunctionCall(node, owner)
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
  const members = new Set<StateCandidate>(),
    validStatement = (statement: ts.Statement): boolean => {
      if (ts.isBlock(statement)) {
        return statement.statements.every(validStatement);
      }
      if (ts.isIfStatement(statement)) {
        return (
          validStatement(statement.thenStatement) &&
          (!statement.elseStatement || validStatement(statement.elseStatement))
        );
      }
      if (ts.isReturnStatement(statement)) {
        return statement.expression === undefined;
      }
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
        return false;
      }
      const call = statement.expression;
      if (!ts.isIdentifier(call.expression)) {
        return false;
      }
      const state = stateBySetter.get(call.expression.text),
        argument = call.arguments[0];
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
    visit(state.owner.body, (reference) => {
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
  const repeated = nearestRepeatedRenderCall(reference, owner),
    repeatedOwner = repeated ? nearestNestedFunction(repeated, owner) : null;
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
  const callback = repeated.arguments[0];
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !repeatedRenderHasStableItemKey(callback)
  ) {
    return false;
  }
  const declaration = findAncestorUntil(reference, ts.isVariableDeclaration, callback),
    binding = callback.parameters[0]?.name;
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
  let found = false,
    safe = true;
  visit(callback.body, (node) => {
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
    safe =
      nearestRepeatedRenderCall(node, repeated.parent) === repeated &&
      findAncestorUntil(node, isJsxNode, repeated) !== null &&
      isSafeJsxProjectionReference(node, callback);
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
    const callback = nearestNestedFunction(node, state.owner),
      call = callback?.parent;
    if (
      callback &&
      call &&
      ts.isCallExpression(call) &&
      hookCallName(call) === "useCallback" &&
      call.arguments[0] === callback
    ) {
      const dependencies = call.arguments[1];
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
  return name !== null && /^use[A-Z0-9]/.test(name) && !allowed.has(name);
}

function hasExternalCompanionWrites(
  owner: RuntimeFunctionLike,
  members: readonly StateCandidate[],
  allStates: readonly StateCandidate[],
  proofs: EffectDraftProofs,
): boolean {
  const memberSet = new Set(members),
    stateBySetter = new Map(
      allStates.flatMap((state) =>
        state.owner === owner && state.setterName ? [[state.setterName, state] as const] : [],
      ),
    ),
    mutations: {
      call: ts.CallExpression;
      region: RuntimeFunctionLike;
      state: StateCandidate;
    }[] = [];
  visit(owner.body, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
      return;
    }
    const state = stateBySetter.get(node.expression.text);
    if (!state) {
      return;
    }
    const region = proofs.nearestMutationFunction(node, owner);
    mutations.push({ call: node, region, state });
  });
  return mutations.some(
    (memberMutation) =>
      memberSet.has(memberMutation.state) &&
      mutations.some(
        (other) =>
          !memberSet.has(other.state) &&
          other.region === memberMutation.region &&
          proofs.setterMutationsCanCooccur(other.call, memberMutation.call, memberMutation.region),
      ),
  );
}

function expressionControlsRepeatedItems(node: ts.Node, repeated: ts.CallExpression): boolean {
  const receiver = ts.isPropertyAccessExpression(repeated.expression)
    ? repeated.expression.expression
    : null;
  return !!receiver && nodeWithin(node, receiver);
}

function hasDraftRenderCut(
  owner: RuntimeFunctionLike,
  members: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  siblingRenderCuts: ReadonlyMap<StateCandidate, unknown>,
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>,
  proofs: EffectDraftProofs,
): boolean {
  if (members.length === 1 && siblingRenderCuts.has(members[0]!)) {
    return true;
  }
  const ownerJsx = jsxElementCount(owner),
    localUsages = members.map((member) => usageByState.get(member)),
    localCuts: JsxSubtreeNode[] = [];
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index]!,
      usage = localUsages[index],
      directSetterRead = hasDirectJsxEventSetter(member) ? 1 : 0;
    if (
      !usage ||
      usage.transportedOccurrences !== 0 ||
      usage.directRenderNodes.length === 0 ||
      usage.localRenderReads !== usage.directRenderNodes.length + directSetterRead ||
      usage.directRenderNodes.some(
        (node) =>
          nearestNestedFunction(node, owner) !== null || !isSafeJsxProjectionReference(node, owner),
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
    const returned = proofs.uniqueReturnedExpression(owner);
    if (
      returned &&
      proofs.hasIndependentRenderCutWitness(returned, localCuts, localComponents, sourceComponents)
    ) {
      return true;
    }
  }
  if (
    ownerJsx >= 12 &&
    localUsages.every((usage) => usage && draftValueTransportsAreBounded(usage, owner, ownerJsx))
  ) {
    return true;
  }
  if (localUsages.some((usage) => !usage || usage.localRenderReads > 0)) {
    return false;
  }
  const sites = members.map((member) => usageByState.get(member)?.valueTransportSites);
  if (sites.some((value) => !value || value.size !== 1)) {
    return false;
  }
  const site = [...sites[0]!][0];
  if (site === undefined || !sites.every((value) => [...value!][0] === site)) {
    return false;
  }
  const callSite = proofs.directUniqueReturnCallSite(usageByState.get(members[0]!)!, owner);
  if (!callSite) {
    return false;
  }
  const target = callSite.opening,
    targetSubtree: ts.Node = ts.isJsxOpeningElement(target) ? target.parent : target;
  let independent = false;
  visitSkippingNestedRuntimeFunctions(callSite.returned, (node) => {
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
    if (!target || jsxElementCountIn(target) / ownerJsx > 0.4) {
      return false;
    }
  }
  return true;
}
