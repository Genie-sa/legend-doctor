import type {
  ComponentScope,
  ControlledProjectionCut,
  StateCandidate,
  StateUsage,
} from "./model.js";
import {
  controlledLeafCallSite,
  controlledProjectionRenderReferences,
} from "./controlled-leaf-call-site.js";
import { findAncestorUntil, nodeWithin } from "../core/ast.js";
import {
  jsxElementCount,
  jsxElementCountIn,
  lowestCommonJsxSubtree,
  nearestRepeatedRenderCall,
} from "../rules/state-proofs/jsx-subtrees.js";
import { jsxSubtreeForOpening, jsxSubtreeLabel, jsxTransportSite } from "./ast-helpers.js";
import type { JsxSubtreeNode } from "../rules/deferred-reveal/jsx-subtrees.js";
import { MAX_LEAF_SUBTREE_RATIO } from "./constants.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import { firstDirectJsxOpeningAt } from "./return-call-sites.js";
import { hasDirectInteractionSetter } from "./interaction-setters.js";
import { hasIndependentRenderCutWitness } from "../rules/state-proofs/render-cut-witness.js";
import { isValueTransitionAttribute } from "./membership-toggle.js";
import { isValueTransitionProp } from "../core/analysis-ast.js";
import { shareUniqueOwnerReturn } from "./callbacks/local-callbacks.js";
import ts from "typescript";

function setterCallsConfinedToValueSubtree(
  usage: StateUsage,
  body: ts.Node,
  valueSite: number,
): boolean {
  const opening = firstDirectJsxOpeningAt(body, valueSite);
  if (!opening) {
    return false;
  }
  const subtree = jsxSubtreeForOpening(opening);
  return usage.setterCallNodes.every((call) => nodeWithin(call, subtree));
}

export function setterOwnedByValueCallSite(usage: StateUsage, owner: RuntimeFunctionLike): boolean {
  const [valueSite] = [...usage.valueTransportSites];
  if (valueSite === undefined || usage.setterReferences === 0) {
    return false;
  }
  const transportsSetterAtValueSite =
    usage.setterTargets.size === 1 &&
    usage.setterTransportSites.size === 1 &&
    [...usage.setterTransportSites][0] === valueSite;
  if (
    transportsSetterAtValueSite &&
    usage.setterCalls === 0 &&
    [...usage.valueTargets][0] === [...usage.setterTargets][0]
  ) {
    return true;
  }
  if (
    !usage.escaped &&
    (usage.setterReferences === usage.setterCalls || transportsSetterAtValueSite) &&
    usage.setterCallNodes.length > 0 &&
    owner.body &&
    setterCallsConfinedToValueSubtree(usage, owner.body, valueSite)
  ) {
    return true;
  }
  return (
    usage.setterReferences === usage.setterCalls &&
    usage.setterCallNodes.length > 0 &&
    usage.setterCallNodes.every((call) => {
      const attribute = findAncestorUntil(call, ts.isJsxAttribute, owner);
      return attribute !== null && jsxTransportSite(attribute) === valueSite;
    })
  );
}

export function setterOwnedByValueTransitionCallSite(
  state: StateCandidate,
  usage: StateUsage,
): boolean {
  const { setterName } = state;
  if (!setterName || !setterOwnedByValueCallSite(usage, state.owner)) {
    return false;
  }
  if (usage.setterCalls > 0) {
    return usage.setterCallNodes.every((call) => setterCallIsValueTransition(call, state));
  }
  const [valueSite] = [...usage.valueTransportSites];
  if (valueSite === undefined || !state.owner.body) {
    return false;
  }
  const opening = firstDirectJsxOpeningAt(state.owner.body, valueSite);
  return (
    opening !== null &&
    hasDirectInteractionSetter(opening, setterName, (name) =>
      isValueTransitionAttribute(opening, name, state.valueName),
    )
  );
}

function setterCallIsValueTransition(call: ts.CallExpression, state: StateCandidate): boolean {
  const attribute = findAncestorUntil(call, ts.isJsxAttribute, state.owner);
  const opening = attribute?.parent.parent;
  return (
    attribute !== null &&
    opening !== undefined &&
    (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) &&
    isValueTransitionAttribute(opening, attribute.name.getText(), state.valueName)
  );
}

export function controlledLeafRenderCut(
  state: StateCandidate,
  usage: StateUsage,
  { localComponents, sourceComponents }: ComponentScope,
): {
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  returned: ts.Expression;
} | null {
  const callSite = controlledLeafCallSite(state, usage, isValueTransitionProp);
  if (!callSite) {
    return null;
  }
  const controlled = callSite.opening;
  const controlledSubtree: ts.Node = ts.isJsxOpeningElement(controlled)
    ? controlled.parent
    : controlled;
  return hasIndependentRenderCutWitness({
    returned: callSite.returned,
    excluded: [controlledSubtree],
    localComponents,
    sourceComponents,
  })
    ? callSite
    : null;
}

function controlledProjectionConsumer(
  state: StateCandidate,
  usage: StateUsage,
): JsxSubtreeNode | null {
  const references = controlledProjectionRenderReferences(state, usage);
  if (
    !references ||
    references.some((reference) => nearestRepeatedRenderCall(reference, state.owner) !== null)
  ) {
    return null;
  }
  const consumer = lowestCommonJsxSubtree(references, state.owner);
  if (
    !consumer ||
    jsxElementCountIn(consumer) / jsxElementCount(state.owner) > MAX_LEAF_SUBTREE_RATIO
  ) {
    return null;
  }
  return consumer;
}

export function controlledLeafProjectionCut(
  state: StateCandidate,
  usage: StateUsage,
  { localComponents, sourceComponents }: ComponentScope,
): ControlledProjectionCut | null {
  const callSite = controlledLeafCallSite(state, usage);
  if (!callSite) {
    return null;
  }
  const consumer = controlledProjectionConsumer(state, usage);
  if (!consumer) {
    return null;
  }
  const controlled: ts.Node = ts.isJsxOpeningElement(callSite.opening)
    ? callSite.opening.parent
    : callSite.opening;
  if (
    controlled === consumer ||
    nodeWithin(controlled, consumer) ||
    nodeWithin(consumer, controlled) ||
    !shareUniqueOwnerReturn(controlled, consumer, state.owner) ||
    !hasIndependentRenderCutWitness({
      returned: callSite.returned,
      excluded: [controlled, consumer],
      localComponents,
      sourceComponents,
    })
  ) {
    return null;
  }
  return {
    consumerLabel: jsxSubtreeLabel(consumer),
    consumerLine:
      consumer.getSourceFile().getLineAndCharacterOfPosition(consumer.getStart()).line + 1,
  };
}

export function controlledSameCallSiteProjectionCut(
  state: StateCandidate,
  usage: StateUsage,
  { localComponents, sourceComponents }: ComponentScope,
): boolean {
  const callSite = controlledLeafCallSite(state, usage, isValueTransitionProp);
  if (!callSite) {
    return false;
  }
  const references = controlledProjectionRenderReferences(state, usage);
  if (
    !references ||
    references.some(
      (reference) =>
        !nodeWithin(reference, callSite.opening) ||
        nearestRepeatedRenderCall(reference, state.owner) !== null,
    )
  ) {
    return false;
  }
  const controlled: ts.Node = ts.isJsxOpeningElement(callSite.opening)
    ? callSite.opening.parent
    : callSite.opening;
  return hasIndependentRenderCutWitness({
    returned: callSite.returned,
    excluded: [controlled],
    localComponents,
    sourceComponents,
  });
}
