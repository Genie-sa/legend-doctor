import {
  bindingDeclarationCount,
  isDirectJsxAttributeExpression,
  isPureExpression,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { findAncestorUntil, nearestNestedFunction } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import { everyValueReferenceSatisfies } from "../../analysis/callbacks/deferred-events.js";
import { jsxAttributeIsIntrinsicEvent } from "../async-leaf-status/event-rooted-commands.js";
import { localFunctionName } from "../../analysis/ast-helpers.js";
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
  const name = localFunctionName(callback);
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
  return (
    attribute !== null &&
    isDirectJsxAttributeExpression(attribute, callback) &&
    jsxAttributeIsIntrinsicEvent(attribute)
  );
}

function referencesAreIntrinsicEventAttributes(owner: RuntimeFunctionLike, name: string): boolean {
  return everyValueReferenceSatisfies(owner, name, (node) => {
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    return (
      attribute !== null &&
      isDirectJsxAttributeExpression(attribute, node) &&
      jsxAttributeIsIntrinsicEvent(attribute)
    );
  });
}

export function isBooleanExpression(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  return (
    (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) ||
    (ts.isBinaryExpression(value) && BOOLEAN_BINARY_OPERATORS.has(value.operatorToken.kind))
  );
}
