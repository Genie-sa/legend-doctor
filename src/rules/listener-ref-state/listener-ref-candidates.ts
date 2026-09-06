import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import { containsAwaitOrYield, isAsync, setterRegionIsSynchronous } from "./synchronous-regions.js";
import { isDeclarationName, isNonValueIdentifier } from "../../core/analysis-ast.js";
import { nearestNestedFunction, nodeWithin, visit } from "../../core/ast.js";
import type { CallbackBinding } from "./listener-callbacks.js";
import { callbackIsEventRooted } from "../state-proofs/event-roots.js";
import { hasDirectPrimitiveInitializer } from "../state-proofs/state-proofs.js";
import ts from "typescript";

type ValueReferenceVerdict = "ignored" | "listener-read" | "unsafe";

export function isListenerRefCandidate(
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
