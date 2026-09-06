import { USE_CALLBACK_HOOK, callbackIsEventRooted, isPlainFunction } from "./event-roots.js";
import {
  findAncestor,
  findAncestorUntil,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  visit,
} from "../../core/ast.js";
import {
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { isHookDependencyReference, isJsxNode } from "./callback-sites.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import ts from "typescript";

const EMPTY_NODES: ReadonlySet<ts.Node> = new Set();

const EMPTY_RUNTIME_FUNCTIONS: ReadonlySet<RuntimeFunctionLike> = new Set();

export { stateMayHoldCallable, stateTypeMayBeCallable } from "../callable-state.js";

export function hasDirectPrimitiveInitializer(state: StateCandidate): boolean {
  const [initializer] = state.call.arguments;
  return initializer !== undefined && isDirectPrimitiveExpression(initializer);
}

export function setterCallUsesPreviousValue(call: ts.CallExpression): boolean {
  const [argument] = call.arguments;
  if (!argument || (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument))) {
    return false;
  }
  const [parameter] = argument.parameters;
  if (!parameter || !ts.isIdentifier(parameter.name)) {
    return false;
  }
  const parameterName = parameter.name.text;
  let referenced = false;
  visit(argument.body, (node) => {
    if (ts.isIdentifier(node) && node.text === parameterName && node !== parameter.name) {
      referenced = true;
    }
  });
  return referenced;
}

export function isDirectPrimitiveExpression(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  if (
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value)
  ) {
    return true;
  }
  return (
    ts.isPrefixUnaryExpression(value) &&
    (value.operator === ts.SyntaxKind.PlusToken || value.operator === ts.SyntaxKind.MinusToken) &&
    (ts.isNumericLiteral(value.operand) || ts.isBigIntLiteral(value.operand))
  );
}

export function hasOnlyEventCommandReads(
  state: StateCandidate,
  ignored: ReadonlySet<ts.Node> = EMPTY_NODES,
  additionalRoots: ReadonlySet<RuntimeFunctionLike> = EMPTY_RUNTIME_FUNCTIONS,
): boolean {
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      node.parent === state.call.parent ||
      ignored.has(node) ||
      findAncestorUntil(node, isJsxNode, state.owner)
    ) {
      return;
    }
    safe = stateReadIsEventCommand(node, state, additionalRoots);
  });
  return safe;
}

/** A read outside JSX is safe only from an event-rooted callback, or as a useCallback dependency. */
function stateReadIsEventCommand(
  reference: ts.Identifier,
  state: StateCandidate,
  additionalRoots: ReadonlySet<RuntimeFunctionLike>,
): boolean {
  const callback = nearestNestedFunction(reference, state.owner);
  if (callback) {
    return callbackOrAncestorIsEventRooted(callback, state, additionalRoots);
  }
  if (!isHookDependencyReference(reference, USE_CALLBACK_HOOK)) {
    return false;
  }
  const call = findAncestorUntil(reference, ts.isCallExpression, state.owner);
  const candidate = call?.arguments[0];
  return (
    candidate !== undefined &&
    (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) &&
    callbackIsEventRooted({
      callback: candidate,
      owner: state.owner,
      dependencyName: state.valueName,
      seen: new Set(),
      additionalRoot: (root) => additionalRoots.has(root),
    })
  );
}

function callbackOrAncestorIsEventRooted(
  callback: RuntimeFunctionLike,
  state: StateCandidate,
  additionalRoots: ReadonlySet<RuntimeFunctionLike>,
): boolean {
  for (
    let candidate: ts.Node | undefined = callback;
    candidate && candidate !== state.owner;
    candidate =
      additionalRoots.size > 0
        ? (findAncestor(candidate, isRuntimeFunctionLike) ?? undefined)
        : undefined
  ) {
    if (
      isPlainFunction(candidate) &&
      callbackIsEventRooted({
        callback: candidate,
        owner: state.owner,
        dependencyName: state.valueName,
        seen: new Set(),
        additionalRoot: (root) => additionalRoots.has(root),
      })
    ) {
      return true;
    }
  }
  return false;
}
