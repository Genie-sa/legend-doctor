import {
  bindingDeclarationCount,
  isPureExpression,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { findAncestorUntil, isRuntimeFunctionLike } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { staticPropertyChainStartsAt } from "./collection-work.js";
import ts from "typescript";

export interface ExactStringFilter {
  readonly call: ts.CallExpression;
  readonly resultName: ts.Identifier;
  readonly sourceName: ts.Identifier;
}

function caseInsensitiveIncludesPredicate(
  stateRead: ts.Identifier,
  owner: RuntimeFunctionLike,
): ts.ArrowFunction | null {
  const includesCall = stateRead.parent;
  if (
    !ts.isCallExpression(includesCall) ||
    includesCall.arguments.length !== 1 ||
    includesCall.arguments[0] !== stateRead ||
    !ts.isPropertyAccessExpression(includesCall.expression) ||
    includesCall.expression.name.text !== "includes"
  ) {
    return null;
  }
  const lowerCall = toLowerCaseCall(includesCall.expression.expression);
  const callback = lowerCall ? findAncestorUntil(includesCall, isRuntimeFunctionLike, owner) : null;
  const parameter = callback?.parameters[0]?.name;
  if (
    !lowerCall ||
    !callback ||
    !ts.isArrowFunction(callback) ||
    ts.isBlock(callback.body) ||
    !parameter ||
    !ts.isIdentifier(parameter) ||
    !staticPropertyChainStartsAt(lowerCall.expression.expression, parameter) ||
    !isPureExpression(callback.body, (call) => call === includesCall || call === lowerCall)
  ) {
    return null;
  }
  return callback;
}

interface ToLowerCaseCall extends ts.CallExpression {
  readonly expression: ts.PropertyAccessExpression;
}

function toLowerCaseCall(expression: ts.Expression): ToLowerCaseCall | null {
  const call = unwrapTransparentExpression(expression);
  if (
    !ts.isCallExpression(call) ||
    call.arguments.length > 0 ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "toLowerCase"
  ) {
    return null;
  }
  // SAFETY: the guard above proves `call` is a zero-argument `.toLowerCase()` property-access call.
  return call as ToLowerCaseCall;
}

function uniqueFilterSourceName(
  filterCall: ts.Node,
  callback: ts.ArrowFunction,
  owner: RuntimeFunctionLike,
): ts.Identifier | null {
  const source =
    ts.isCallExpression(filterCall) && ts.isPropertyAccessExpression(filterCall.expression)
      ? unwrapTransparentExpression(filterCall.expression.expression)
      : null;
  if (
    !ts.isCallExpression(filterCall) ||
    filterCall.arguments.length !== 1 ||
    filterCall.arguments[0] !== callback ||
    !ts.isPropertyAccessExpression(filterCall.expression) ||
    filterCall.expression.name.text !== "filter" ||
    !source ||
    !ts.isIdentifier(source) ||
    bindingDeclarationCount(owner, source.text) !== 1
  ) {
    return null;
  }
  return source;
}

function uniqueConstResultName(
  filterCall: ts.CallExpression,
  owner: RuntimeFunctionLike,
): ts.Identifier | null {
  const result = filterCall.parent;
  if (
    !ts.isVariableDeclaration(result) ||
    result.initializer !== filterCall ||
    !ts.isIdentifier(result.name) ||
    !ts.isVariableDeclarationList(result.parent) ||
    (result.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, result.name.text) !== 1
  ) {
    return null;
  }
  return result.name;
}

export function exactStringFilter(
  stateRead: ts.Identifier,
  owner: RuntimeFunctionLike,
): ExactStringFilter | null {
  const callback = caseInsensitiveIncludesPredicate(stateRead, owner);
  if (!callback) {
    return null;
  }
  const filterCall = callback.parent;
  const sourceName = uniqueFilterSourceName(filterCall, callback, owner);
  if (!sourceName || !ts.isCallExpression(filterCall)) {
    return null;
  }
  const resultName = uniqueConstResultName(filterCall, owner);
  return resultName ? { call: filterCall, resultName, sourceName } : null;
}
