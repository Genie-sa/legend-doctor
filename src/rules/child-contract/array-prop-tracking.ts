import {
  bindingDeclarationCount,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { isBindingName, propertyName } from "./prop-bindings.js";
import type { ChildComponentSource } from "./model.js";
import { MAX_TRACKED_NAMES } from "./model.js";
import { climbTransparentExpression } from "./carried-values.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

const TRACKED_ARRAY_ITERATION_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "flatMap",
  "forEach",
  "map",
  "some",
]);

export function trackedArrayNames(
  source: ChildComponentSource,
  boundName: string,
): ReadonlySet<string> {
  const arrayNames = new Set([boundName]);
  let addedAlias = true;
  const collectAlias = (node: ts.Node): void => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.initializer ||
      arrayNames.has(node.name.text) ||
      !ts.isVariableDeclarationList(node.parent) ||
      (node.parent.flags & ts.NodeFlags.Const) === 0 ||
      bindingDeclarationCount(source.owner, node.name.text) !== 1 ||
      !isFilteredArrayAlias(node.initializer, arrayNames)
    ) {
      return;
    }
    arrayNames.add(node.name.text);
    addedAlias = true;
  };
  while (addedAlias && arrayNames.size < MAX_TRACKED_NAMES) {
    addedAlias = false;
    visit(source.owner.body, collectAlias);
  }
  return arrayNames;
}

export function arrayItemNames(
  source: ChildComponentSource,
  arrayNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const itemNames = new Set<string>();
  visit(source.owner.body, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      [...arrayNames].some((name) => isArrayItemLookup(node.initializer!, name))
    ) {
      itemNames.add(node.name.text);
    }
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      node.parameters[0] &&
      ts.isIdentifier(node.parameters[0].name) &&
      isArrayIterationCallback(node, arrayNames)
    ) {
      itemNames.add(node.parameters[0].name.text);
    }
  });
  return itemNames;
}

export function spreadCallbackIsOverridden(
  spread: ts.SpreadAssignment,
  callbackProp: string,
): boolean {
  const object = spread.parent;
  if (!ts.isObjectLiteralExpression(object)) {
    return false;
  }
  const following = object.properties.slice(object.properties.indexOf(spread) + 1);
  return (
    !following.some((property) => ts.isSpreadAssignment(property)) &&
    following.some(
      (property) =>
        !ts.isSpreadAssignment(property) && propertyName(property.name) === callbackProp,
    )
  );
}

export function arrayBindingsStayWithinTrackedConsumers(
  source: ChildComponentSource,
  arrayNames: ReadonlySet<string>,
): boolean {
  let safe = true;
  visit(source.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      !arrayNames.has(node.text) ||
      isBindingName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    safe = arrayReferenceStaysTracked(node);
  });
  return safe;
}

function arrayReferenceStaysTracked(node: ts.Identifier): boolean {
  const value = climbTransparentExpression(node);
  const member = value.parent;
  if (!ts.isPropertyAccessExpression(member) || member.expression !== value) {
    return false;
  }
  if (member.name.text === "length") {
    return true;
  }
  return (
    ts.isCallExpression(member.parent) &&
    member.parent.expression === member &&
    (member.name.text === "at" || TRACKED_ARRAY_ITERATION_METHODS.has(member.name.text))
  );
}

function isArrayItemLookup(expression: ts.Expression, arrayName: string): boolean {
  return (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === arrayName &&
    expression.expression.name.text === "at"
  );
}

function isFilteredArrayAlias(expression: ts.Expression, arrayNames: ReadonlySet<string>): boolean {
  const call = unwrapTransparentExpression(expression);
  return (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    arrayNames.has(call.expression.expression.text) &&
    call.expression.name.text === "filter" &&
    call.arguments[0] !== undefined &&
    (ts.isArrowFunction(call.arguments[0]) || ts.isFunctionExpression(call.arguments[0]))
  );
}

function isArrayIterationCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  arrayNames: ReadonlySet<string>,
): boolean {
  const call = callback.parent;
  return (
    ts.isCallExpression(call) &&
    call.arguments[0] === callback &&
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    arrayNames.has(call.expression.expression.text) &&
    TRACKED_ARRAY_ITERATION_METHODS.has(call.expression.name.text)
  );
}
