import type { StateCandidate, StateUsage } from "../analyze-source.js";
import {
  findAncestor,
  findAncestorUntil,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  visit,
} from "../ast.js";
import {
  hasIndependentRenderCutWitness,
  isHookDependencyReference,
  isSafeJsxProjectionReference,
  jsxElementCount,
  jsxElementCountIn,
  nearestRepeatedRenderCall,
  oneHopRenderProjectionReferences,
  sourceHasRuntimeBinding,
} from "./state-proofs.js";
import {
  isDeclarationName,
  isNonValueIdentifier,
  isPureExpression,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import type { RuntimeFunctionLike } from "../ast.js";
import { isSafeProjectionExpression } from "./deferred-reveal.js";
import { mutationRegionOnlyCallsStateSetters } from "./effect-drafts.js";
import ts from "typescript";

interface EventOwnedScalarOptions {
  eventCallbacks: ReadonlySet<RuntimeFunctionLike>;
  hasCompanionWrites: boolean;
  hasReactiveMutationPath: boolean;
  hasSafeCommands: boolean;
  useCallbackNames: ReadonlySet<string>;
}

interface EventScalarLeafOptions extends EventOwnedScalarOptions {
  localComponents: ReadonlySet<string>;
  pureProjectionImports: ReadonlySet<string>;
  sourceComponents: ReadonlySet<string>;
}

interface ReactiveHostPropScalarOptions extends EventOwnedScalarOptions {
  hostComponents: ReadonlySet<string>;
  pureProjectionImports: ReadonlySet<string>;
}

interface LeafSurfaces {
  returned: ts.Expression;
  surfaces: Map<number, ts.JsxElement | ts.JsxSelfClosingElement>;
}

interface HostPropAnchor {
  attributeStart: number;
  surfaceStart: number;
}

const RESERVED_ATTRIBUTE = /^(?:children|key|ref|render|on[A-Z])/u;
const MIN_OWNER_ELEMENTS = 12;
const MIN_LEAF_SURFACES = 2;
const MAX_LEAF_SURFACES = 6;
const MAX_LEAF_ELEMENTS = 6;
const MAX_LEAF_ELEMENT_SHARE = 0.4;

/**
 * Proves that an event-owned scalar changes one prop on one host surface.
 * A reactive DOM or native component can update that prop without rerendering
 * the component that owns the measurement.
 */
export function isReactiveHostPropScalarState(
  state: StateCandidate,
  usage: StateUsage,
  options: ReactiveHostPropScalarOptions,
): boolean {
  if (
    !isEventOwnedNumericState(state, usage, options) &&
    !isEventOwnedLiteralBooleanState(state, usage, options)
  ) {
    return false;
  }

  const projections = oneHopRenderProjectionReferences(
    state.owner,
    usage.directRenderNodes,
    (query) =>
      isSafeProjectionExpression({
        ...query,
        allowedIdentifierCalls: options.pureProjectionImports,
      }),
  );
  if (!projections || projections.length === 0) {
    return false;
  }
  return sharesOneHostPropAnchor(projections, state, options);
}

function sharesOneHostPropAnchor(
  projections: readonly ts.Identifier[],
  state: StateCandidate,
  options: ReactiveHostPropScalarOptions,
): boolean {
  let shared: HostPropAnchor | null = null;
  for (const projection of projections) {
    const anchor = hostPropAnchor(projection, state, options);
    if (!anchor) {
      return false;
    }
    shared ??= anchor;
    if (
      shared.surfaceStart !== anchor.surfaceStart ||
      shared.attributeStart !== anchor.attributeStart
    ) {
      return false;
    }
  }
  return shared !== null;
}

function hostPropAnchor(
  projection: ts.Identifier,
  state: StateCandidate,
  options: ReactiveHostPropScalarOptions,
): HostPropAnchor | null {
  if (
    nearestNestedFunction(projection, state.owner) ||
    nearestRepeatedRenderCall(projection, state.owner) ||
    !isSafeJsxProjectionReference(projection, state.owner, options.pureProjectionImports)
  ) {
    return null;
  }
  const attribute = findAncestorUntil(projection, ts.isJsxAttribute, state.owner);
  const opening = attribute?.parent.parent;
  if (
    !attribute ||
    !opening ||
    (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) ||
    RESERVED_ATTRIBUTE.test(attribute.name.getText()) ||
    !isHostOpening(opening, options.hostComponents)
  ) {
    return null;
  }
  const surface = ts.isJsxOpeningElement(opening) ? opening.parent : opening;
  return { attributeStart: attribute.getStart(), surfaceStart: surface.getStart() };
}

/**
 * Proves that one event-owned numeric measurement can bypass a broad owner
 * and publish only to a small set of independent render leaves. Callback
 * timing is supplied by the cross-file child contract resolver.
 */
export function isSourceEventScalarLeafState(
  state: StateCandidate,
  usage: StateUsage,
  options: EventScalarLeafOptions,
): boolean {
  if (!isEventOwnedNumericState(state, usage, options)) {
    return false;
  }

  const mathCalls = sourceHasRuntimeBinding(state.owner.getSourceFile(), "Math")
    ? new Set<string>()
    : new Set(["Math.max", "Math.min"]);
  const projections = oneHopRenderProjectionReferences(
    state.owner,
    usage.directRenderNodes,
    (query) =>
      isSafeProjectionExpression({
        ...query,
        allowedIdentifierCalls: options.pureProjectionImports,
        allowedPropertyCalls: mathCalls,
      }),
  );
  if (!projections || projections.length < MIN_LEAF_SURFACES) {
    return false;
  }

  const collected = collectLeafSurfaces(projections, state, options);
  if (!collected) {
    return false;
  }
  return isIndependentLeafCut(collected, state, options);
}

function collectLeafSurfaces(
  projections: readonly ts.Identifier[],
  state: StateCandidate,
  options: EventScalarLeafOptions,
): LeafSurfaces | null {
  const surfaces = new Map<number, ts.JsxElement | ts.JsxSelfClosingElement>();
  let returned: ts.Expression | null = null;
  for (const projection of projections) {
    const surface = leafSurface(projection, state, options);
    const returnExpression = surface && directOwnerReturnExpression(projection, state.owner);
    if (!surface || !returnExpression || (returned !== null && returned !== returnExpression)) {
      return null;
    }
    surfaces.set(surface.getStart(), surface);
    returned = returnExpression;
  }
  return returned === null ? null : { returned, surfaces };
}

function leafSurface(
  projection: ts.Identifier,
  state: StateCandidate,
  options: EventScalarLeafOptions,
): ts.JsxElement | ts.JsxSelfClosingElement | null {
  if (
    nearestNestedFunction(projection, state.owner) ||
    nearestRepeatedRenderCall(projection, state.owner) ||
    !isSafeJsxProjectionReference(projection, state.owner, options.pureProjectionImports)
  ) {
    return null;
  }
  const attribute = findAncestorUntil(projection, ts.isJsxAttribute, state.owner);
  const opening = attribute?.parent.parent;
  if (
    !attribute ||
    !opening ||
    (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) ||
    RESERVED_ATTRIBUTE.test(attribute.name.getText())
  ) {
    return null;
  }
  const surface = ts.isJsxOpeningElement(opening) ? opening.parent : opening;
  return jsxElementCountIn(surface) > MAX_LEAF_ELEMENTS ? null : surface;
}

function isIndependentLeafCut(
  collected: LeafSurfaces,
  state: StateCandidate,
  options: EventScalarLeafOptions,
): boolean {
  const leaves = [...collected.surfaces.values()];
  const leafElements = leaves.reduce((sum, surface) => sum + jsxElementCountIn(surface), 0);
  return (
    leaves.length >= MIN_LEAF_SURFACES &&
    leaves.length <= MAX_LEAF_SURFACES &&
    leafElements / jsxElementCount(state.owner) <= MAX_LEAF_ELEMENT_SHARE &&
    hasIndependentRenderCutWitness({
      returned: collected.returned,
      excluded: leaves,
      localComponents: options.localComponents,
      sourceComponents: options.sourceComponents,
    })
  );
}

function isEventOwnedNumericState(
  state: StateCandidate,
  usage: StateUsage,
  options: EventOwnedScalarOptions,
): boolean {
  if (
    !hasNumericInitializer(state) ||
    usage.setterCallNodes.length !== 1 ||
    usage.setterCalls !== 1 ||
    !isEventOwnedScalarBase(state, usage, options)
  ) {
    return false;
  }

  const setterCall = usage.setterCallNodes[0]!;
  const [argument] = setterCall.arguments;
  const callback = nearestNestedFunction(setterCall, state.owner);
  const setterName = state.setterName!;
  return (
    setterCall.arguments.length === 1 &&
    argument !== undefined &&
    isPureExpression(argument) &&
    callback !== null &&
    options.eventCallbacks.has(callback) &&
    mutationRegionOnlyCallsStateSetters(callback, new Set([setterName]))
  );
}

function isEventOwnedLiteralBooleanState(
  state: StateCandidate,
  usage: StateUsage,
  options: EventOwnedScalarOptions,
): boolean {
  return (
    state.call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword &&
    usage.setterCallNodes.length > 0 &&
    usage.setterCalls === usage.setterCallNodes.length &&
    isEventOwnedScalarBase(state, usage, options) &&
    usage.setterCallNodes.every((call) => {
      const [argument] = call.arguments;
      const callback = nearestNestedFunction(call, state.owner);
      return (
        call.arguments.length === 1 &&
        argument !== undefined &&
        (argument.kind === ts.SyntaxKind.TrueKeyword ||
          argument.kind === ts.SyntaxKind.FalseKeyword) &&
        callback !== null &&
        options.eventCallbacks.has(callback) &&
        mutationRegionOnlyCallsStateSetters(callback, new Set([state.setterName!]))
      );
    })
  );
}

function isEventOwnedScalarBase(
  state: StateCandidate,
  usage: StateUsage,
  options: EventOwnedScalarOptions,
): boolean {
  return (
    state.setterName !== null &&
    jsxElementCount(state.owner) >= MIN_OWNER_ELEMENTS &&
    usage.localRenderReads > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences === 0 &&
    !options.hasCompanionWrites &&
    !options.hasReactiveMutationPath &&
    options.hasSafeCommands &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    stateValueReferencesAreRenderOnly(state, usage) &&
    setterReferencesAreCallsOrCallbackDependencies(state, options.useCallbackNames)
  );
}

function hasNumericInitializer(state: StateCandidate): boolean {
  const [initializer] = state.call.arguments;
  if (!initializer) {
    return false;
  }
  const value = unwrapTransparentExpression(initializer);
  if (ts.isNumericLiteral(value)) {
    return true;
  }
  return (
    ts.isPrefixUnaryExpression(value) &&
    (value.operator === ts.SyntaxKind.PlusToken || value.operator === ts.SyntaxKind.MinusToken) &&
    ts.isNumericLiteral(unwrapTransparentExpression(value.operand))
  );
}

function stateValueReferencesAreRenderOnly(state: StateCandidate, usage: StateUsage): boolean {
  const renderReads = new Set(usage.directRenderNodes);
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (!renderReads.has(node)) {
      safe = false;
    }
  });
  return safe;
}

function setterReferencesAreCallsOrCallbackDependencies(
  state: StateCandidate,
  useCallbackNames: ReadonlySet<string>,
): boolean {
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.setterName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      return;
    }
    if (isHookDependencyReference(node, useCallbackNames)) {
      return;
    }
    safe = false;
  });
  return safe;
}

function directOwnerReturnExpression(
  node: ts.Node,
  owner: RuntimeFunctionLike,
): ts.Expression | null {
  const statement = findAncestorUntil(node, ts.isReturnStatement, owner);
  return statement?.expression && findAncestor(statement, isRuntimeFunctionLike) === owner
    ? statement.expression
    : null;
}

function isHostOpening(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  hostComponents: ReadonlySet<string>,
): boolean {
  const target = opening.tagName;
  return (
    ts.isIdentifier(target) && (/^[a-z]/u.test(target.text) || hostComponents.has(target.text))
  );
}
