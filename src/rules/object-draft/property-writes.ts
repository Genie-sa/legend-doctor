import { findAncestorUntil, visit } from "../../core/ast.js";
import {
  isDeclarationName,
  isNonValueIdentifier,
  isPureExpression,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { ChildContractResolver } from "../child-contract/model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import ts from "typescript";

export interface PropertyWrite {
  property: string;
}

interface SpreadUpdater {
  readonly object: ts.ObjectLiteralExpression;
  readonly previous: string;
}

const SPREAD_UPDATE_PROPERTY_COUNT = 2;

export function exactPropertyWrite(
  call: ts.CallExpression,
  state: StateCandidate,
  childContracts: ChildContractResolver | null,
): PropertyWrite | null {
  const property = singleSpreadWriteProperty(call);
  if (property === null) {
    return null;
  }
  const opening = deferredSetterOnlyOpening(call, state.owner, childContracts);
  return opening && openingReadsProperty(opening, state.valueName, property) ? { property } : null;
}

function spreadUpdater(call: ts.CallExpression): SpreadUpdater | null {
  if (call.arguments.length !== 1) {
    return null;
  }
  const updater = unwrapTransparentExpression(call.arguments[0]!);
  if (
    (!ts.isArrowFunction(updater) && !ts.isFunctionExpression(updater)) ||
    updater.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    updater.parameters.length !== 1 ||
    !ts.isIdentifier(updater.parameters[0]!.name) ||
    ts.isBlock(updater.body)
  ) {
    return null;
  }
  const object = unwrapTransparentExpression(updater.body);
  return ts.isObjectLiteralExpression(object) &&
    object.properties.length === SPREAD_UPDATE_PROPERTY_COUNT
    ? { object, previous: updater.parameters[0]!.name.text }
    : null;
}

function singleSpreadWriteProperty(call: ts.CallExpression): string | null {
  const updater = spreadUpdater(call);
  if (!updater) {
    return null;
  }
  const [spread, assignment] = updater.object.properties;
  const spreadValue =
    spread && ts.isSpreadAssignment(spread) ? unwrapTransparentExpression(spread.expression) : null;
  if (
    !spreadValue ||
    !ts.isIdentifier(spreadValue) ||
    spreadValue.text !== updater.previous ||
    !assignment ||
    !ts.isPropertyAssignment(assignment) ||
    (!ts.isIdentifier(assignment.name) && !ts.isStringLiteralLike(assignment.name)) ||
    !isPureExpression(assignment.initializer) ||
    bindingIsReferenced(assignment.initializer, updater.previous)
  ) {
    return null;
  }
  return assignment.name.text;
}

function deferredSetterOnlyOpening(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
  childContracts: ChildContractResolver | null,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const attribute = inlineEventHandlerAttribute(call, owner);
  if (!attribute) {
    return null;
  }
  const opening = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) {
    return null;
  }
  const component = opening.tagName.getText();
  if (/^[a-z]/u.test(component)) {
    return opening;
  }
  return childContracts &&
    (childContracts.frameworkEventComponent(component) ||
      childContracts.componentCallbackPropIsDeferred(component, attribute.name.getText()))
    ? opening
    : null;
}

function inlineEventHandlerAttribute(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): ts.JsxAttribute | null {
  const attribute = findAncestorUntil(call, ts.isJsxAttribute, owner);
  const expression =
    attribute?.initializer && ts.isJsxExpression(attribute.initializer)
      ? attribute.initializer.expression
      : null;
  if (
    !attribute ||
    !/^on[A-Z]/u.test(attribute.name.getText()) ||
    !expression ||
    (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) ||
    ts.isBlock(expression.body) ||
    unwrapTransparentExpression(expression.body) !== call
  ) {
    return null;
  }
  return attribute;
}

function openingReadsProperty(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  stateName: string,
  property: string,
): boolean {
  return opening.attributes.properties.some((candidate) => {
    const expression =
      ts.isJsxAttribute(candidate) &&
      candidate.name.getText() === "value" &&
      candidate.initializer &&
      ts.isJsxExpression(candidate.initializer)
        ? candidate.initializer.expression
        : null;
    const access = expression && unwrapTransparentExpression(expression);
    return (
      access !== null &&
      access !== undefined &&
      ts.isPropertyAccessExpression(access) &&
      ts.isIdentifier(unwrapTransparentExpression(access.expression)) &&
      access.expression.getText() === stateName &&
      access.name.text === property
    );
  });
}

function bindingIsReferenced(node: ts.Node, name: string): boolean {
  let referenced = false;
  visit(node, (candidate) => {
    if (
      ts.isIdentifier(candidate) &&
      candidate.text === name &&
      !isDeclarationName(candidate) &&
      !isNonValueIdentifier(candidate)
    ) {
      referenced = true;
    }
  });
  return referenced;
}
