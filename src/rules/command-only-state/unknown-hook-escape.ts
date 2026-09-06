import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { findAncestorUntil, nodeWithin, visit } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import ts from "typescript";

export function stateReadCallbackEscapesThroughUnknownHook(
  state: StateCandidate,
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
  callbackPropertyIsDeferred?: (
    hookName: string,
    argumentIndex: number,
    property: string,
  ) => boolean,
): boolean {
  const scan: UnknownHookScan = {
    callbackPropertyIsDeferred,
    deferredCallbackHooks,
    owner: state.owner,
  };
  let escaped = false;
  visit(state.owner.body, (node) => {
    if (
      escaped ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      node.parent === state.call.parent
    ) {
      return;
    }
    if (readEscapesThroughUnknownHook(node, scan)) {
      escaped = true;
    }
  });
  return escaped;
}

interface UnknownHookScan {
  readonly callbackPropertyIsDeferred:
    | ((hookName: string, argumentIndex: number, property: string) => boolean)
    | undefined;
  readonly deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>;
  readonly owner: RuntimeFunctionLike;
}

const HOOK_NAME_PATTERN = /^use[A-Z0-9]/u;

const DEFERRED_BY_DEFINITION_HOOKS = new Set([
  "useCallback",
  "useMemo",
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
]);

function calleeHookName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
}

function readEscapesThroughUnknownHook(node: ts.Identifier, scan: UnknownHookScan): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== scan.owner;
    current = current.parent
  ) {
    if (
      ts.isCallExpression(current) &&
      current.arguments.some((argument) => nodeWithin(node, argument)) &&
      unknownHookCallEscapes(current, node, scan)
    ) {
      return true;
    }
  }
  return false;
}

function unknownHookCallEscapes(
  call: ts.CallExpression,
  node: ts.Identifier,
  scan: UnknownHookScan,
): boolean {
  const hookName = calleeHookName(call.expression);
  if (
    !hookName ||
    !HOOK_NAME_PATTERN.test(hookName) ||
    DEFERRED_BY_DEFINITION_HOOKS.has(hookName) ||
    bindingDeclarationCount(scan.owner, hookName) !== 0
  ) {
    return false;
  }
  const argumentIndex = call.arguments.findIndex((argument) => nodeWithin(node, argument));
  if (argumentIndex !== -1 && scan.deferredCallbackHooks.get(hookName)?.has(argumentIndex)) {
    return false;
  }
  const property =
    argumentIndex === -1 ? null : objectCallbackProperty(call.arguments[argumentIndex]!, node);
  return !(
    property !== null &&
    scan.callbackPropertyIsDeferred?.(hookName, argumentIndex, property) === true
  );
}

function objectCallbackProperty(argument: ts.Expression, node: ts.Node): string | null {
  const object = unwrapTransparentExpression(argument);
  if (!ts.isObjectLiteralExpression(object)) {
    return null;
  }
  const property = findAncestorUntil(node, isObjectCallbackMember, object);
  if (
    !property ||
    property.parent !== object ||
    (ts.isPropertyAssignment(property) && !nodeWithin(node, property.initializer)) ||
    (ts.isMethodDeclaration(property) && !property.body)
  ) {
    return null;
  }
  return ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
    ? property.name.text
    : null;
}

function isObjectCallbackMember(
  node: ts.Node,
): node is ts.MethodDeclaration | ts.PropertyAssignment {
  return ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node);
}
