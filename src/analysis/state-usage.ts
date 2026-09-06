import type { StateCandidate, StateUsage } from "./model.js";
import { findAncestorUntil, identifiersNamed, nearestNestedFunction } from "../core/ast.js";
import {
  hasAncestorInSet,
  hasUnstableJsxLifetime,
  isCustomJsxTarget,
  isDirectArgumentToUnknownCall,
  isInsideImportedCallback,
  isInsideJsxCallback,
  isOriginalStateBinding,
  jsxTargetName,
  jsxTransportSite,
} from "./ast-helpers.js";
import {
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
} from "../core/analysis-ast.js";
import {
  isHookDependencyReference,
  isJsxNode,
  isSynchronousRenderCallback,
} from "../rules/state-proofs/callback-sites.js";
import { CALLBACK_HOOK_NAMES } from "./constants.js";
import type { HookImports } from "../core/imports.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import { collectCommandOnlyCallableReads } from "../rules/command-only-state/local-callable-reads.js";
import { isHostTag } from "../core/imports.js";
import { isInsideJsxEventCallback } from "../rules/state-proofs/event-roots.js";
import { nearestRepeatedRenderCall } from "../rules/state-proofs/jsx-subtrees.js";
import { setterCallUsesPreviousValue } from "../rules/state-proofs/state-proofs.js";
import ts from "typescript";

export interface StateUsageScope {
  /** Every lifecycle callback whose reads run after commit. */
  readonly effectNodes: ReadonlySet<ts.Node>;
  readonly imports: HookImports;
  /** Persistence effects whose reads a Legend persist plugin would replace. */
  readonly persistenceSinks: ReadonlySet<ts.Node>;
}

export function collectStateUsage(
  state: StateCandidate,
  { effectNodes, imports, persistenceSinks }: StateUsageScope,
): StateUsage {
  const usage = emptyStateUsage();
  for (const node of stateBindingIdentifiers(state)) {
    recordStateBindingReference(node, state, { effectNodes, imports, persistenceSinks, usage });
  }
  mergeCommandOnlyCallableReads(usage, state, effectNodes);
  return usage;
}

/**
 * No effect reads the state, persistence sinks included. Render-cut proofs read `effectReads`
 * alone because Legend persistence replaces a sink; deleting or ref-replacing the state would not.
 */
export function hasNoEffectReads(usage: StateUsage): boolean {
  return usage.effectReads === 0 && usage.persistenceReads === 0;
}

function recordStateBindingReference(
  node: ts.Identifier,
  state: StateCandidate,
  context: StateReferenceContext,
): void {
  if (isNonValueIdentifier(node)) {
    return;
  }
  if (isDeclarationName(node)) {
    context.usage.shadowed ||= shadowsStateBinding(node, state);
    return;
  }
  if (state.setterName !== null && node.text === state.setterName) {
    classifySetterReference(node, state, context);
    return;
  }
  if (node.text === state.valueName) {
    classifyValueReference(node, state, context);
  }
}

function shadowsStateBinding(node: ts.Identifier, state: StateCandidate): boolean {
  return (
    (node.text === state.valueName ||
      (state.setterName !== null && node.text === state.setterName)) &&
    !isOriginalStateBinding(node, state.call)
  );
}

function emptyStateUsage(): StateUsage {
  return {
    deferredReadNodes: [],
    deferredReads: 0,
    directRenderNodes: [],
    effectReadNodes: [],
    effectReads: 0,
    effectWriteNodes: [],
    effectWrites: 0,
    escapeNodes: [],
    escaped: false,
    eventReads: 0,
    jsxTargets: new Set<string>(),
    legendReactionWrites: 0,
    localRenderReads: 0,
    persistenceReads: 0,
    repeatedTransport: false,
    repeatedValueTransport: false,
    setterCallNodes: [],
    setterCalls: 0,
    setterReferences: 0,
    setterTargets: new Set<string>(),
    setterTransportSites: new Set<number>(),
    setterUsesPreviousValue: false,
    shadowed: false,
    transportNodes: new Map<string, ts.Node[]>(),
    transportedOccurrences: 0,
    unstableTransport: false,
    valueProps: new Map<string, Set<string>>(),
    valueTargets: new Set<string>(),
    valueTransportSites: new Set<number>(),
  };
}

function mergeCommandOnlyCallableReads(
  usage: StateUsage,
  state: StateCandidate,
  effectNodes: ReadonlySet<ts.Node>,
): void {
  const callableReads = collectCommandOnlyCallableReads(state, effectNodes);
  usage.localRenderReads += callableReads.renderSites.length;
  usage.directRenderNodes.push(...callableReads.renderSites);
  if (usage.effectReads === 0) {
    usage.effectReads += callableReads.effectSites.length;
  }
}

