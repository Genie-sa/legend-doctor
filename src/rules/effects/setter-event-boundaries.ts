import { findAncestorUntil, nearestNestedFunction, visit } from "../../core/ast.js";
import {
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isInsideJsxAttribute,
  isValueTransitionProp,
} from "../../core/analysis-ast.js";
import type { ChildContractResolver } from "../child-contract/model.js";
import type { StateCandidate } from "../../analysis/model.js";
import ts from "typescript";

export function allSetterReferencesAreEventBoundaries(
  state: StateCandidate,
  childContracts: ChildContractResolver | null,
): boolean {
  if (!state.setterName) {
    return false;
  }
  let references = 0;
  let valid = true;
  visit(state.owner.body, (node) => {
    if (!valid || !ts.isIdentifier(node) || node.text !== state.setterName) {
      return;
    }
    if (node.parent === state.call.parent || isDeclarationName(node)) {
      return;
    }
    references += 1;
    if (!setterReferenceIsEventBoundary(node, state, childContracts)) {
      valid = false;
    }
  });
  return valid && references > 0;
}

interface EventBoundaryQuery {
  readonly attribute: ts.JsxAttribute;
  readonly childContracts: ChildContractResolver | null;
  readonly state: StateCandidate;
}

function setterReferenceIsEventBoundary(
  node: ts.Identifier,
  state: StateCandidate,
  childContracts: ChildContractResolver | null,
): boolean {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
  if (!attribute) {
    return false;
  }
  const query: EventBoundaryQuery = { attribute, childContracts, state };
  if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
    return handlerCallSiteIsBoundToAttribute(node, query);
  }
  if (isDirectJsxAttributeExpression(attribute, node)) {
    return jsxAttributeHasProvenEventContract(attribute, childContracts);
  }
  return isDeferredArrayItemCallbackProperty(node, query);
}

function handlerCallSiteIsBoundToAttribute(
  node: ts.Identifier,
  query: EventBoundaryQuery,
): boolean {
  const callback = nearestNestedFunction(node, query.state.owner);
  if (!callback || !jsxAttributeHasProvenEventContract(query.attribute, query.childContracts)) {
    return false;
  }
  return isInsideJsxAttribute(callback, query.attribute);
}

function isDeferredArrayItemCallbackProperty(
  node: ts.Identifier,
  query: EventBoundaryQuery,
): boolean {
  const property = findAncestorUntil(node, ts.isPropertyAssignment, query.attribute);
  const opening = jsxOpeningForAttribute(query.attribute);
  const target = opening?.tagName.getText() ?? null;
  const callbackProperty = property ? staticPropertyName(property.name) : null;
  return (
    property !== null &&
    property.initializer === node &&
    callbackProperty !== null &&
    isValueTransitionProp(callbackProperty) &&
    target !== null &&
    query.childContracts?.componentArrayItemCallbackIsDeferred(
      target,
      query.attribute.name.getText(),
      callbackProperty,
    ) === true
  );
}

function jsxAttributeHasProvenEventContract(
  attribute: ts.JsxAttribute,
  childContracts: ChildContractResolver | null,
): boolean {
  const opening = jsxOpeningForAttribute(attribute);
  if (!opening) {
    return false;
  }
  const propName = attribute.name.getText();
  if (!isValueTransitionProp(propName) && !/^on[A-Z]/u.test(propName)) {
    return false;
  }
  const target = opening.tagName.getText();
  return (
    /^[a-z]/u.test(target) ||
    childContracts?.frameworkEventComponent(target) === true ||
    childContracts?.componentCallbackPropIsDeferred(target, propName) === true
  );
}

function jsxOpeningForAttribute(
  attribute: ts.JsxAttribute,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const opening = attribute.parent.parent;
  return ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening) ? opening : null;
}

function staticPropertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}
