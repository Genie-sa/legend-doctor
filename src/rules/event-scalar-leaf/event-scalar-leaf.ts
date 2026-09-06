import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import {
  findAncestor,
  findAncestorUntil,
  isRuntimeFunctionLike,
  nearestNestedFunction,
} from "../../core/ast.js";
import {
  isSafeJsxProjectionReference,
  jsxElementCount,
  jsxElementCountIn,
  nearestRepeatedRenderCall,
} from "../state-proofs/jsx-subtrees.js";
import type { EventOwnedScalarOptions } from "./event-owned-scalars.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { hasIndependentRenderCutWitness } from "../state-proofs/render-cut-witness.js";
import { isEventOwnedNumericState } from "./event-owned-scalars.js";
import { isSafeProjectionExpression } from "../deferred-reveal/safe-projections.js";
import { oneHopRenderProjectionReferences } from "../state-proofs/projection-hops.js";
import { sourceHasRuntimeBinding } from "../state-proofs/binding-lookup.js";
import ts from "typescript";

interface EventScalarLeafOptions extends EventOwnedScalarOptions {
  localComponents: ReadonlySet<string>;
  pureProjectionImports: ReadonlySet<string>;
  sourceComponents: ReadonlySet<string>;
}

interface LeafSurfaces {
  returned: ts.Expression;
  surfaces: Map<number, ts.JsxElement | ts.JsxSelfClosingElement>;
}

export const RESERVED_ATTRIBUTE = /^(?:children|key|ref|render|on[A-Z])/u;

const MIN_LEAF_SURFACES = 2;

const MAX_LEAF_SURFACES = 6;

const MAX_LEAF_ELEMENTS = 6;

const MAX_LEAF_ELEMENT_SHARE = 0.4;

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

function directOwnerReturnExpression(
  node: ts.Node,
  owner: RuntimeFunctionLike,
): ts.Expression | null {
  const statement = findAncestorUntil(node, ts.isReturnStatement, owner);
  return statement?.expression && findAncestor(statement, isRuntimeFunctionLike) === owner
    ? statement.expression
    : null;
}
