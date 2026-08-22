import ts from "typescript";

import {
  bindingDeclarationCount,
  hookCallName,
  isAssignmentOperator,
  isNonValueIdentifier,
} from "../analysis-ast.js";
import {
  findAncestor,
  findAncestorUntil,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  nodeWithin,
  visit,
} from "../ast.js";
import { isSynchronousRenderCallback } from "./state-proofs.js";

export interface ChildComponentSource {
  readonly body: ts.ConciseBody;
  readonly deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>;
  readonly owner:
    | ts.ArrowFunction
    | ts.FunctionDeclaration
    | ts.FunctionExpression;
}

export interface ChildContractResolver {
  callbackPropertyIsDeferred(
    hookName: string,
    argumentIndex: number,
    property: string
  ): boolean;
  resolveComponent(name: string): ChildComponentSource | null;
}

const MAX_TRACKED_NAMES = 8;

/**
 * Proves that a child component consumes one prop as a pure render value:
 * every read lands in JSX output of host elements or in bounded pure
 * projections of such reads, and no read escapes into hooks, callbacks,
 * writes, forwarding, or other calls. Only then can the owner keep the
 * observable and the call site subscribe without changing behavior.
 */
export function propIsLeafRenderConsumer(
  source: ChildComponentSource,
  propName: string
): boolean {
  const bound = boundPropIdentifier(source.owner, propName);
  if (!bound || !source.owner.body) return false;
  if (bindingDeclarationCount(source.owner, bound.text) !== 1) return false;

  let safe = true;
  let renderReads = 0;
  const tracked = new Set([bound.text]);
  visit(source.owner.body, node => {
    if (!safe || !ts.isIdentifier(node) || !tracked.has(node.text)) return;
    if (isNonValueIdentifier(node)) return;
    if (isBindingName(node)) return;
    if (findAncestor(node, isRuntimeFunctionLike) !== source.owner) {
      safe = false;
      return;
    }
    if (referenceIsWritten(node)) {
      safe = false;
      return;
    }
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, source.owner);
    if (attribute) {
      if (isCustomJsxTag(attribute)) {
        safe = false;
        return;
      }
      renderReads += 1;
      return;
    }
    if (findAncestorUntil(node, isJsxNode, source.owner)) {
      renderReads += 1;
      return;
    }
    if (tracksPureProjection(node, source.owner, tracked)) return;
    safe = false;
  });
  return safe && renderReads > 0;
}

/**
 * Proves that callbacks stored on items of one array prop are invoked only
 * behind deferred nested functions. The prop itself may be inspected and
 * mapped during render, but its callback field may not execute in render,
 * memoization, state initialization, or a React lifecycle callback.
 */
export function propDefersArrayItemCallback(
  source: ChildComponentSource,
  propName: string,
  callbackProp: string
): boolean {
  const bound = boundPropIdentifier(source.owner, propName);
  if (!bound || !source.owner.body) return false;
  if (bindingDeclarationCount(source.owner, bound.text) !== 1) return false;

  const itemNames = new Set<string>();
  visit(source.owner.body, node => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isArrayItemLookup(node.initializer, bound.text)
    ) {
      itemNames.add(node.name.text);
    }
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      node.parameters[0] &&
      ts.isIdentifier(node.parameters[0].name) &&
      isArrayIterationCallback(node, bound.text)
    ) {
      itemNames.add(node.parameters[0].name.text);
    }
  });
  if (itemNames.size === 0) return false;

  let calls = 0;
  let safe = true;
  visit(source.owner.body, node => {
    if (
      !safe ||
      !ts.isPropertyAccessExpression(node) ||
      node.name.text !== callbackProp ||
      !ts.isIdentifier(node.expression) ||
      !itemNames.has(node.expression.text)
    ) {
      return;
    }
    if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) return;
    calls += 1;
    const callback = nearestNestedFunction(node, source.owner);
    if (
      !callback ||
      (!ts.isArrowFunction(callback) &&
        !ts.isFunctionDeclaration(callback) &&
        !ts.isFunctionExpression(callback)) ||
      callback === source.owner ||
      !callbackInvocationIsDeferred(
        callback,
        source.owner,
        source.deferredCallbackHooks
      )
    ) {
      safe = false;
    }
  });
  return safe && calls > 0;
}

function isArrayItemLookup(expression: ts.Expression, arrayName: string): boolean {
  return ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === arrayName &&
    expression.expression.name.text === "at";
}

function isArrayIterationCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  arrayName: string
): boolean {
  const call = callback.parent;
  return ts.isCallExpression(call) &&
    call.arguments[0] === callback &&
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === arrayName &&
    ["every", "filter", "find", "findIndex", "flatMap", "map", "some"].includes(call.expression.name.text);
}

function callbackInvocationIsDeferred(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: ChildComponentSource["owner"],
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>
): boolean {
  if (isSynchronousRenderCallback(callback) || callbackRunsInImmediateReactHook(callback)) {
    return false;
  }
  const name = ts.isFunctionDeclaration(callback)
    ? callback.name?.text
    : ts.isVariableDeclaration(callback.parent) && ts.isIdentifier(callback.parent.name)
      ? callback.parent.name.text
      : null;
  if (!name) {
    return !ts.isFunctionDeclaration(callback) && callbackIsStoredInProperty(callback);
  }

  let referenced = false;
  let safe = true;
  visit(owner.body, node => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isBindingName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    referenced = true;
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    if (attribute && /^on[A-Z]/.test(attribute.name.getText())) return;
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      const caller = nearestNestedFunction(node, owner);
      if (
        caller &&
        (ts.isArrowFunction(caller) ||
          ts.isFunctionDeclaration(caller) ||
          ts.isFunctionExpression(caller)) &&
        caller !== owner &&
        callbackRunsInProvenDeferredHook(caller, deferredCallbackHooks)
      ) {
        return;
      }
    }
    safe = false;
  });
  return referenced && safe;
}

