import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import {
  callbackIsExposedOnlyByImperativeHandle,
  isUnshadowedReactHookCall,
} from "./imperative-handle-exposure.js";
import { findAncestorUntil, nodeWithin, visit } from "../../core/ast.js";
import { isDeclarationName, isNonValueIdentifier } from "../../core/analysis-ast.js";
import { isNullableSetState, isSetOrMapState } from "./state-value-shapes.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isStableRenderedMembership } from "./rendered-list-membership.js";
import ts from "typescript";

export function isImperativeRenderedCollectionState(
  state: StateCandidate,
  usage: StateUsage | undefined,
  imports: HookImports,
): boolean {
  const { body } = state.owner;
  if (!usage || !state.setterName || !body || !usageAllowsImperativeCollection(state, usage)) {
    return false;
  }
  const reads = collectImperativeCollectionReads(body, state, imports);
  const setterCallbacks = setterCommandCallbacks(usage, state, imports);
  const commandCallbacks =
    reads.safe && reads.renderedMembership && setterCallbacks
      ? new Set([...reads.commandCallbacks, ...setterCallbacks])
      : null;
  const soleCallback = commandCallbacks?.size === 1 ? [...commandCallbacks][0]! : null;
  if (!soleCallback) {
    return false;
  }
  return (
    callbackReadsStateWithDependency(soleCallback, state) &&
    callbackIsExposedOnlyByImperativeHandle(soleCallback, state.owner, imports)
  );
}

function usageAllowsImperativeCollection(state: StateCandidate, usage: StateUsage): boolean {
  return (
    (isSetOrMapState(state.call) || isNullableSetState(state.call)) &&
    usage.localRenderReads > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.transportedOccurrences === 0 &&
    usage.setterCalls > 0 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped
  );
}

interface ImperativeCollectionReads {
  commandCallbacks: Set<ts.ArrowFunction | ts.FunctionExpression>;
  renderedMembership: boolean;
  safe: boolean;
}

function collectImperativeCollectionReads(
  body: ts.Node,
  state: StateCandidate,
  imports: HookImports,
): ImperativeCollectionReads {
  const commandCallbacks = new Set<ts.ArrowFunction | ts.FunctionExpression>();
  let renderedMembership = false;
  let safe = true;
  visit(body, (node) => {
    if (!safe || !isCollectionValueRead(node, state)) {
      return;
    }
    const read = classifyCollectionRead(node, state, imports);
    if (read.kind === "unsafe") {
      safe = false;
    } else if (read.kind === "membership") {
      renderedMembership = true;
    } else {
      commandCallbacks.add(read.callback);
    }
  });
  return { commandCallbacks, renderedMembership, safe };
}

function isCollectionValueRead(node: ts.Node, state: StateCandidate): node is ts.Identifier {
  return (
    ts.isIdentifier(node) &&
    node.text === state.valueName &&
    !isDeclarationName(node) &&
    !isNonValueIdentifier(node) &&
    node.parent !== state.call.parent
  );
}

type CollectionRead =
  | { callback: ts.ArrowFunction | ts.FunctionExpression; kind: "command" }
  | { kind: "membership" }
  | { kind: "unsafe" };

function classifyCollectionRead(
  node: ts.Identifier,
  state: StateCandidate,
  imports: HookImports,
): CollectionRead {
  const dependencyCallback = useCallbackDependencyOwner(node, state.owner, imports);
  if (dependencyCallback) {
    return { callback: dependencyCallback, kind: "command" };
  }
  const membership = membershipCallOn(node);
  if (membership) {
    return isStableRenderedMembership(membership, state.owner)
      ? { kind: "membership" }
      : { kind: "unsafe" };
  }
  const callback = imperativeCommandCallback(node, state.owner, imports);
  return callback ? { callback, kind: "command" } : { kind: "unsafe" };
}

function membershipCallOn(node: ts.Identifier): ts.CallExpression | null {
  const property =
    ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
      ? node.parent
      : null;
  return property?.name.text === "has" &&
    ts.isCallExpression(property.parent) &&
    property.parent.expression === property
    ? property.parent
    : null;
}

function setterCommandCallbacks(
  usage: StateUsage,
  state: StateCandidate,
  imports: HookImports,
): Set<ts.ArrowFunction | ts.FunctionExpression> | null {
  const callbacks = new Set<ts.ArrowFunction | ts.FunctionExpression>();
  for (const call of usage.setterCallNodes) {
    const callback = imperativeCommandCallback(call, state.owner, imports);
    if (!callback) {
      return null;
    }
    callbacks.add(callback);
  }
  return callbacks;
}

function useCallbackDependencyOwner(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const call = findAncestorUntil(node, ts.isCallExpression, owner);
  const callback = call?.arguments[0];
  return call &&
    call.arguments[1] &&
    nodeWithin(node, call.arguments[1]) &&
    isUnshadowedReactHookCall({ call, hook: "useCallback", imports, owner }) &&
    callback &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    ? callback
    : null;
}

function imperativeCommandCallback(
  node: ts.Node,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): ts.ArrowFunction | ts.FunctionExpression | null {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) {
      continue;
    }
    const call: ts.Node = current.parent;
    if (
      ts.isCallExpression(call) &&
      call.arguments[0] === current &&
      isUnshadowedReactHookCall({ call, hook: "useCallback", imports, owner }) &&
      ts.isVariableDeclaration(call.parent) &&
      ts.isIdentifier(call.parent.name)
    ) {
      return current;
    }
  }
  return null;
}

function callbackReadsStateWithDependency(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  state: StateCandidate,
): boolean {
  const call = callback.parent;
  const dependencies = ts.isCallExpression(call) ? call.arguments[1] : undefined;
  if (!dependencies || !ts.isArrayLiteralExpression(dependencies)) {
    return false;
  }
  let readsState = false;
  visit(callback.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === state.valueName &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      readsState = true;
    }
  });
  return (
    !readsState ||
    dependencies.elements.some(
      (element) => ts.isIdentifier(element) && element.text === state.valueName,
    )
  );
}
