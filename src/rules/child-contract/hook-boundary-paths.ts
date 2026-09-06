import type { ChildComponentSource, TrackedCallbackPath } from "./model.js";
import { bindingElementPropertyName, propertyName } from "./prop-bindings.js";
import {
  findAncestor,
  findAncestorUntil,
  isRuntimeFunctionLike,
  nodeWithin,
} from "../../core/ast.js";
import { hookCallName, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { expressionCarriesValue } from "./carried-values.js";
import ts from "typescript";

function valueIsDirectlyReturned(
  value: ts.Expression,
  owner: ChildComponentSource["owner"],
): boolean {
  const directReturn = findAncestorUntil(value, ts.isReturnStatement, owner);
  return (
    directReturn?.expression !== undefined &&
    findAncestor(directReturn, isRuntimeFunctionLike) === owner &&
    unwrapTransparentExpression(directReturn.expression) === unwrapTransparentExpression(value)
  );
}

function objectIsReturned(
  object: ts.ObjectLiteralExpression,
  owner: ChildComponentSource["owner"],
): boolean {
  const objectReturn = findAncestorUntil(object, ts.isReturnStatement, owner);
  return (
    objectReturn?.expression !== undefined &&
    findAncestor(objectReturn, isRuntimeFunctionLike) === owner &&
    unwrapTransparentExpression(objectReturn.expression) === object
  );
}

interface ReturnedMember {
  readonly index: number;
  readonly member: ts.ObjectLiteralElementLike;
  readonly object: ts.ObjectLiteralExpression;
  readonly path: readonly string[];
}

function spreadMemberPath(returned: ReturnedMember): readonly string[] | "ignored" {
  const { index, object, path } = returned;
  const [head] = path;
  if (!head) {
    return path;
  }
  const overridden = object.properties
    .slice(index + 1)
    .some(
      (candidate) =>
        (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
        propertyName(candidate.name) === head,
    );
  return overridden ? "ignored" : path;
}

function returnedMemberPath(returned: ReturnedMember): readonly string[] | "ignored" | null {
  const { member, path } = returned;
  if (ts.isSpreadAssignment(member)) {
    return spreadMemberPath(returned);
  }
  if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member)) {
    return null;
  }
  const property = propertyName(member.name);
  return property ? [property, ...path] : null;
}

export function returnedCallbackPath(
  value: ts.Expression,
  path: readonly string[],
  owner: ChildComponentSource["owner"],
): readonly string[] | "ignored" | null {
  if (valueIsDirectlyReturned(value, owner)) {
    return path;
  }
  const object = findAncestorUntil(value, ts.isObjectLiteralExpression, owner);
  if (!object || !objectIsReturned(object, owner)) {
    return null;
  }
  const index = object.properties.findIndex((member) => nodeWithin(value, member));
  const member = index === -1 ? null : object.properties[index];
  if (!member) {
    return null;
  }
  return returnedMemberPath({ index, member, object, path });
}

export function destructuredCallbackPath(
  owner: ChildComponentSource["owner"],
  expression: ts.Expression,
  path: readonly string[],
): TrackedCallbackPath | null {
  const [head, ...tail] = path;
  if (!head) {
    return null;
  }
  const declaration = findAncestorUntil(expression, ts.isVariableDeclaration, owner);
  if (
    !declaration?.initializer ||
    !ts.isObjectBindingPattern(declaration.name) ||
    !expressionCarriesValue(declaration.initializer, expression)
  ) {
    return null;
  }
  const matches = declaration.name.elements.filter(
    (element) =>
      !element.dotDotDotToken &&
      ts.isIdentifier(element.name) &&
      bindingElementPropertyName(element) === head,
  );
  const match = matches.length === 1 ? matches[0] : null;
  return match && ts.isIdentifier(match.name) ? { name: match.name.text, path: tail } : null;
}

function forwardedObjectCallTarget(
  member: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  object: ts.Node,
  call: ts.CallExpression,
): { argumentIndex: number; call: ts.CallExpression; hookName: string; property: string } | null {
  const argumentIndex = call.arguments.findIndex((argument) => nodeWithin(object, argument));
  const hookName = hookCallName(call);
  const property = propertyName(member.name);
  return argumentIndex !== -1 && hookName && property
    ? { argumentIndex, call, hookName, property }
    : null;
}

export function forwardedObjectCall(
  expression: ts.Expression,
  owner: ChildComponentSource["owner"],
): { argumentIndex: number; call: ts.CallExpression; hookName: string; property: string } | null {
  const member = expression.parent;
  if (
    !ts.isShorthandPropertyAssignment(member) &&
    !(ts.isPropertyAssignment(member) && nodeWithin(expression, member.initializer))
  ) {
    return null;
  }
  const object = member.parent;
  const call = ts.isObjectLiteralExpression(object)
    ? findAncestorUntil(object, ts.isCallExpression, owner)
    : null;
  if (!call) {
    return null;
  }
  return forwardedObjectCallTarget(member, object, call);
}

export function directCallArgument(
  expression: ts.Expression,
  owner: ChildComponentSource["owner"],
): { argumentIndex: number; call: ts.CallExpression; hookName: string } | null {
  const call = findAncestorUntil(expression, ts.isCallExpression, owner);
  if (!call || nodeWithin(expression, call.expression)) {
    return null;
  }
  const argumentIndex = call.arguments.findIndex((argument) => nodeWithin(expression, argument));
  const hookName = hookCallName(call);
  return argumentIndex !== -1 && hookName ? { argumentIndex, call, hookName } : null;
}