function stateBindingIdentifiers(state: StateCandidate): readonly ts.Identifier[] {
  const values = identifiersNamed(state.owner.body, state.valueName);
  if (!state.setterName || state.setterName === state.valueName) {
    return values;
  }
  const setters = identifiersNamed(state.owner.body, state.setterName);
  if (values.length === 0) {
    return setters;
  }
  if (setters.length === 0) {
    return values;
  }

  return mergeByPosition(values, setters);
}

function mergeByPosition(
  left: readonly ts.Identifier[],
  right: readonly ts.Identifier[],
): readonly ts.Identifier[] {
  const ordered: ts.Identifier[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const takeLeft = left[leftIndex]!.pos < right[rightIndex]!.pos;
    ordered.push(takeLeft ? left[leftIndex]! : right[rightIndex]!);
    leftIndex += takeLeft ? 1 : 0;
    rightIndex += takeLeft ? 0 : 1;
  }
  ordered.push(...left.slice(leftIndex), ...right.slice(rightIndex));
  return ordered;
}

function addMapSet<Key, Value>(map: Map<Key, Set<Value>>, key: Key, value: Value): void {
  const values = map.get(key) ?? new Set<Value>();
  values.add(value);
  map.set(key, values);
}

interface StateReferenceContext extends StateUsageScope {
  readonly usage: StateUsage;
}

function classifySetterReference(
  node: ts.Identifier,
  state: StateCandidate,
  context: StateReferenceContext,
): void {
  if (node.parent === state.call.parent) {
    return;
  }
  context.usage.setterReferences += 1;
  if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
    recordSetterCall(node.parent, node, context);
    return;
  }
  recordSetterTransportOrEscape(node, state, context);
}

function recordSetterTransportOrEscape(
  node: ts.Identifier,
  state: StateCandidate,
  context: StateReferenceContext,
): void {
  const jsxAttribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
  if (!jsxAttribute) {
    recordEscape(node, context.usage);
    return;
  }
  recordSetterJsxReference({ jsxAttribute, node }, state, context);
}

function recordSetterCall(
  call: ts.CallExpression,
  node: ts.Identifier,
  { effectNodes, imports, usage }: StateReferenceContext,
): void {
  usage.setterCalls += 1;
  usage.setterCallNodes.push(call);
  usage.setterUsesPreviousValue ||= setterCallUsesPreviousValue(call);
  if (hasAncestorInSet(node, effectNodes)) {
    usage.effectWrites += 1;
    usage.effectWriteNodes.push(call);
  }
  if (isInsideImportedCallback(node, imports.useObserveEffect)) {
    usage.legendReactionWrites += 1;
  }
}

interface JsxTransportRecord {
  readonly jsxAttribute: ts.JsxAttribute;
  readonly node: ts.Identifier;
}

type JsxTransportRole = "escaped" | "local-render" | "transport";

function jsxTransportRole(
  { jsxAttribute, node }: JsxTransportRecord,
  target: string | null,
  imports: HookImports,
): JsxTransportRole {
  if (!target || !isCustomJsxTarget(target) || isHostTag(target, imports)) {
    return "local-render";
  }
  if (target.endsWith(".Provider")) {
    return "escaped";
  }
  return isDirectJsxAttributeExpression(jsxAttribute, node) ? "transport" : "local-render";
}

function transportTargetOrRecordFallback(
  record: JsxTransportRecord,
  { imports, usage }: StateReferenceContext,
  onLocalRender: () => void,
): string | null {
  const target = jsxTargetName(record.jsxAttribute);
  const role = jsxTransportRole(record, target, imports);
  if (role === "escaped") {
    recordEscape(record.node, usage);
    return null;
  }
  if (role === "local-render" || !target) {
    onLocalRender();
    return null;
  }
  return target;
}

function recordSetterJsxReference(
  record: JsxTransportRecord,
  state: StateCandidate,
  context: StateReferenceContext,
): void {
  const { usage } = context;
  const { jsxAttribute } = record;
  const target = transportTargetOrRecordFallback(record, context, () => {
    usage.localRenderReads += 1;
  });
  if (!target) {
    return;
  }
  usage.setterTargets.add(target);
  usage.setterTransportSites.add(jsxTransportSite(jsxAttribute));
  recordJsxTransportSite(jsxAttribute, target, { owner: state.owner, usage });
}

