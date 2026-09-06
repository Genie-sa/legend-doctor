import {
  bindingDeclarationCount,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
  isPureExpression,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { findAncestorUntil, nearestNestedFunction, visit } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import { mutationRegionOnlyCallsStateSetters } from "../effect-drafts/draft-mutations.js";
import ts from "typescript";

const BOOLEAN_BINARY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

export function isEventBooleanSetter(call: ts.CallExpression, state: StateCandidate): boolean {
  if (!isPureBooleanSetter(call)) {
    return false;
  }
  const callback = nearestNestedFunction(call, state.owner);
  return (
    callback !== null &&
    (ts.isArrowFunction(callback) ||
      ts.isFunctionDeclaration(callback) ||
      ts.isFunctionExpression(callback)) &&
    callbackIsIntrinsicEventRooted(callback, state.owner) &&
    mutationRegionOnlyCallsStateSetters(callback, new Set([state.setterName!]))
  );
}

export function isPureBooleanSetter(call: ts.CallExpression): boolean {
  const [argument] = call.arguments;
  return (
    call.arguments.length === 1 &&
    argument !== undefined &&
    (isLiteralBooleanSetter(call) || (isPureExpression(argument) && isBooleanExpression(argument)))
  );
}

export function isLiteralBooleanSetter(call: ts.CallExpression): boolean {
  const [value] = call.arguments;
  return (
    call.arguments.length === 1 &&
    value !== undefined &&
    (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword)
  );
}

function callbackIsIntrinsicEventRooted(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
): boolean {
  if (isInlineIntrinsicEventHandler(callback, owner)) {
    return true;
  }
  const name = callbackBindingName(callback);
  if (!name || bindingDeclarationCount(owner, name) !== 1) {
    return false;
  }
  return referencesAreIntrinsicEventAttributes(owner, name);
}

function isInlineIntrinsicEventHandler(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
): boolean {
  const attribute = findAncestorUntil(callback, ts.isJsxAttribute, owner);
  const initializer = attribute?.initializer;
  return (
    attribute !== null &&
    initializer !== undefined &&
    ts.isJsxExpression(initializer) &&
    initializer.expression !== undefined &&
    unwrapTransparentExpression(initializer.expression) === callback &&
    attributeIsIntrinsicEvent(attribute)
  );
}

function callbackBindingName(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
): string | undefined {
  if (ts.isFunctionDeclaration(callback)) {
    return callback.name?.text;
  }
  return ts.isVariableDeclaration(callback.parent) && ts.isIdentifier(callback.parent.name)
    ? callback.parent.name.text
    : undefined;
}

function referencesAreIntrinsicEventAttributes(owner: RuntimeFunctionLike, name: string): boolean {
  let referenced = false;
  let safe = true;
  visit(owner.body, (node) => {
    if (!safe || !isValueReferenceNamed(node, name)) {
      return;
    }
    referenced = true;
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    safe =
      attribute !== null &&
      isDirectJsxAttributeExpression(attribute, node) &&
      attributeIsIntrinsicEvent(attribute);
  });
  return referenced && safe;
}

function isValueReferenceNamed(node: ts.Node, name: string): node is ts.Identifier {
  return (
    ts.isIdentifier(node) &&
    node.text === name &&
    !isDeclarationName(node) &&
    !isNonValueIdentifier(node)
  );
}

function attributeIsIntrinsicEvent(attribute: ts.JsxAttribute): boolean {
  if (!/^on[A-Z]/u.test(attribute.name.getText())) {
    return false;
  }
  const opening = attribute.parent.parent;
  const tag =
    ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening) ? opening.tagName : null;
  return tag !== null && ts.isIdentifier(tag) && /^[a-z]/u.test(tag.text);
}

function isBooleanExpression(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  return (
    (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) ||
    (ts.isBinaryExpression(value) && BOOLEAN_BINARY_OPERATORS.has(value.operatorToken.kind))
  );
}
