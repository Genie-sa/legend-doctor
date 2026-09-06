import {
  propertyPathHasBinding,
  staticPathHasBinding,
  unwrapTransparentExpression,
} from "../core/analysis-ast.js";
import type { HookImports } from "../core/imports.js";
import { RESERVED_OBSERVABLE_MEMBERS } from "../rules/observable-reads/observable-paths.js";
import ts from "typescript";

export function observablePathWithElementAccess(
  expression: ts.Expression,
  observableBindings: ReadonlySet<string>,
): boolean {
  let current = unwrapTransparentExpression(expression);
  let hasDynamicKey = false;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (current.questionDotToken || accessesReservedMember(current)) {
      return false;
    }
    hasDynamicKey ||= ts.isElementAccessExpression(current);
    current = unwrapTransparentExpression(current.expression);
  }
  return hasDynamicKey && ts.isIdentifier(current) && observableBindings.has(current.text);
}

function accessesReservedMember(
  access: ts.ElementAccessExpression | ts.PropertyAccessExpression,
): boolean {
  if (ts.isPropertyAccessExpression(access)) {
    return RESERVED_OBSERVABLE_MEMBERS.has(access.name.text);
  }
  if (!access.argumentExpression) {
    return true;
  }
  const member = unwrapTransparentExpression(access.argumentExpression);
  return ts.isStringLiteralLike(member) && RESERVED_OBSERVABLE_MEMBERS.has(member.text);
}

const OBSERVABLE_FACTORY_MEMBERS = new Set(["observable", "syncState"]);

export function isObservableFactoryCall(
  expression: ts.Expression,
  imports: HookImports,
  projectFactories: ReadonlySet<string>,
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (!ts.isCallExpression(value)) {
    return false;
  }
  if (ts.isIdentifier(value.expression)) {
    return (
      imports.observable.has(value.expression.text) ||
      imports.syncState.has(value.expression.text) ||
      imports.useComputed.has(value.expression.text) ||
      imports.useObservable.has(value.expression.text) ||
      projectFactories.has(value.expression.text)
    );
  }
  return (
    ts.isPropertyAccessExpression(value.expression) &&
    ts.isIdentifier(value.expression.expression) &&
    imports.legendNamespaces.has(value.expression.expression.text) &&
    OBSERVABLE_FACTORY_MEMBERS.has(value.expression.name.text)
  );
}

export function expressionIsObservablePath(
  expression: ts.Expression,
  observableBindings: ReadonlySet<string>,
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value)) {
    return false;
  }
  for (
    let current: ts.Expression = value;
    ts.isPropertyAccessExpression(current);
    current = current.expression
  ) {
    if (RESERVED_OBSERVABLE_MEMBERS.has(current.name.text)) {
      return false;
    }
  }
  return staticPathHasBinding(value, observableBindings);
}

export function typeQueriesObservable(
  type: ts.TypeNode,
  observableBindings: ReadonlySet<string>,
): boolean {
  if (ts.isParenthesizedTypeNode(type)) {
    return typeQueriesObservable(type.type, observableBindings);
  }
  if (!ts.isTypeQueryNode(type)) {
    return false;
  }
  const path = unreservedEntityNamePath(type.exprName);
  return path !== null && propertyPathHasBinding(path, observableBindings);
}

function unreservedEntityNamePath(exprName: ts.EntityName): string[] | null {
  const path: string[] = [];
  let current: ts.EntityName = exprName;
  while (ts.isQualifiedName(current)) {
    if (RESERVED_OBSERVABLE_MEMBERS.has(current.right.text)) {
      return null;
    }
    path.unshift(current.right.text);
    current = current.left;
  }
  path.unshift(current.text);
  return path;
}

export function typeNamesObservable(type: ts.TypeNode, names: ReadonlySet<string>): boolean {
  if (ts.isParenthesizedTypeNode(type)) {
    return typeNamesObservable(type.type, names);
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.some((member) => typeNamesObservable(member, names));
  }
  return (
    ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && names.has(type.typeName.text)
  );
}
