import type { PassThroughScope } from "../../rules/child-contract/element-identity.js";
import type { StateClassificationContext } from "./classification-context.js";
import { bindingDeclarationCount } from "../../core/analysis-ast.js";
import { callSiteIsKeyed } from "../return-call-sites.js";
import { isCustomHookOwner } from "../ast-helpers.js";
import { jsxElementCount } from "../../rules/state-proofs/jsx-subtrees.js";
import { nearestNestedFunction } from "../../core/ast.js";
import ts from "typescript";
import { wrappedElementIsPassedThrough } from "../../rules/child-contract/element-identity.js";

export function passThroughScope({
  childContracts,
  hostTags,
  state,
}: StateClassificationContext): PassThroughScope {
  return {
    hostTags,
    owner: state.owner,
    resolveComponent: (file, name) =>
      (file === null
        ? childContracts?.resolveComponent(name)
        : childContracts?.resolveComponentIn(file, name)) ?? null,
  };
}

/**
 * Whether a leaf subscriber can wrap every element that receives the value without the element's
 * parent noticing. With `editableChildren`, a call site whose component is declared in this file or
 * resolves to source needs no wrapper, since that child can subscribe itself.
 */
export function valueCallSitesPassThrough(
  context: StateClassificationContext,
  { editableChildren }: { readonly editableChildren: boolean },
): boolean {
  const { childContracts, localComponents, usage } = context;
  const scope = passThroughScope(context);
  const editable = (tag: string): boolean =>
    editableChildren &&
    (localComponents.has(tag) || Boolean(childContracts?.resolveComponent(tag)));
  return [...usage.transportNodes.values()]
    .flat()
    .filter((node): node is ts.JsxAttribute => ts.isJsxAttribute(node))
    .map((attribute) => attribute.parent.parent)
    .filter((callSite) => usage.valueTransportSites.has(callSite.getStart()))
    .every(
      (callSite) =>
        editable(callSite.tagName.getText()) || wrappedElementIsPassedThrough(callSite, scope),
    );
}

export interface PassThroughLeaf {
  readonly callSites: number;
  readonly propName: string;
}

/**
 * Proves from the owner alone that a leaf subscriber around every `target` call site removes a
 * material owner render while the child receives the same props, so the child is never read. The
 * owner reads the value only as one plain attribute, writes it only from closures without companion
 * writes, and renders each call site at owner level under a stable outer tag, without a key, inside
 * a parent that passes the wrapper through.
 */
export function passThroughLeaf(
  context: StateClassificationContext,
  target: string,
): PassThroughLeaf | null {
  const { childContracts, state, usage } = context;
  const [propName, ...otherProps] = usage.valueProps.get(target) ?? [];
  const callSites = (usage.transportNodes.get(target) ?? [])
    .filter(
      (node): node is ts.JsxAttribute =>
        ts.isJsxAttribute(node) && node.name.getText() === propName,
    )
    .map((attribute) => attribute.parent.parent);
  if (
    !childContracts ||
    otherProps.length > 0 ||
    callSites.length !== usage.valueTransportSites.size ||
    context.hasCompanionWrites ||
    usage.unstableTransport ||
    isCustomHookOwner(state.owner) ||
    jsxElementCount(state.owner) < context.materiality.broadOwnerJsx ||
    usage.setterCallNodes.some((call) => nearestNestedFunction(call, state.owner) === null)
  ) {
    return null;
  }
  const scope = passThroughScope(context);
  const stable = callSites.every(
    (callSite) =>
      nearestNestedFunction(callSite, state.owner) === null &&
      !callSiteIsKeyed(callSite) &&
      bindingDeclarationCount(state.owner, callSite.tagName.getText().split(".")[0] ?? "") === 0 &&
      wrappedElementIsPassedThrough(callSite, scope),
  );
  return stable && propName ? { callSites: callSites.length, propName } : null;
}
