import type { EffectCandidate, StateCandidate, StateUsage } from "../analyze-source.js";
import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import { callbackIsEventRooted, hasDirectPrimitiveInitializer } from "./state-proofs.js";
import { nearestNestedFunction, nodeWithin, visit, visitSkippingNestedFunctions } from "../ast.js";

import type { HookImports } from "../imports.js";
import type { RuntimeFunctionLike } from "../ast.js";
import { isImportedHookCall } from "../imports.js";
import { mutationRegionOnlyCallsStateSetters } from "./effect-drafts.js";
import ts from "typescript";

const MINIMUM_CLUSTER_MEMBERS = 2;
const LISTENER_CALL_ARGUMENT_COUNT = 2;

export interface ListenerRefStateCluster {
  action: "use-ref";
  id: string;
  members: readonly StateCandidate[];
  message: string;
  primary: StateCandidate;
}

interface CallbackBinding {
  callback: ts.ArrowFunction | ts.FunctionExpression;
  declaration: ts.VariableDeclaration;
  dependencies: ts.ArrayLiteralExpression;
  name: string;
}

interface ListenerCall {
  callback: ts.Identifier;
  event: ts.Expression;
  options: ts.Expression | undefined;
  target: ts.Expression;
}

interface OwnerScan {
  readonly effects: readonly EffectCandidate[];
  readonly imports: HookImports;
  readonly owner: RuntimeFunctionLike;
  readonly ownerStates: readonly StateCandidate[];
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

interface RegionScan {
  readonly claimed: ReadonlySet<StateCandidate>;
  readonly region: RuntimeFunctionLike;
  readonly regionMembers: ReadonlySet<StateCandidate>;
  readonly scan: OwnerScan;
  readonly stateBySetter: ReadonlyMap<string, StateCandidate>;
}

export interface ListenerRefStateScan {
  readonly effects: readonly EffectCandidate[];
  readonly imports: HookImports;
  readonly states: readonly StateCandidate[];
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

export function findListenerRefStateClusters({
  effects,
  imports,
  states,
  usageByState,
}: ListenerRefStateScan): ReadonlyMap<StateCandidate, ListenerRefStateCluster> {
  const result = new Map<StateCandidate, ListenerRefStateCluster>();
  for (const [owner, ownerStates] of groupByOwner(states)) {
    for (const [state, cluster] of ownerClusters({
      effects,
      imports,
      owner,
      ownerStates,
      usageByState,
    })) {
      result.set(state, cluster);
    }
  }
  return result;
}

function ownerClusters(scan: OwnerScan): ReadonlyMap<StateCandidate, ListenerRefStateCluster> {
  const callbacks = listenerCallbacks(scan.owner, scan.effects, scan.imports);
  if (callbacks.size === 0) {
    return new Map();
  }
  const candidates = new Set(
    scan.ownerStates.filter((state) =>
      isListenerRefCandidate(state, scan.usageByState.get(state), callbacks),
    ),
  );
  if (candidates.size < MINIMUM_CLUSTER_MEMBERS) {
    return new Map();
  }
  return clustersByRegion(scan, candidates);
}

function clustersByRegion(
  scan: OwnerScan,
  candidates: ReadonlySet<StateCandidate>,
): ReadonlyMap<StateCandidate, ListenerRefStateCluster> {
  const stateBySetter = settersByName(scan.ownerStates);
  const clusters = new Map<StateCandidate, ListenerRefStateCluster>();
  const claimed = new Set<StateCandidate>();
  for (const [region, regionMembers] of orderedCandidateRegions(scan, candidates)) {
    const cluster = regionCluster({ claimed, region, regionMembers, scan, stateBySetter });
    if (cluster) {
      recordCluster(clusters, claimed, cluster);
    }
  }
  return clusters;
}

function recordCluster(
  clusters: Map<StateCandidate, ListenerRefStateCluster>,
  claimed: Set<StateCandidate>,
  cluster: ListenerRefStateCluster,
): void {
  for (const member of cluster.members) {
    claimed.add(member);
    clusters.set(member, cluster);
  }
}

function regionCluster(scanned: RegionScan): ListenerRefStateCluster | null {
  const { claimed, region, regionMembers, scan, stateBySetter } = scanned;
  if (
    regionMembers.size < MINIMUM_CLUSTER_MEMBERS ||
    [...regionMembers].some((state) => claimed.has(state)) ||
    !regionIsSynchronousEvent(region, scan.owner) ||
    !regionWritesOnlyMembers(region, regionMembers, stateBySetter)
  ) {
    return null;
  }
  const members = [...regionMembers].toSorted(
    (left, right) => left.call.getStart() - right.call.getStart(),
  );
  const [primary] = members;
  if (!primary) {
    return null;
  }
  const names = members.map((state) => state.valueName);
  return {
    action: "use-ref",
    id: `state-cluster:listener-ref:${scan.owner.getStart()}:${names.join(",")}`,
    members,
    message: `Replace the listener-only state cluster (${names.map((name) => `\`${name}\``).join(", ")}) with refs as one migration; rewrite every read and write through \`.current\`, remove those values from memoized callback dependencies, and preserve each existing listener effect, registration target, event, guard, and cleanup.`,
    primary,
  };
}

