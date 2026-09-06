import type {
  CallbackContractSourceResolver,
  CallbackDeferral,
  CallbackTrace,
  ChildComponentSource,
} from "./model.js";
import {
  arrayBindingsStayWithinTrackedConsumers,
  arrayItemNames,
  spreadCallbackIsOverridden,
  trackedArrayNames,
} from "./array-prop-tracking.js";
import {
  atJsxInvocation,
  jsxAttributeDirectlyCarries,
  jsxOwnerIsDeferredEventTarget,
  jsxOwnerTarget,
} from "./jsx-owner.js";
import {
  bindingDeclarationCount,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { boundPropIdentifier, isBindingName, propertyName } from "./prop-bindings.js";
import { climbTransparentExpression, constArrayBinding } from "./carried-values.js";
import { findAncestorUntil, nearestNestedFunction, visit } from "../../core/ast.js";
import { callbackInvocationIsDeferred } from "./invocation-trace.js";
import { callbackReferenceIsObservationOnly } from "./observation-only-reads.js";
import ts from "typescript";

/**
 * Proves that callbacks stored on items of one array prop are invoked only
 * behind deferred nested functions. The prop itself may be inspected and
 * mapped during render, but its callback field may not execute in render,
 * memoization, state initialization, or a React lifecycle callback.
 */
interface ArrayItemCallbackScan {
  readonly callbackProp: string;
  readonly deferral: CallbackDeferral;
  readonly itemNames: ReadonlySet<string>;
  readonly resolver: CallbackContractSourceResolver | undefined;
  readonly source: ChildComponentSource;
}

type ArrayItemVerdict = "counted" | "counted-unsafe" | "ignored" | "unsafe";

export interface ArrayItemCallbackQuery {
  readonly callbackProp: string;
  readonly propName: string;
  readonly resolver: CallbackContractSourceResolver | undefined;
  readonly source: ChildComponentSource;
}

export function arrayItemCallbackIsDeferred(
  { callbackProp, propName, resolver, source }: ArrayItemCallbackQuery,
  deferral: CallbackDeferral,
): boolean {
  const bound = boundPropIdentifier(source.owner, propName);
  if (!bound || !source.owner.body || bindingDeclarationCount(source.owner, bound.text) !== 1) {
    return false;
  }
  const arrayNames = trackedArrayNames(source, bound.text);
  if (!arrayBindingsStayWithinTrackedConsumers(source, arrayNames)) {
    return false;
  }
  const itemNames = arrayItemNames(source, arrayNames);
  if (itemNames.size === 0) {
    return false;
  }
  return arrayItemCallbackReferencesAreDeferred({
    callbackProp,
    deferral,
    itemNames,
    resolver,
    source,
  });
}

function arrayItemCallbackReferencesAreDeferred(scan: ArrayItemCallbackScan): boolean {
  const { itemNames, source } = scan;
  let references = 0;
  let safe = true;
  visit(source.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      !itemNames.has(node.text) ||
      isBindingName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const verdict = arrayItemReferenceVerdict(node, scan);
    if (verdict === "counted" || verdict === "counted-unsafe") {
      references += 1;
    }
    if (verdict === "counted-unsafe" || verdict === "unsafe") {
      safe = false;
    }
  });
  return safe && references > 0;
}

function arrayItemReferenceVerdict(
  node: ts.Identifier,
  scan: ArrayItemCallbackScan,
): ArrayItemVerdict {
  const { callbackProp } = scan;
  const member = node.parent;
  if (
    ts.isSpreadAssignment(member) &&
    member.expression === node &&
    spreadCallbackIsOverridden(member, callbackProp)
  ) {
    return "ignored";
  }
  if (!ts.isPropertyAccessExpression(member) || member.expression !== node) {
    return enclosingCallbackIsDeferred(node, scan) ? "ignored" : "unsafe";
  }
  if (member.name.text !== callbackProp) {
    return "ignored";
  }
  return arrayItemCallbackUseIsDeferred(member, scan) ? "counted" : "counted-unsafe";
}

function enclosingCallbackIsDeferred(node: ts.Node, scan: ArrayItemCallbackScan): boolean {
  const { deferral, resolver, source } = scan;
  const callback = nearestNestedFunction(node, source.owner);
  return (
    callback !== null &&
    callback !== source.owner &&
    (ts.isArrowFunction(callback) ||
      ts.isFunctionDeclaration(callback) ||
      ts.isFunctionExpression(callback)) &&
    callbackInvocationIsDeferred({
      callback,
      deferral,
      deferredCallbackHooks: source.deferredCallbackHooks,
      depth: 0,
      owner: source.owner,
      resolver,
      seenCallbacks: new Set(),
      source: resolver ? source : undefined,
      visited: new Set(),
    })
  );
}

