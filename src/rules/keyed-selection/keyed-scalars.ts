import { LIST_SIZED_OWNER_JSX_ELEMENTS, MAX_CONSUMER_JSX_SHARE } from "./model.js";
import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import { callbackIsEventRooted, isInsideJsxEventCallback } from "../state-proofs/event-roots.js";
import { findAncestorUntil, nearestNestedFunction, nodeWithin } from "../../core/ast.js";
import {
  hasDirectPrimitiveInitializer,
  hasOnlyEventCommandReads,
  stateMayHoldCallable,
} from "../state-proofs/state-proofs.js";
import { isHookDependencyReference, isJsxNode } from "../state-proofs/callback-sites.js";
import { isRepeatedScalarKeyProjection, isSelectedItemLookup } from "./scalar-key-comparisons.js";
import {
  isSafeJsxProjectionReference,
  jsxElementCount,
  jsxElementCountIn,
  lowestCommonJsxSubtree,
  nearestRepeatedRenderCall,
} from "../state-proofs/jsx-subtrees.js";
import { expressionDependsOnBinding } from "../state-proofs/binding-lookup.js";
import { hasSupportedKeyedSelectionInitializer } from "./state-value-shapes.js";
import { isPureExpression } from "../../core/analysis-ast.js";
import { isRenderGateReference } from "../deferred-reveal/render-gates.js";
import { mutationRegionOnlyCallsStateSetters } from "../effect-drafts/draft-mutations.js";
import { oneHopRenderProjectionReferences } from "../state-proofs/projection-hops.js";
import { repeatedRenderHasStableItemKey } from "../state-proofs/unique-repeated-selection.js";
import ts from "typescript";

export function isKeyedLeafScalarState(
  state: StateCandidate,
  usage: StateUsage | undefined,
): boolean {
  return (
    usage !== undefined &&
    hasDirectPrimitiveInitializer(state) &&
    !stateMayHoldCallable(state) &&
    jsxElementCount(state.owner) >= LIST_SIZED_OWNER_JSX_ELEMENTS &&
    usage.directRenderNodes.length > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.transportedOccurrences === 0 &&
    usage.setterCalls > 0 &&
    usage.setterReferences === usage.setterCalls &&
    usage.setterCallNodes.every(
      (call) =>
        call.arguments.length === 1 &&
        call.arguments[0] !== undefined &&
        isPureExpression(call.arguments[0]),
    ) &&
    (usage.deferredReads === 0 || hasOnlyEventCommandReads(state)) &&
    !usage.shadowed &&
    !usage.escaped &&
    usage.directRenderNodes.every((node) => isRepeatedScalarKeyProjection(node, state))
  );
}

export function isKeyedScalarWithSecondaryLeaf(
  state: StateCandidate,
  usage: StateUsage | undefined,
): boolean {
  if (!usage || !usageAllowsKeyedScalarSelection(state, usage)) {
    return false;
  }
  const producer = repeatedScalarSelectionProducer(state, usage);
  const secondaryNodes = producer && secondaryRenderNodes(usage.directRenderNodes, state, producer);
  const secondaryReferences = secondaryNodes && secondaryLeafReferences(state, secondaryNodes);
  const renderReferences =
    secondaryReferences && secondaryRenderReferences(secondaryReferences, state);
  return (
    producer !== null &&
    renderReferences !== null &&
    consumerIsBoundedSibling(producer, renderReferences, state)
  );
}

function usageAllowsKeyedScalarSelection(state: StateCandidate, usage: StateUsage): boolean {
  return (
    hasSupportedKeyedSelectionInitializer(state) &&
    !stateMayHoldCallable(state) &&
    jsxElementCount(state.owner) >= LIST_SIZED_OWNER_JSX_ELEMENTS &&
    usage.directRenderNodes.length > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.transportedOccurrences === 0 &&
    usage.setterCalls > 0 &&
    usage.setterReferences === usage.setterCalls &&
    usage.setterCallNodes.every(
      (call) =>
        call.arguments.length === 1 &&
        call.arguments[0] !== undefined &&
        isPureExpression(call.arguments[0]),
    ) &&
    !usage.shadowed &&
    !usage.escaped &&
    hasOnlyEventCommandReads(state, new Set(usage.directRenderNodes))
  );
}

function secondaryRenderNodes(
  directRenderNodes: readonly ts.Node[],
  state: StateCandidate,
  producer: ts.CallExpression,
): ts.Node[] | null {
  const secondaryNodes: ts.Node[] = [];
  for (const node of directRenderNodes) {
    if (!isRepeatedScalarKeyProjection(node, state)) {
      secondaryNodes.push(node);
    } else if (nearestRepeatedRenderCall(node, state.owner) !== producer) {
      return null;
    }
  }
  return secondaryNodes;
}

