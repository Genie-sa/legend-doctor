import type { StateCandidate, StateUsage } from "./model.js";
import { directBranchReturnCallSite, directUniqueReturnCallSite } from "./return-call-sites.js";
import {
  findAncestorUntil,
  nearestNestedFunction,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../core/ast.js";
import {
  hasDirectInteractionSetter,
  hasInlineInteractionSetter,
  hasInteractionSetterAdapter,
} from "./interaction-setters.js";
import {
  isControlledInteractionProp,
  isDeclarationName,
  isNonValueIdentifier,
} from "../core/analysis-ast.js";
import {
  isSafeJsxProjectionReference,
  jsxElementCount,
  jsxElementCountIn,
} from "../rules/state-proofs/jsx-subtrees.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import { callbackIsEventRooted } from "../rules/state-proofs/event-roots.js";
import { isCustomHookOwner } from "./ast-helpers.js";
import { isPairedSetterProp } from "./membership-toggle.js";
import { isSynchronousRenderCallback } from "../rules/state-proofs/callback-sites.js";
import { oneHopRenderProjectionReferences } from "../rules/state-proofs/projection-hops.js";
import { stateMayHoldCallable } from "../rules/state-proofs/state-proofs.js";
import ts from "typescript";

export function cohesiveControlledLeafOwner(
  state: StateCandidate,
  usage: StateUsage,
): string | null {
  if (
    isCustomHookOwner(state.owner) ||
    stateMayHoldCallable(state) ||
    usage.localRenderReads !== 0 ||
    usage.effectReads !== 0 ||
    usage.effectWrites !== 0 ||
    usage.deferredReads !== 0 ||
    usage.transportedOccurrences === 0 ||
    usage.repeatedTransport ||
    usage.shadowed ||
    usage.escaped
  ) {
    return null;
  }
  const directCallSite = directUniqueReturnCallSite(usage, state.owner);
  if (!directCallSite) {
    return null;
  }
  const controlled: ts.Node = ts.isJsxOpeningElement(directCallSite.opening)
    ? directCallSite.opening.parent
    : directCallSite.opening;
  if (
    jsxElementCount(state.owner) !== jsxElementCountIn(controlled) ||
    !stateReferencesConfinedTo(state, controlled)
  ) {
    return null;
  }
  return [...usage.valueTargets][0] ?? "controlled child";
}

export function controlledLeafCallSite(
  state: StateCandidate,
  usage: StateUsage,
  isInteractionProp: (name: string) => boolean = isControlledInteractionProp,
): {
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  returned: ts.Expression;
} | null {
  if (
    !state.owner.body ||
    !state.setterName ||
    ownerHasRefBackedRenderRead(state.owner) ||
    usage.valueTransportSites.size !== 1 ||
    usage.valueTargets.size !== 1 ||
    !usage.setterCallNodes.every((call) => {
      const callback = nearestNestedFunction(call, state.owner);
      return callback !== null && !isSynchronousRenderCallback(callback);
    })
  ) {
    return null;
  }
  const callSite =
    directUniqueReturnCallSite(usage, state.owner) ??
    directBranchReturnCallSite(usage, state.owner);
  if (!callSite) {
    return null;
  }
  const isStateInteractionProp = (name: string): boolean =>
    isInteractionProp(name) || isPairedSetterProp(callSite.opening, name, state.valueName);
  if (
    !hasDirectInteractionSetter(callSite.opening, state.setterName, isStateInteractionProp) &&
    !hasInlineInteractionSetter(callSite.opening, state, {
      isInteractionProp: isStateInteractionProp,
      usage,
    }) &&
    !hasInteractionSetterAdapter(callSite.opening, state, {
      isInteractionProp: isStateInteractionProp,
      usage,
    })
  ) {
    return null;
  }
  return callSite;
}

export function stateReferencesConfinedTo(state: StateCandidate, boundary: ts.Node): boolean {
  if (!state.owner.body) {
    return false;
  }
  let confined = true;
  visit(state.owner.body, (node) => {
    if (
      !confined ||
      !ts.isIdentifier(node) ||
      (node.text !== state.valueName && node.text !== state.setterName) ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (!nodeWithin(node, boundary)) {
      confined = false;
    }
  });
  return confined;
}

function ownerHasRefBackedRenderRead(owner: RuntimeFunctionLike): boolean {
  if (!owner.body) {
    return false;
  }
  let found = false;
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (!found && ts.isPropertyAccessExpression(node) && node.name.text === "current") {
      found = true;
    }
  });
  return found;
}

export function controlledProjectionRenderReferences(
  state: StateCandidate,
  usage: StateUsage,
): readonly ts.Identifier[] | null {
  const references = oneHopRenderProjectionReferences(state.owner, usage.directRenderNodes);
  if (!references) {
    return null;
  }
  if (
    references.some((reference) => classifyProjectionReference(reference, state.owner) === "unsafe")
  ) {
    return null;
  }
  const renderReferences = references.filter(
    (reference) => classifyProjectionReference(reference, state.owner) === "render",
  );
  return renderReferences.length > 0 ? renderReferences : null;
}

type ProjectionReferenceRole = "event" | "render" | "unsafe";

function classifyProjectionReference(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
): ProjectionReferenceRole {
  if (findAncestorUntil(reference, ts.isJsxAttribute, owner)) {
    return isSafeJsxProjectionReference(reference, owner) ? "render" : "unsafe";
  }
  return referenceIsEventRooted(reference, owner) ? "event" : "unsafe";
}

function referenceIsEventRooted(reference: ts.Identifier, owner: RuntimeFunctionLike): boolean {
  const callback = nearestNestedFunction(reference, owner);
  if (
    !callback ||
    (!ts.isArrowFunction(callback) &&
      !ts.isFunctionDeclaration(callback) &&
      !ts.isFunctionExpression(callback))
  ) {
    return false;
  }
  return callbackIsEventRooted({
    callback,
    owner,
    dependencyName: reference.text,
    seen: new Set(),
  });
}