function arrayItemCallbackUseIsDeferred(
  member: ts.PropertyAccessExpression,
  scan: ArrayItemCallbackScan,
): boolean {
  const { resolver, source } = scan;
  if (ts.isCallExpression(member.parent) && member.parent.expression === member) {
    return enclosingCallbackIsDeferred(member, scan);
  }
  if (callbackReferenceIsObservationOnly(member)) {
    return true;
  }
  const attribute = findAncestorUntil(member, ts.isJsxAttribute, source.owner);
  if (!resolver || !attribute || !jsxAttributeDirectlyCarries(attribute, member)) {
    return false;
  }
  return jsxAttributeForwardsArrayItemCallback(attribute, resolver, scan);
}

function jsxAttributeForwardsArrayItemCallback(
  attribute: ts.JsxAttribute,
  resolver: CallbackContractSourceResolver,
  scan: ArrayItemCallbackScan,
): boolean {
  const { deferral, source } = scan;
  const prop = attribute.name.getText();
  const target = jsxOwnerTarget(attribute);
  if (!/^on[A-Z]/u.test(prop) || !target) {
    return false;
  }
  if (
    jsxOwnerIsDeferredEventTarget(attribute, source) ||
    resolver.frameworkEventComponent(source.file, target)
  ) {
    return true;
  }
  const child = resolver.resolveComponent(source.file, target);
  return (
    child !== null &&
    deferral.sourceInput({
      argumentIndex: 0,
      path: [prop],
      source: atJsxInvocation(child, attribute, source),
      trace: { deferral, depth: 0, resolver, returnTarget: null, visited: new Set() },
    })
  );
}

interface ArrayPublicationScan {
  readonly binding: ts.Identifier;
  readonly callbackProperty: string;
  readonly deferral: CallbackDeferral;
  readonly resolver: CallbackContractSourceResolver;
  readonly source: ChildComponentSource;
}

function arrayItemCallbackPublication(
  callback: ts.Expression,
): { readonly array: ts.ArrayLiteralExpression; readonly callbackProperty: string } | null {
  const property = callback.parent;
  if (
    !ts.isPropertyAssignment(property) ||
    unwrapTransparentExpression(property.initializer) !== callback
  ) {
    return null;
  }
  const callbackProperty = propertyName(property.name);
  const object = property.parent;
  const carriedObject = ts.isObjectLiteralExpression(object)
    ? climbTransparentExpression(object)
    : null;
  const array = carriedObject?.parent;
  if (
    !callbackProperty ||
    !ts.isObjectLiteralExpression(object) ||
    !array ||
    !ts.isArrayLiteralExpression(array) ||
    !array.elements.includes(carriedObject) ||
    object.properties.some(ts.isSpreadAssignment) ||
    object.properties.filter(
      (member) =>
        (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member)) &&
        propertyName(member.name) === callbackProperty,
    ).length !== 1
  ) {
    return null;
  }
  return { array, callbackProperty };
}

function arrayPublicationIsDeferred(node: ts.Identifier, scan: ArrayPublicationScan): boolean {
  const { callbackProperty, deferral, resolver, source } = scan;
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, source.owner);
  if (!attribute || !jsxAttributeDirectlyCarries(attribute, node)) {
    return false;
  }
  const target = jsxOwnerTarget(attribute);
  const child = target ? resolver.resolveComponent(source.file, target) : null;
  return (
    child !== null &&
    arrayItemCallbackIsDeferred(
      {
        callbackProp: callbackProperty,
        propName: attribute.name.getText(),
        resolver,
        source: atJsxInvocation(child, attribute, source),
      },
      deferral,
    )
  );
}

function arrayBindingPublicationsAreDeferred(scan: ArrayPublicationScan): boolean {
  const { binding, source } = scan;
  let publications = 0;
  let safe = true;
  visit(source.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== binding.text ||
      node === binding ||
      isBindingName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (arrayPublicationIsDeferred(node, scan)) {
      publications += 1;
    } else {
      safe = false;
    }
  });
  return safe && publications > 0;
}

export function deferredArrayItemCallbackPublication(
  source: ChildComponentSource,
  callback: ts.Expression,
  trace: CallbackTrace,
): boolean | null {
  const publication = arrayItemCallbackPublication(callback);
  if (!publication) {
    return null;
  }
  const binding = constArrayBinding(publication.array, source.owner);
  if (!binding) {
    return false;
  }
  return arrayBindingPublicationsAreDeferred({
    binding,
    callbackProperty: publication.callbackProperty,
    deferral: trace.deferral,
    resolver: trace.resolver,
    source,
  });
}