function secondaryLeafReferences(
  state: StateCandidate,
  secondaryNodes: readonly ts.Node[],
): readonly ts.Identifier[] | null {
  return oneHopRenderProjectionReferences(
    state.owner,
    secondaryNodes,
    ({ expression, reference }) =>
      isPureExpression(expression) ||
      (ts.isIdentifier(reference) && isSelectedItemLookup(expression, reference)),
  );
}

function secondaryRenderReferences(
  references: readonly ts.Identifier[],
  state: StateCandidate,
): ts.Identifier[] | null {
  const renderReferences: ts.Identifier[] = [];
  for (const reference of references) {
    const kind = classifySecondaryReference(reference, state);
    if (kind === "unsafe") {
      return null;
    }
    if (kind === "render") {
      renderReferences.push(reference);
    }
  }
  return renderReferences;
}

type SecondaryReferenceKind = "deferred" | "render" | "unsafe";

function classifySecondaryReference(
  reference: ts.Identifier,
  state: StateCandidate,
): SecondaryReferenceKind {
  const callback = nearestNestedFunction(reference, state.owner);
  if (callback) {
    return (ts.isArrowFunction(callback) ||
      ts.isFunctionDeclaration(callback) ||
      ts.isFunctionExpression(callback)) &&
      callbackIsEventRooted({
        callback,
        owner: state.owner,
        dependencyName: reference.text,
        seen: new Set(),
      })
      ? "deferred"
      : "unsafe";
  }
  if (findAncestorUntil(reference, isJsxNode, state.owner)) {
    return isSafeSecondaryRenderReference(reference, state) ? "render" : "unsafe";
  }
  return isDeferredHookDependency(reference, state) ? "deferred" : "unsafe";
}

function isSafeSecondaryRenderReference(reference: ts.Identifier, state: StateCandidate): boolean {
  return (
    !nearestRepeatedRenderCall(reference, state.owner) &&
    !(
      isRenderGateReference(reference, state.owner) &&
      !findAncestorUntil(reference, ts.isJsxAttribute, state.owner)
    ) &&
    isSafeJsxProjectionReference(reference, state.owner, new Set(["cn"]))
  );
}

function isDeferredHookDependency(reference: ts.Identifier, state: StateCandidate): boolean {
  if (!isHookDependencyReference(reference, new Set(["useCallback"]))) {
    return false;
  }
  const call = findAncestorUntil(reference, ts.isCallExpression, state.owner);
  const candidate = call?.arguments[0];
  return (
    candidate !== undefined &&
    (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) &&
    callbackIsEventRooted({
      callback: candidate,
      owner: state.owner,
      dependencyName: reference.text,
      seen: new Set(),
    })
  );
}

function consumerIsBoundedSibling(
  producer: ts.CallExpression,
  renderReferences: readonly ts.Identifier[],
  state: StateCandidate,
): boolean {
  const consumer = lowestCommonJsxSubtree(renderReferences, state.owner);
  const producerReturn = findAncestorUntil(producer, ts.isReturnStatement, state.owner);
  const consumerReturn = consumer
    ? findAncestorUntil(consumer, ts.isReturnStatement, state.owner)
    : null;
  return (
    consumer !== null &&
    jsxElementCountIn(consumer) / jsxElementCount(state.owner) <= MAX_CONSUMER_JSX_SHARE &&
    producerReturn !== null &&
    producerReturn === consumerReturn &&
    !nodeWithin(producer, consumer) &&
    !nodeWithin(consumer, producer)
  );
}

function repeatedScalarSelectionProducer(
  state: StateCandidate,
  usage: StateUsage,
): ts.CallExpression | null {
  const { setterName } = state;
  if (!setterName) {
    return null;
  }
  const producers = new Set<ts.CallExpression>();
  for (const call of usage.setterCallNodes) {
    const repeated = keyedEventProducerCall(call, state, setterName);
    if (repeated) {
      producers.add(repeated);
    }
  }
  return producers.size === 1 ? [...producers][0]! : null;
}

function keyedEventProducerCall(
  call: ts.CallExpression,
  state: StateCandidate,
  setterName: string,
): ts.CallExpression | null {
  const repeated = nearestRepeatedRenderCall(call, state.owner);
  const callback = repeated?.arguments[0];
  const event = nearestNestedFunction(call, state.owner);
  const [argument] = call.arguments;
  if (
    !repeated ||
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !event ||
    event === callback ||
    (!ts.isArrowFunction(event) && !ts.isFunctionExpression(event)) ||
    !argument ||
    !callback.parameters.some((parameter) =>
      expressionDependsOnBinding(argument, parameter.name, callback),
    ) ||
    !repeatedRenderHasStableItemKey(callback) ||
    !isInsideJsxEventCallback(call, state.owner) ||
    !mutationRegionOnlyCallsStateSetters(event, new Set([setterName]))
  ) {
    return null;
  }
  return repeated;
}