interface TransportBookkeeping {
  readonly owner: RuntimeFunctionLike;
  readonly usage: StateUsage;
}

function recordJsxTransportSite(
  jsxAttribute: ts.JsxAttribute,
  target: string,
  { owner, usage }: TransportBookkeeping,
): boolean {
  usage.jsxTargets.add(target);
  usage.transportedOccurrences += 1;
  usage.transportNodes.set(target, [...(usage.transportNodes.get(target) ?? []), jsxAttribute]);
  const repeatedRender = nearestRepeatedRenderCall(jsxAttribute, owner) !== null;
  usage.repeatedTransport ||= repeatedRender;
  usage.unstableTransport ||= hasUnstableJsxLifetime(jsxAttribute, owner);
  return repeatedRender;
}

function recordLifecycleValueRead(
  node: ts.Identifier,
  state: StateCandidate,
  { effectNodes, persistenceSinks, usage }: StateReferenceContext,
): boolean {
  if (isHookDependencyReference(node, CALLBACK_HOOK_NAMES)) {
    recordDeferredRead(node, usage);
    return true;
  }
  if (hasAncestorInSet(node, persistenceSinks)) {
    usage.persistenceReads += 1;
    return true;
  }
  if (hasAncestorInSet(node, effectNodes)) {
    recordEffectRead(node, usage);
    return true;
  }
  return recordEventCallbackRead(node, state, usage);
}

function recordEventCallbackRead(
  node: ts.Identifier,
  state: StateCandidate,
  usage: StateUsage,
): boolean {
  if (!isInsideJsxEventCallback(node, state.owner)) {
    return false;
  }
  recordDeferredRead(node, usage);
  usage.eventReads += 1;
  return true;
}

function classifyValueReference(
  node: ts.Identifier,
  state: StateCandidate,
  context: StateReferenceContext,
): void {
  if (node.parent === state.call.parent) {
    return;
  }
  if (recordLifecycleValueRead(node, state, context)) {
    return;
  }
  const jsxAttribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
  if (jsxAttribute) {
    recordValueJsxReference({ jsxAttribute, node }, state, context);
    return;
  }
  recordNonAttributeValueRead(node, state, context.usage);
}

function recordNonAttributeValueRead(
  node: ts.Identifier,
  state: StateCandidate,
  usage: StateUsage,
): void {
  if (findAncestorUntil(node, isJsxNode, state.owner)) {
    recordDirectRenderRead(node, usage);
    return;
  }
  recordOutsideRenderValueRead(node, state, usage);
}

function recordOutsideRenderValueRead(
  node: ts.Identifier,
  state: StateCandidate,
  usage: StateUsage,
): void {
  const nestedFunction = nearestNestedFunction(node, state.owner);
  if (nestedFunction && !isSynchronousRenderCallback(nestedFunction)) {
    recordDeferredRead(node, usage);
    return;
  }
  if (isDirectArgumentToUnknownCall(node)) {
    recordEscape(node, usage);
    return;
  }
  recordDirectRenderRead(node, usage);
}

function recordEffectRead(node: ts.Node, usage: StateUsage): void {
  usage.effectReads += 1;
  usage.effectReadNodes.push(node);
}

function recordDeferredRead(node: ts.Node, usage: StateUsage): void {
  usage.deferredReads += 1;
  usage.deferredReadNodes.push(node);
}

function recordEscape(node: ts.Node, usage: StateUsage): void {
  usage.escaped = true;
  usage.escapeNodes.push(node);
}

function recordDirectRenderRead(node: ts.Identifier, usage: StateUsage): void {
  usage.localRenderReads += 1;
  usage.directRenderNodes.push(node);
}

function recordValueJsxReference(
  record: JsxTransportRecord,
  state: StateCandidate,
  context: StateReferenceContext,
): void {
  const { usage } = context;
  const { jsxAttribute, node } = record;
  const target = transportTargetOrRecordFallback(record, context, () => {
    recordDirectRenderRead(node, usage);
  });
  if (!target) {
    return;
  }
  usage.valueTargets.add(target);
  addMapSet(usage.valueProps, target, jsxAttribute.name.getText());
  usage.valueTransportSites.add(jsxTransportSite(jsxAttribute));
  const repeatedRender = recordJsxTransportSite(jsxAttribute, target, {
    owner: state.owner,
    usage,
  });
  usage.repeatedValueTransport ||= repeatedRender || isInsideJsxCallback(jsxAttribute, state.owner);
}
