import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import { findAncestorUntil, nearestNestedFunction } from "../../core/ast.js";
import {
  isEventOwnedLiteralBooleanState,
  isEventOwnedNumericState,
} from "./event-owned-scalars.js";
import {
  isSafeJsxProjectionReference,
  nearestRepeatedRenderCall,
} from "../state-proofs/jsx-subtrees.js";
import type { EventOwnedScalarOptions } from "./event-owned-scalars.js";
import type { HostTagImports } from "../../core/imports.js";
import { RESERVED_ATTRIBUTE } from "./event-scalar-leaf.js";
import { isHostTag } from "../../core/imports.js";
import { isSafeProjectionExpression } from "../deferred-reveal/safe-projections.js";
import { oneHopRenderProjectionReferences } from "../state-proofs/projection-hops.js";
import ts from "typescript";

interface ReactiveHostPropScalarOptions extends EventOwnedScalarOptions {
  hostTags: HostTagImports;
  pureProjectionImports: ReadonlySet<string>;
}

interface HostPropAnchor {
  attributeStart: number;
  surfaceStart: number;
}

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
    !isHostTag(opening.tagName.getText(), options.hostTags)
  ) {
    return null;
  }
  const surface = ts.isJsxOpeningElement(opening) ? opening.parent : opening;
  return { attributeStart: attribute.getStart(), surfaceStart: surface.getStart() };
}