function settersByName(
  ownerStates: readonly StateCandidate[],
): ReadonlyMap<string, StateCandidate> {
  return new Map(
    ownerStates.flatMap((state) => (state.setterName ? [[state.setterName, state] as const] : [])),
  );
}

function setterRegions(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
): readonly RuntimeFunctionLike[] {
  return usage.setterCallNodes.flatMap((call) => {
    const region = nearestNestedFunction(call, owner);
    return region && region !== owner ? [region] : [];
  });
}

function orderedCandidateRegions(
  scan: OwnerScan,
  candidates: ReadonlySet<StateCandidate>,
): readonly (readonly [RuntimeFunctionLike, ReadonlySet<StateCandidate>])[] {
  const regions = new Map<RuntimeFunctionLike, Set<StateCandidate>>();
  for (const state of candidates) {
    const usage = scan.usageByState.get(state);
    if (!usage) {
      continue;
    }
    for (const region of setterRegions(usage, scan.owner)) {
      const members = regions.get(region) ?? new Set<StateCandidate>();
      members.add(state);
      regions.set(region, members);
    }
  }
  return [...regions].toSorted(([left], [right]) => left.getStart() - right.getStart());
}

function groupByOwner(
  states: readonly StateCandidate[],
): ReadonlyMap<RuntimeFunctionLike, readonly StateCandidate[]> {
  const groups = new Map<RuntimeFunctionLike, StateCandidate[]>();
  for (const state of states) {
    const group = groups.get(state.owner) ?? [];
    group.push(state);
    groups.set(state.owner, group);
  }
  return groups;
}

interface ListenerReference {
  readonly name: string;
  readonly nodes: readonly ts.Identifier[];
}

function listenerCallbacks(
  owner: RuntimeFunctionLike,
  effects: readonly EffectCandidate[],
  imports: HookImports,
): ReadonlyMap<string, CallbackBinding> {
  const callbacks = callbackBindings(owner, imports);
  const allowedByName = allowedListenerReferences(owner, effects, callbacks);
  const listeners = new Map<string, CallbackBinding>();
  for (const [name, allowedReferences] of allowedByName) {
    const binding = callbacks.get(name);
    if (!binding || !callbackReferencesAreConfined(owner, binding, allowedReferences)) {
      continue;
    }
    listeners.set(name, binding);
  }
  return listeners;
}

function allowedListenerReferences(
  owner: RuntimeFunctionLike,
  effects: readonly EffectCandidate[],
  callbacks: ReadonlyMap<string, CallbackBinding>,
): ReadonlyMap<string, ReadonlySet<ts.Identifier>> {
  const allowedByName = new Map<string, Set<ts.Identifier>>();
  for (const effect of effects) {
    if (effect.owner !== owner) {
      continue;
    }
    for (const reference of effectListenerReferences(effect, callbacks)) {
      const allowed = allowedByName.get(reference.name) ?? new Set<ts.Identifier>();
      for (const node of reference.nodes) {
        allowed.add(node);
      }
      allowedByName.set(reference.name, allowed);
    }
  }
  return allowedByName;
}

function effectListenerReferences(
  effect: EffectCandidate,
  callbacks: ReadonlyMap<string, CallbackBinding>,
): readonly ListenerReference[] {
  const { callback } = effect;
  if (!callback || isAsync(callback)) {
    return [];
  }
  const cleanup = effectCleanup(callback);
  if (!cleanup) {
    return [];
  }
  const removals = collectListenerCalls(cleanup.body, "removeEventListener", cleanup);
  return collectListenerCalls(callback.body, "addEventListener", callback).flatMap((addition) => {
    const reference = listenerReference({
      addition,
      callbacks,
      dependencies: effect.dependencies,
      removals,
    });
    return reference ? [reference] : [];
  });
}

