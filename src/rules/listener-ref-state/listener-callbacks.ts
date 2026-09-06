import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { containsAwaitOrYield, isAsync } from "./synchronous-regions.js";
import { visit, visitSkippingNestedFunctions } from "../../core/ast.js";
import type { EffectCandidate } from "../../analysis/model.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isImportedHookCall } from "../../core/imports.js";
import ts from "typescript";

const LISTENER_CALL_ARGUMENT_COUNT = 2;

export interface CallbackBinding {
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

interface ListenerReference {
  readonly name: string;
  readonly nodes: readonly ts.Identifier[];
}

export function listenerCallbacks(
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
