import type { HookBody, ReactHookImports, StoredCallbackRef } from "./model.js";
import {
  callbackIsReactEffectArgument,
  isImportedReactRef,
  isTracedFunction,
} from "./react-effects.js";
import {
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { nearestNestedFunction, nodeWithin, visit } from "../../core/ast.js";
import ts from "typescript";

export function storedCallbackRef(
  callback: ts.Identifier,
  body: HookBody,
): StoredCallbackRef | null {
  const matches: StoredCallbackRef[] = [];
  visit(body.source.owner.body, (node) => {
    const stored = refStoringCallback(node, callback.text, body.hooks);
    if (stored) {
      matches.push(stored);
    }
  });
  return matches.length === 1 ? matches[0]! : null;
}

/** A `useRef({ ... })` declaration whose literal captures the given binding under one property. */
function refStoringCallback(
  node: ts.Node,
  binding: string,
  hooks: ReactHookImports,
): StoredCallbackRef | null {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
    return null;
  }
  const initializer = unwrapTransparentExpression(node.initializer);
  if (
    !ts.isCallExpression(initializer) ||
    !isImportedReactRef(initializer, hooks) ||
    !initializer.arguments[0]
  ) {
    return null;
  }
  const object = unwrapTransparentExpression(initializer.arguments[0]!);
  if (!ts.isObjectLiteralExpression(object)) {
    return null;
  }
  const property = objectPropertyForBinding(object, binding);
  return property ? { declaration: node, name: node.name.text, property } : null;
}

function objectPropertyForBinding(
  object: ts.ObjectLiteralExpression,
  binding: string,
): string | null {
  const matches = object.properties.flatMap((property) => {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === binding) {
      return [property.name.text];
    }
    const value = ts.isPropertyAssignment(property)
      ? unwrapTransparentExpression(property.initializer)
      : null;
    if (
      ts.isPropertyAssignment(property) &&
      value &&
      ts.isIdentifier(value) &&
      value.text === binding
    ) {
      const name = staticPropertyName(property.name);
      return name ? [name] : [];
    }
    return [];
  });
  return matches.length === 1 ? matches[0]! : null;
}

export function callbackReferenceIsRefStorage(
  reference: ts.Identifier,
  storedRef: StoredCallbackRef,
  body: HookBody,
): boolean {
  const member = objectLiteralMemberFor(reference);
  if (!member || objectPropertyName(member.property) !== storedRef.property) {
    return false;
  }
  if (nodeWithin(member.object, storedRef.declaration.initializer!)) {
    return true;
  }
  return refObjectIsAssignedInEffect(member.object, storedRef, body);
}

export function refRefreshesCallback(
  callback: ts.Identifier,
  storedRef: StoredCallbackRef,
  body: HookBody,
): boolean {
  let refreshes = 0;
  visit(body.source.owner.body, (node) => {
    if (
      !ts.isIdentifier(node) ||
      node.text !== callback.text ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const member = objectLiteralMemberFor(node);
    if (
      member &&
      objectPropertyName(member.property) === storedRef.property &&
      refObjectIsAssignedInEffect(member.object, storedRef, body)
    ) {
      refreshes += 1;
    }
  });
  return refreshes === 1;
}

interface ObjectLiteralMember {
  readonly object: ts.ObjectLiteralExpression;
  readonly property: ts.ObjectLiteralElementLike;
}

/** The object literal member that carries this reference, either shorthand or as the value. */
function objectLiteralMemberFor(reference: ts.Node): ObjectLiteralMember | null {
  const property = reference.parent;
  if (ts.isShorthandPropertyAssignment(property) && property.name === reference) {
    return ts.isObjectLiteralExpression(property.parent)
      ? { object: property.parent, property }
      : null;
  }
  if (ts.isPropertyAssignment(property) && nodeWithin(reference, property.initializer)) {
    return ts.isObjectLiteralExpression(property.parent)
      ? { object: property.parent, property }
      : null;
  }
  return null;
}

/** The literal is the right side of a `ref.current = { ... }` written inside a React effect. */
function refObjectIsAssignedInEffect(
  object: ts.ObjectLiteralExpression,
  storedRef: StoredCallbackRef,
  body: HookBody,
): boolean {
  const assignment = object.parent;
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    assignment.right !== object ||
    !isRefCurrent(assignment.left, storedRef.name)
  ) {
    return false;
  }
  const effect = nearestNestedFunction(assignment, body.source.owner);
  return (
    effect !== null && isTracedFunction(effect) && callbackIsReactEffectArgument(effect, body.hooks)
  );
}

function objectPropertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name.text;
  }
  return ts.isPropertyAssignment(property) ? staticPropertyName(property.name) : null;
}

export function refCurrentAssignment(reference: ts.Identifier, refName: string): boolean {
  const current = reference.parent;
  return (
    ts.isPropertyAccessExpression(current) &&
    current.expression === reference &&
    current.name.text === "current" &&
    ts.isBinaryExpression(current.parent) &&
    current.parent.left === current &&
    current.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    isRefCurrent(current, refName)
  );
}

export function refObjectPropertyAccess(
  reference: ts.Identifier,
): ts.PropertyAccessExpression | null {
  const current = reference.parent;
  if (
    !ts.isPropertyAccessExpression(current) ||
    current.expression !== reference ||
    current.name.text !== "current"
  ) {
    return null;
  }
  const callback = current.parent;
  return ts.isPropertyAccessExpression(callback) && callback.expression === current
    ? callback
    : null;
}

function isRefCurrent(expression: ts.Expression, refName: string): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === refName &&
    expression.name.text === "current"
  );
}

function staticPropertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
}