function listenerReference(options: {
  readonly addition: ListenerCall;
  readonly callbacks: ReadonlyMap<string, CallbackBinding>;
  readonly dependencies: ts.ArrayLiteralExpression | null;
  readonly removals: readonly ListenerCall[];
}): ListenerReference | null {
  const { addition, callbacks, dependencies, removals } = options;
  const binding = callbacks.get(addition.callback.text);
  const removal = binding ? soleMatchingRemoval(removals, addition) : null;
  if (!binding || !removal) {
    return null;
  }
  const dependency = dependencyIdentifier(dependencies, binding.name);
  if (!dependency) {
    return null;
  }
  return { name: binding.name, nodes: [addition.callback, removal.callback, dependency] };
}

function soleMatchingRemoval(
  removals: readonly ListenerCall[],
  addition: ListenerCall,
): ListenerCall | null {
  const matches = removals.filter((removal) => listenerCallsMatch(removal, addition));
  const [match] = matches;
  return matches.length === 1 && match ? match : null;
}

function listenerCallsMatch(removal: ListenerCall, addition: ListenerCall): boolean {
  return (
    removal.callback.text === addition.callback.text &&
    expressionsMatch(removal.event, addition.event) &&
    optionsMatch(removal.options, addition.options) &&
    expressionsMatch(removal.target, addition.target)
  );
}

function dependencyIdentifier(
  dependencies: ts.ArrayLiteralExpression | null,
  name: string,
): ts.Identifier | null {
  const element = dependencies?.elements.find(
    (candidate) => ts.isIdentifier(candidate) && candidate.text === name,
  );
  return element && ts.isIdentifier(element) ? element : null;
}

function callbackBindings(
  owner: RuntimeFunctionLike,
  imports: HookImports,
): ReadonlyMap<string, CallbackBinding> {
  const callbacks = new Map<string, CallbackBinding>();
  visit(owner.body, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.initializer ||
      !ts.isCallExpression(node.initializer) ||
      !isImportedHookCall({
        call: node.initializer,
        localNames: imports.useCallback,
        namespaceNames: imports.reactNamespaces,
        canonicalName: "useCallback",
      }) ||
      bindingDeclarationCount(owner, node.name.text) !== 1
    ) {
      return;
    }
    const [callback, dependencies] = node.initializer.arguments;
    if (
      !callback ||
      (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
      !dependencies ||
      !ts.isArrayLiteralExpression(dependencies) ||
      isAsync(callback) ||
      containsAwaitOrYield(callback.body)
    ) {
      return;
    }
    callbacks.set(node.name.text, {
      callback,
      declaration: node,
      dependencies,
      name: node.name.text,
    });
  });
  return callbacks;
}

function effectCleanup(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (!ts.isBlock(callback.body)) {
    return null;
  }
  const returns = callback.body.statements.filter(ts.isReturnStatement);
  const expression = returns.length === 1 ? returns[0]!.expression : undefined;
  const cleanup = expression ? unwrapTransparentExpression(expression) : null;
  return cleanup &&
    (ts.isArrowFunction(cleanup) || ts.isFunctionExpression(cleanup)) &&
    !isAsync(cleanup)
    ? cleanup
    : null;
}

function collectListenerCalls(
  body: ts.ConciseBody,
  operation: "addEventListener" | "removeEventListener",
  boundary: ts.ArrowFunction | ts.FunctionExpression,
): readonly ListenerCall[] {
  const calls: ListenerCall[] = [];
  visitSkippingNestedFunctions(body, boundary, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== operation ||
      node.arguments.length < LISTENER_CALL_ARGUMENT_COUNT ||
      !ts.isIdentifier(node.arguments[1]!)
    ) {
      return;
    }
    calls.push({
      callback: node.arguments[1]!,
      event: node.arguments[0]!,
      options: node.arguments[2],
      target: node.expression.expression,
    });
  });
  return calls;
}

function expressionsMatch(left: ts.Expression, right: ts.Expression): boolean {
  return (
    unwrapTransparentExpression(left).getText() === unwrapTransparentExpression(right).getText()
  );
}

function optionsMatch(left: ts.Expression | undefined, right: ts.Expression | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }
  return expressionsMatch(left, right);
}

function callbackReferencesAreConfined(
  owner: RuntimeFunctionLike,
  binding: CallbackBinding,
  allowedReferences: ReadonlySet<ts.Identifier>,
): boolean {
  let references = 0;
  let safe = true;
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== binding.name ||
      node === binding.declaration.name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    references += 1;
    if (!allowedReferences.has(node)) {
      safe = false;
    }
  });
  return safe && references > 0;
}

type ValueReferenceVerdict = "ignored" | "listener-read" | "unsafe";

function isListenerRefCandidate(
  state: StateCandidate,
  usage: StateUsage | undefined,
  callbacks: ReadonlyMap<string, CallbackBinding>,
): boolean {
  return usageAllowsListenerRef(state, usage) && listenerReadsAreConfined(state, callbacks);
}

