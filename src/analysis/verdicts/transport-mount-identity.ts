import type { DirectReturnCallSite, StateCandidate, StateUsage } from "../model.js";
import { identifiersNamed, nearestNestedFunction } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { hasUnstableJsxLifetime } from "../ast-helpers.js";
import ts from "typescript";
import { typeChangeKeepsMountIdentity } from "./mount-identity.js";

/**
 * Whether a leaf subscriber can wrap every call site that receives the value or setter without
 * changing which fiber React mounts there. A call site under a conditional or with a key qualifies
 * when neither its guards nor its key read the state, so they stay in the owner and the wrapper
 * mounts and unmounts exactly when the child did, and when the wrapper's type change keeps every
 * fiber. A key stays on the child as the wrapper's only child, which keeps its remount semantics
 * outside a render callback; a keyed element among an array's siblings abstains.
 */
export function transportCallSitesKeepMountIdentity(
  state: StateCandidate,
  usage: StateUsage,
): boolean {
  return (
    !usage.unstableTransport ||
    [...usage.transportNodes.values()]
      .flat()
      .every(
        (node) =>
          ts.isJsxAttribute(node) &&
          (!hasUnstableJsxLifetime(node, state.owner) ||
            wrapKeepsMountIdentity(node.parent.parent, state)),
      )
  );
}

/**
 * Whether a leaf wrapper around the returned call site keeps every fiber, including when the
 * owner's other returns or the other arm of a ternary render a same-typed element in its slot.
 */
export function returnedCallSiteKeepsMountIdentity(
  callSite: DirectReturnCallSite,
  state: StateCandidate,
  usage: StateUsage,
): boolean {
  const { opening } = callSite;
  const element = ts.isJsxOpeningElement(opening) ? opening.parent : opening;
  return (
    transportCallSitesKeepMountIdentity(state, usage) &&
    typeChangeKeepsMountIdentity(element, state.owner)
  );
}

function wrapKeepsMountIdentity(
  callSite: ts.JsxOpeningLikeElement,
  state: StateCandidate,
): boolean {
  const element = ts.isJsxOpeningElement(callSite) ? callSite.parent : callSite;
  const key = callSite.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === "key",
  );
  return (
    (key === undefined ||
      (!readsState(key.initializer, state) &&
        nearestNestedFunction(element, state.owner) === null)) &&
    guardsAbove(element, state.owner).every((guard) => !readsState(guard, state)) &&
    typeChangeKeepsMountIdentity(element, state.owner)
  );
}

function readsState(node: ts.Node | undefined, state: StateCandidate): boolean {
  return identifiersNamed(node, state.valueName).length > 0;
}

/** The conditions and left operands that decide whether `element` mounts. */
function guardsAbove(element: ts.Node, owner: RuntimeFunctionLike): readonly ts.Expression[] {
  const guards: ts.Expression[] = [];
  for (let current = element; current.parent !== owner; current = current.parent) {
    const { parent } = current;
    if (ts.isConditionalExpression(parent) && parent.condition !== current) {
      guards.push(parent.condition);
    }
    if (ts.isBinaryExpression(parent) && parent.right === current) {
      guards.push(parent.left);
    }
  }
  return guards;
}