function callbackRunsInProvenDeferredHook(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>
): boolean {
  if (ts.isFunctionDeclaration(callback)) return false;
  const call = callback.parent;
  if (!ts.isCallExpression(call)) return false;
  const argumentIndex = call.arguments.indexOf(callback);
  const hookName = hookCallName(call);
  return argumentIndex >= 0 &&
    hookName !== null &&
    deferredCallbackHooks.get(hookName)?.has(argumentIndex) === true;
}

function callbackIsStoredInProperty(
  callback: ts.ArrowFunction | ts.FunctionExpression
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
  return ts.isPropertyAssignment(expression.parent) &&
    expression.parent.initializer === expression;
}

function callbackRunsInImmediateReactHook(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression
): boolean {
  if (ts.isFunctionDeclaration(callback)) return false;
  const call = callback.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(callback)) return false;
  return [
    "useEffect",
    "useInsertionEffect",
    "useLayoutEffect",
    "useMemo",
    "useReducer",
    "useState",
  ].includes(hookCallName(call) ?? "");
}

function boundPropIdentifier(
  owner: ChildComponentSource["owner"],
  propName: string
): ts.Identifier | null {
  const parameter = owner.parameters[0];
  if (!parameter || owner.parameters.length !== 1) return null;
  if (!ts.isObjectBindingPattern(parameter.name)) return null;
  let restBinding: ts.Identifier | null = null;
  for (const element of parameter.name.elements) {
    if (!ts.isBindingElement(element)) continue;
    if (element.dotDotDotToken) {
      if (ts.isIdentifier(element.name)) restBinding = element.name;
      continue;
    }
    if (!ts.isIdentifier(element.name) || element.initializer) continue;
    const source =
      element.propertyName && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : element.name.text;
    if (source === propName) return element.name;
  }
  if (!restBinding || !owner.body) return null;
  if (bindingDeclarationCount(owner, restBinding.text) !== 1) return null;

  let bound: ts.Identifier | null = null;
  let safe = true;
  visit(owner.body, node => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== restBinding.text ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const declaration = node.parent;
    if (
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer !== node ||
      !ts.isObjectBindingPattern(declaration.name)
    ) {
      safe = false;
      return;
    }
    for (const element of declaration.name.elements) {
      if (
        !ts.isBindingElement(element) ||
        element.dotDotDotToken ||
        !ts.isIdentifier(element.name) ||
        element.initializer
      ) {
        continue;
      }
      const source =
        element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.text;
      if (source !== propName || bound !== null) continue;
      bound = element.name;
    }
  });
  return safe && bound !== null ? bound : null;
}

function isBindingName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ts.isBindingElement(parent) ||
    ts.isVariableDeclaration(parent) ||
    (ts.isParameter(parent) && parent.name === node)
  );
}

function referenceIsWritten(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === node &&
      isAssignmentOperator(parent.operatorToken.kind)) ||
    (ts.isPrefixUnaryExpression(parent) && parent.operand === node) ||
    (ts.isPostfixUnaryExpression(parent) && parent.operand === node) ||
    (ts.isDeleteExpression(parent) && parent.expression === node)
  );
}

function isCustomJsxTag(attribute: ts.JsxAttribute): boolean {
  const container: ts.Node = attribute.parent;
  const element = ts.isJsxAttributes(container) ? container.parent : container;
  if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) {
    return true;
  }
  const tag = element.tagName.getText();
  return /^[A-Z]/.test(tag) || tag.includes(".");
}

function isJsxNode(node: ts.Node): node is ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment | ts.JsxExpression {
  return (
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxFragment(node) ||
    ts.isJsxExpression(node)
  );
}

/**
 * Accepts one bounded chain of immutable pure projections
 * (`const label = open ? "Close" : "Open"`) whose expression contains no
 * calls, awaits, assignments, or spreads, and tracks the projected name so
 * its own later reads participate in the same proof.
 */
function tracksPureProjection(
  node: ts.Identifier,
  owner: ChildComponentSource["owner"],
  tracked: Set<string>
): boolean {
  const declaration = findAncestorUntil(node, ts.isVariableDeclaration, owner);
  if (
    !declaration ||
    !declaration.initializer ||
    !nodeWithin(node, declaration.initializer) ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, declaration.name.text) !== 1 ||
    tracked.size >= MAX_TRACKED_NAMES
  ) {
    return false;
  }
  let depth = 0;
  let pure = true;
  visit(declaration.initializer, current => {
    if (!pure) return;
    if (
      ts.isCallExpression(current) ||
      ts.isNewExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isYieldExpression(current) ||
      ts.isSpreadElement(current) ||
      ts.isBinaryExpression(current) && isAssignmentOperator(current.operatorToken.kind)
    ) {
      pure = false;
      return;
    }
    if (ts.isIdentifier(current) && tracked.has(current.text)) depth += 1;
  });
  if (!pure || depth === 0) return false;
  tracked.add(declaration.name.text);
  return true;
}
