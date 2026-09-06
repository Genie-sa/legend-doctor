import {
  bindingDeclarationCount,
  hookCallName,
  isDeclarationName,
  isInsideJsxAttribute,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  findAncestorUntil,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  visit,
} from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isHookDependencyReference } from "./callback-sites.js";
import ts from "typescript";

const EVENT_HANDLER_PROP = /^on[A-Z]/u;

export const USE_CALLBACK_HOOK: ReadonlySet<string> = new Set(["useCallback"]);

export interface EventRootQuery {
  readonly additionalRoot?: AdditionalEventRoot;
  readonly callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;
  readonly dependencyName: string;
  readonly owner: RuntimeFunctionLike;
  readonly seen: ReadonlySet<string>;
}

export function callbackIsEventRooted({
  additionalRoot = () => false,
  callback,
  dependencyName,
  owner,
  seen,
}: EventRootQuery): boolean {
  if (additionalRoot(callback, owner)) {
    return true;
  }
  if (callback.body && isInsideJsxEventCallback(callback.body, owner)) {
    return true;
  }
  const name = eventCallbackName(callback);
  if (!name || seen.has(name) || bindingDeclarationCount(owner, name) !== 1) {
    return false;
  }
  if (!useCallbackListsDependency(callback, dependencyName)) {
    return false;
  }
  return everyReferenceIsEventRooted(name, {
    additionalRoot,
    dependencyName,
    owner,
    seen: new Set(seen).add(name),
  });
}

type AdditionalEventRoot = (
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
) => boolean;

/** What a nested `callbackIsEventRooted` recursion needs to carry from its caller. */
interface EventRootTrace {
  readonly additionalRoot: AdditionalEventRoot;
  readonly dependencyName: string;
  readonly owner: RuntimeFunctionLike;
  readonly seen: ReadonlySet<string>;
}

/** The name this callback is bound to, whether by declaration, assignment, or a hook wrapper. */
function eventCallbackName(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
): string | undefined {
  if (ts.isFunctionDeclaration(callback)) {
    return callback.name?.text;
  }
  const { parent } = callback;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return ts.isCallExpression(parent) &&
    ts.isVariableDeclaration(parent.parent) &&
    ts.isIdentifier(parent.parent.name)
    ? parent.parent.name.text
    : undefined;
}

/** A useCallback wrapper stays event-rooted only while it lists the state value as a dependency. */
function useCallbackListsDependency(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  dependencyName: string,
): boolean {
  const { parent } = callback;
  if (!dependencyName || !ts.isCallExpression(parent) || hookCallName(parent) !== "useCallback") {
    return true;
  }
  const [, dependencies] = parent.arguments;
  return (
    dependencies !== undefined &&
    ts.isArrayLiteralExpression(dependencies) &&
    dependencies.elements.some(
      (element) => ts.isIdentifier(element) && element.text === dependencyName,
    )
  );
}

/** The named callback is referenced at least once, and every reference stays event-rooted. */
function everyReferenceIsEventRooted(name: string, trace: EventRootTrace): boolean {
  let referenced = false;
  let safe = true;
  visit(trace.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      isHookDependencyReference(node, USE_CALLBACK_HOOK)
    ) {
      return;
    }
    referenced = true;
    if (!eventReferenceIsRooted(node, trace)) {
      safe = false;
    }
  });
  return referenced && safe;
}

/** The reference is a JSX event handler, or a call made from another event-rooted callback. */
function eventReferenceIsRooted(reference: ts.Identifier, trace: EventRootTrace): boolean {
  const attribute = findAncestorUntil(reference, ts.isJsxAttribute, trace.owner);
  if (
    attribute &&
    EVENT_HANDLER_PROP.test(attribute.name.getText()) &&
    isJsxEventHandlerReference(attribute, reference)
  ) {
    return true;
  }
  if (!ts.isCallExpression(reference.parent) || reference.parent.expression !== reference) {
    return false;
  }
  const caller = nearestNestedFunction(reference, trace.owner);
  return (
    caller !== null &&
    isPlainFunction(caller) &&
    callbackIsEventRooted({
      callback: caller,
      owner: trace.owner,
      dependencyName: trace.dependencyName,
      seen: trace.seen,
      additionalRoot: trace.additionalRoot,
    })
  );
}

export function isPlainFunction(
  node: ts.Node,
): node is ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression {
  return (
    ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
  );
}

export function isJsxEventHandlerReference(
  attribute: ts.JsxAttribute,
  reference: ts.Identifier,
): boolean {
  const { initializer } = attribute;
  if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) {
    return false;
  }
  return isConditionalHandlerBranch(initializer.expression, reference);
}

function isConditionalHandlerBranch(expression: ts.Expression, reference: ts.Identifier): boolean {
  const value = unwrapTransparentExpression(expression);
  if (value === reference) {
    return true;
  }
  return (
    ts.isConditionalExpression(value) &&
    (isConditionalHandlerBranch(value.whenTrue, reference) ||
      isConditionalHandlerBranch(value.whenFalse, reference))
  );
}

export function isInsideJsxEventCallback(node: ts.Node, boundary: RuntimeFunctionLike): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (!isRuntimeFunctionLike(current)) {
      continue;
    }
    const attribute = findAncestorUntil(current, ts.isJsxAttribute, boundary);
    if (
      attribute &&
      isInsideJsxAttribute(current, attribute) &&
      EVENT_HANDLER_PROP.test(attribute.name.getText())
    ) {
      return true;
    }
  }
  return false;
}