function usageAllowsListenerRef(state: StateCandidate, usage: StateUsage | undefined): boolean {
  if (!state.setterName || !usage || !hasDirectPrimitiveInitializer(state)) {
    return false;
  }
  return (
    usage.localRenderReads === 0 &&
    usage.transportedOccurrences === 0 &&
    usage.effectWrites === 0 &&
    usage.setterCalls !== 0 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped &&
    usage.setterCallNodes.every((call) => setterRegionIsSynchronous(call, state.owner))
  );
}

function listenerReadsAreConfined(
  state: StateCandidate,
  callbacks: ReadonlyMap<string, CallbackBinding>,
): boolean {
  let listenerRead = false;
  let safe = true;
  visit(state.owner.body, (node) => {
    if (!safe || !isStateValueReference(node, state)) {
      return;
    }
    const verdict = valueReferenceVerdict(node, state, callbacks);
    if (verdict === "listener-read") {
      listenerRead = true;
    } else if (verdict === "unsafe") {
      safe = false;
    }
  });
  return safe && listenerRead;
}

function isStateValueReference(node: ts.Node, state: StateCandidate): node is ts.Identifier {
  return (
    ts.isIdentifier(node) &&
    node.text === state.valueName &&
    node.parent !== state.call.parent &&
    !isDeclarationName(node) &&
    !isNonValueIdentifier(node)
  );
}

function valueReferenceVerdict(
  node: ts.Identifier,
  state: StateCandidate,
  callbacks: ReadonlyMap<string, CallbackBinding>,
): ValueReferenceVerdict {
  const listener = listenerContaining(node, callbacks);
  if (listener) {
    return listener.dependencies.elements.some(
      (element) => ts.isIdentifier(element) && element.text === state.valueName,
    )
      ? "listener-read"
      : "unsafe";
  }
  if ([...callbacks.values()].some((binding) => nodeWithin(node, binding.dependencies))) {
    return "ignored";
  }
  return referenceInEventRootedCallback(node, state) ? "ignored" : "unsafe";
}

function referenceInEventRootedCallback(node: ts.Node, state: StateCandidate): boolean {
  const callback = nearestNestedFunction(node, state.owner);
  return (
    callback !== null &&
    callback !== state.owner &&
    (ts.isArrowFunction(callback) ||
      ts.isFunctionDeclaration(callback) ||
      ts.isFunctionExpression(callback)) &&
    !isAsync(callback) &&
    !containsAwaitOrYield(callback.body) &&
    callbackIsEventRooted({
      callback,
      owner: state.owner,
      dependencyName: state.valueName,
      seen: new Set(),
    })
  );
}

function listenerContaining(
  node: ts.Node,
  callbacks: ReadonlyMap<string, CallbackBinding>,
): CallbackBinding | null {
  for (const binding of callbacks.values()) {
    if (nodeWithin(node, binding.callback.body)) {
      return binding;
    }
  }
  return null;
}

function setterRegionIsSynchronous(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const region = nearestNestedFunction(call, owner);
  return (
    region !== null && region !== owner && !isAsync(region) && !containsAwaitOrYield(region.body)
  );
}

function regionIsSynchronousEvent(
  region: RuntimeFunctionLike,
  owner: RuntimeFunctionLike,
): boolean {
  return (
    !isAsync(region) &&
    !containsAwaitOrYield(region.body) &&
    (ts.isArrowFunction(region) ||
      ts.isFunctionDeclaration(region) ||
      ts.isFunctionExpression(region)) &&
    callbackIsEventRooted({ callback: region, owner, dependencyName: "", seen: new Set() })
  );
}

function regionWritesOnlyMembers(
  region: RuntimeFunctionLike,
  members: ReadonlySet<StateCandidate>,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): boolean {
  const memberSetters = new Set(
    [...members].flatMap((state) => (state.setterName ? [state.setterName] : [])),
  );
  let safe = true;
  if (!region.body) {
    return false;
  }
  visitSkippingNestedFunctions(region.body, region, (node) => {
    if (!safe || !ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
      return;
    }
    const state = stateBySetter.get(node.expression.text);
    if (state && !members.has(state)) {
      safe = false;
    }
  });
  return safe && mutationRegionOnlyCallsStateSetters(region, memberSetters);
}

function isAsync(node: RuntimeFunctionLike): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
}

function containsAwaitOrYield(node: ts.Node | undefined): boolean {
  if (!node) {
    return true;
  }
  let found = false;
  visit(node, (current) => {
    if (ts.isAwaitExpression(current) || ts.isYieldExpression(current)) {
      found = true;
    }
  });
  return found;
}
