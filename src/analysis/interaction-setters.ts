import type { StateCandidate, StateUsage } from "./model.js";
import { containsCallExpression, isControlledInteractionProp } from "../core/analysis-ast.js";
import { findAncestorUntil, nearestNestedFunction } from "../core/ast.js";
import { jsxProducerForSetterCall, localCallbackBindingName } from "./callbacks/local-callbacks.js";
import { isExactControlledArrayMembershipToggle } from "./membership-toggle.js";
import { nearestMutationFunction } from "./mutations.js";
import ts from "typescript";

export function hasDirectInteractionSetter(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  setterName: string,
  isInteractionProp: (name: string) => boolean = isControlledInteractionProp,
): boolean {
  return opening.attributes.properties.some(
    (attribute) =>
      ts.isJsxAttribute(attribute) &&
      isInteractionProp(attribute.name.getText()) &&
      attribute.initializer !== undefined &&
      ts.isJsxExpression(attribute.initializer) &&
      attribute.initializer.expression !== undefined &&
      ts.isIdentifier(attribute.initializer.expression) &&
      attribute.initializer.expression.text === setterName,
  );
}

interface InteractionSetterOptions {
  readonly isInteractionProp?: (name: string) => boolean;
  readonly usage: StateUsage;
}

export function hasInlineInteractionSetter(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  state: StateCandidate,
  options: InteractionSetterOptions,
): boolean {
  const { isInteractionProp = isControlledInteractionProp, usage } = options;
  if (!state.setterName || usage.setterCalls === 0 || usage.setterTransportSites.size > 0) {
    return false;
  }
  return usage.setterCallNodes.some((call) =>
    callIsSoleInlineHandlerBody(call, { isInteractionProp, opening, state }),
  );
}

interface InlineHandlerScope {
  readonly isInteractionProp: (name: string) => boolean;
  readonly opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  readonly state: StateCandidate;
}

function inlineHandlerCallback(
  call: ts.CallExpression,
  { isInteractionProp, opening, state }: InlineHandlerScope,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const attribute = findAncestorUntil(call, ts.isJsxAttribute, state.owner);
  if (
    !attribute ||
    !isInteractionProp(attribute.name.getText()) ||
    attribute.parent?.parent !== opening ||
    !attribute.initializer ||
    !ts.isJsxExpression(attribute.initializer)
  ) {
    return null;
  }
  const callback = attribute.initializer.expression;
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return null;
  }
  return callback;
}

function callIsSoleInlineHandlerBody(call: ts.CallExpression, scope: InlineHandlerScope): boolean {
  if (call.arguments.some((argument) => containsCallExpression(argument))) {
    return false;
  }
  const callback = inlineHandlerCallback(call, scope);
  if (!callback || nearestNestedFunction(call, scope.state.owner) !== callback) {
    return false;
  }
  return callbackBodyIsSoleCall(callback.body, call);
}

function callbackBodyIsSoleCall(body: ts.ConciseBody, call: ts.CallExpression): boolean {
  if (ts.isCallExpression(body)) {
    return body === call;
  }
  if (!ts.isBlock(body) || body.statements.length !== 1) {
    return false;
  }
  const [statement] = body.statements;
  return (
    statement !== undefined && ts.isExpressionStatement(statement) && statement.expression === call
  );
}

function stateHasSoleAdapterWrite(state: StateCandidate, usage: StateUsage): boolean {
  const [call] = usage.setterCallNodes;
  return (
    state.setterName !== null &&
    usage.setterReferences === 1 &&
    usage.setterCalls === 1 &&
    usage.setterCallNodes.length === 1 &&
    usage.setterTransportSites.size === 0 &&
    call !== undefined &&
    (!call.arguments.some((argument) => containsCallExpression(argument)) ||
      isExactControlledArrayMembershipToggle(state, usage))
  );
}

export function hasInteractionSetterAdapter(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  state: StateCandidate,
  options: InteractionSetterOptions,
): boolean {
  const { isInteractionProp = isControlledInteractionProp, usage } = options;
  const [call] = usage.setterCallNodes;
  if (!call || !stateHasSoleAdapterWrite(state, usage)) {
    return false;
  }
  const callback = producerBoundAdapter(call, state, opening);
  const name = callback ? localCallbackBindingName(callback) : null;
  if (!callback || !name || !openingBindsInteractionCallback(opening, name, isInteractionProp)) {
    return false;
  }
  return callback.body !== undefined && callbackBodyIsSoleCall(callback.body, call);
}

function producerBoundAdapter(
  call: ts.CallExpression,
  state: StateCandidate,
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
): ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null {
  const callback = nearestMutationFunction(call, state.owner);
  if (
    callback === state.owner ||
    (!ts.isArrowFunction(callback) &&
      !ts.isFunctionDeclaration(callback) &&
      !ts.isFunctionExpression(callback)) ||
    jsxProducerForSetterCall(call, state.owner) !== opening
  ) {
    return null;
  }
  return callback;
}

function openingBindsInteractionCallback(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
  isInteractionProp: (name: string) => boolean,
): boolean {
  return opening.attributes.properties.some(
    (attribute) =>
      ts.isJsxAttribute(attribute) &&
      isInteractionProp(attribute.name.getText()) &&
      attribute.initializer !== undefined &&
      ts.isJsxExpression(attribute.initializer) &&
      attribute.initializer.expression !== undefined &&
      ts.isIdentifier(attribute.initializer.expression) &&
      attribute.initializer.expression.text === name,
  );
}
