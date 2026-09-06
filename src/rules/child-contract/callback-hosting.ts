import { bindingDeclarationCount, hookCallName } from "../../core/analysis-ast.js";
import { findAncestor, nodeWithin } from "../../core/ast.js";
import type { ChildComponentSource } from "./model.js";
import { climbTransparentExpression } from "./carried-values.js";
import ts from "typescript";

export function callbackBindingName(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: ChildComponentSource["owner"],
): string | null {
  if (ts.isFunctionDeclaration(callback)) {
    return callback.name?.text ?? null;
  }
  if (ts.isVariableDeclaration(callback.parent) && ts.isIdentifier(callback.parent.name)) {
    return callback.parent.name.text;
  }
  const call = memoizedCallbackIdentityCall(callback, owner);
  if (!call) {
    return null;
  }
  const expression = climbTransparentExpression(call);
  const declaration = expression.parent;
  return ts.isVariableDeclaration(declaration) &&
    declaration.initializer === expression &&
    ts.isIdentifier(declaration.name) &&
    bindingDeclarationCount(owner, declaration.name.text) === 1
    ? declaration.name.text
    : null;
}

function memoizedCallbackIdentityCall(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: ChildComponentSource["owner"],
): ts.CallExpression | null {
  const direct = callback.parent;
  if (
    ts.isCallExpression(direct) &&
    direct.arguments[0] === callback &&
    hookCallName(direct) === "useCallback" &&
    bindingDeclarationCount(owner, "useCallback") === 0
  ) {
    return direct;
  }
  const returned = climbTransparentExpression(callback);
  const factory = returned.parent;
  if (!ts.isArrowFunction(factory) || factory.body !== returned) {
    return null;
  }
  const memo = factory.parent;
  return ts.isCallExpression(memo) &&
    memo.arguments[0] === factory &&
    hookCallName(memo) === "useMemo" &&
    bindingDeclarationCount(owner, "useMemo") === 0
    ? memo
    : null;
}

export function identifierRunsInProvenDeferredHook(
  identifier: ts.Identifier,
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>,
): boolean {
  const call = findAncestor(identifier, ts.isCallExpression);
  if (!call || nodeWithin(identifier, call.expression)) {
    return false;
  }
  const argumentIndex = call.arguments.findIndex((argument) => nodeWithin(identifier, argument));
  const hookName = hookCallName(call);
  return (
    argumentIndex !== -1 &&
    hookName !== null &&
    deferredCallbackHooks.get(hookName)?.has(argumentIndex) === true
  );
}

export function callbackRunsInProvenDeferredHook(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>,
): boolean {
  if (ts.isFunctionDeclaration(callback)) {
    return false;
  }
  const call = callback.parent;
  if (!ts.isCallExpression(call)) {
    return false;
  }
  const argumentIndex = call.arguments.indexOf(callback);
  const hookName = hookCallName(call);
  return (
    argumentIndex !== -1 &&
    hookName !== null &&
    deferredCallbackHooks.get(hookName)?.has(argumentIndex) === true
  );
}

export function callbackIsStoredInProperty(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  let expression: ts.Expression = callback;
  while (
    (ts.isParenthesizedExpression(expression.parent) ||
      ts.isAsExpression(expression.parent) ||
      ts.isTypeAssertionExpression(expression.parent) ||
      ts.isSatisfiesExpression(expression.parent) ||
      ts.isNonNullExpression(expression.parent)) &&
    expression.parent.expression === expression
  ) {
    expression = expression.parent;
  }
  if (
    ts.isConditionalExpression(expression.parent) &&
    (expression.parent.whenTrue === expression || expression.parent.whenFalse === expression)
  ) {
    expression = expression.parent;
  }
  return ts.isPropertyAssignment(expression.parent) && expression.parent.initializer === expression;
}

export function callbackRunsInImmediateReactHook(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
): boolean {
  if (ts.isFunctionDeclaration(callback)) {
    return false;
  }
  const call = callback.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(callback)) {
    return false;
  }
  return [
    "useEffect",
    "useInsertionEffect",
    "useLayoutEffect",
    "useMemo",
    "useReducer",
    "useState",
  ].includes(hookCallName(call) ?? "");
}
