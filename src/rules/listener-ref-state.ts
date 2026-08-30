import ts from "typescript";

import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import type { EffectCandidate, StateCandidate, StateUsage } from "../analyze-source.js";
import { nearestNestedFunction, nodeWithin, visit, visitSkippingNestedFunctions } from "../ast.js";
import { isImportedHookCall } from "../imports.js";
import { mutationRegionOnlyCallsStateSetters } from "./effect-drafts.js";
import { callbackIsEventRooted, hasDirectPrimitiveInitializer } from "./state-proofs.js";
import type { RuntimeFunctionLike } from "../ast.js";
import type { HookImports } from "../imports.js";

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

export function findListenerRefStateClusters(
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  effects: readonly EffectCandidate[],
  imports: HookImports,
): ReadonlyMap<StateCandidate, ListenerRefStateCluster> {
  const result = new Map<StateCandidate, ListenerRefStateCluster>(),
    statesByOwner = groupByOwner(states);

  for (const [owner, ownerStates] of statesByOwner) {
    const callbacks = listenerCallbacks(owner, effects, imports);
    if (callbacks.size === 0) {
      continue;
    }
    const candidates = new Set(
      ownerStates.filter((state) =>
        isListenerRefCandidate(state, usageByState.get(state), callbacks),
      ),
    );
    if (candidates.size < 2) {
      continue;
    }

    const stateBySetter = new Map(
        ownerStates.flatMap((state) =>
          state.setterName ? [[state.setterName, state] as const] : [],
        ),
      ),
      candidateRegions = new Map<RuntimeFunctionLike, Set<StateCandidate>>();
    for (const state of candidates) {
      const usage = usageByState.get(state);
      if (!usage) {
        continue;
      }
      for (const call of usage.setterCallNodes) {
        const region = nearestNestedFunction(call, owner);
        if (!region || region === owner) {
          continue;
        }
        const members = candidateRegions.get(region) ?? new Set<StateCandidate>();
        members.add(state);
        candidateRegions.set(region, members);
      }
    }

    const claimed = new Set<StateCandidate>(),
      regions = [...candidateRegions].toSorted(
        ([left], [right]) => left.getStart() - right.getStart(),
      );
    for (const [region, regionMembers] of regions) {
      if (
        regionMembers.size < 2 ||
        [...regionMembers].some((state) => claimed.has(state)) ||
        !regionIsSynchronousEvent(region, owner) ||
        !regionWritesOnlyMembers(region, regionMembers, stateBySetter)
      ) {
        continue;
      }
      const members = [...regionMembers].toSorted(
          (left, right) => left.call.getStart() - right.call.getStart(),
        ),
        primary = members[0];
      if (!primary) {
        continue;
      }
      const names = members.map((state) => state.valueName),
        cluster: ListenerRefStateCluster = {
          action: "use-ref",
          id: `state-cluster:listener-ref:${owner.getStart()}:${names.join(",")}`,
          members,
          message: `Replace the listener-only state cluster (${names.map((name) => `\`${name}\``).join(", ")}) with refs as one migration; rewrite every read and write through \`.current\`, remove those values from memoized callback dependencies, and preserve each existing listener effect, registration target, event, guard, and cleanup.`,
          primary,
        };
      for (const member of members) {
        claimed.add(member);
        result.set(member, cluster);
      }
    }
  }

  return result;
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

function listenerCallbacks(
  owner: RuntimeFunctionLike,
  effects: readonly EffectCandidate[],
  imports: HookImports,
): ReadonlyMap<string, CallbackBinding> {
  const callbacks = callbackBindings(owner, imports),
    allowedByName = new Map<string, Set<ts.Identifier>>();

  for (const effect of effects) {
    if (effect.owner !== owner || !effect.callback || isAsync(effect.callback)) {
      continue;
    }
    const cleanup = effectCleanup(effect.callback);
    if (!cleanup) {
      continue;
    }
    const additions = collectListenerCalls(
        effect.callback.body,
        "addEventListener",
        effect.callback,
      ),
      removals = collectListenerCalls(cleanup.body, "removeEventListener", cleanup);
    for (const addition of additions) {
      const binding = callbacks.get(addition.callback.text);
      if (!binding) {
        continue;
      }
      const matches = removals.filter(
        (removal) =>
          removal.callback.text === addition.callback.text &&
          expressionsMatch(removal.event, addition.event) &&
          optionsMatch(removal.options, addition.options) &&
          expressionsMatch(removal.target, addition.target),
      );
      if (matches.length !== 1) {
        continue;
      }
      const dependency = effect.dependencies?.elements.find(
        (element) => ts.isIdentifier(element) && element.text === binding.name,
      );
      if (!dependency || !ts.isIdentifier(dependency)) {
        continue;
      }
      const allowed = allowedByName.get(binding.name) ?? new Set<ts.Identifier>();
      allowed.add(addition.callback);
      allowed.add(matches[0]!.callback);
      allowed.add(dependency);
      allowedByName.set(binding.name, allowed);
    }
  }

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
      !isImportedHookCall(
        node.initializer,
        imports.useCallback,
        imports.reactNamespaces,
        "useCallback",
      ) ||
      bindingDeclarationCount(owner, node.name.text) !== 1
    ) {
      return;
    }
    const callback = node.initializer.arguments[0],
      dependencies = node.initializer.arguments[1];
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
  const returns = callback.body.statements.filter(ts.isReturnStatement),
    expression = returns.length === 1 ? returns[0]!.expression : undefined,
    cleanup = expression ? unwrapTransparentExpression(expression) : null;
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
      node.arguments.length < 2 ||
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
  let safe = true,
    references = 0;
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

function isListenerRefCandidate(
  state: StateCandidate,
  usage: StateUsage | undefined,
  callbacks: ReadonlyMap<string, CallbackBinding>,
): boolean {
  if (
    !state.setterName ||
    !usage ||
    !hasDirectPrimitiveInitializer(state) ||
    usage.localRenderReads !== 0 ||
    usage.transportedOccurrences !== 0 ||
    usage.effectWrites !== 0 ||
    usage.setterCalls === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.setterUsesPreviousValue ||
    usage.shadowed ||
    usage.escaped ||
    usage.setterCallNodes.some((call) => !setterRegionIsSynchronous(call, state.owner))
  ) {
    return false;
  }

  let listenerRead = false,
    safe = true;
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
    const listener = listenerContaining(node, callbacks);
    if (listener) {
      if (
        !listener.dependencies.elements.some(
          (element) => ts.isIdentifier(element) && element.text === state.valueName,
        )
      ) {
        safe = false;
        return;
      }
      listenerRead = true;
      return;
    }
    if ([...callbacks.values()].some((binding) => nodeWithin(node, binding.dependencies))) {
      return;
    }
    const callback = nearestNestedFunction(node, state.owner);
    if (
      callback &&
      callback !== state.owner &&
      (ts.isArrowFunction(callback) ||
        ts.isFunctionDeclaration(callback) ||
        ts.isFunctionExpression(callback)) &&
      !isAsync(callback) &&
      !containsAwaitOrYield(callback.body) &&
      callbackIsEventRooted(callback, state.owner, state.valueName, new Set())
    ) {
      return;
    }
    safe = false;
  });
  return safe && listenerRead;
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
    callbackIsEventRooted(region, owner, "", new Set())
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
