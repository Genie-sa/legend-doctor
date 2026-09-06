import {
  bindingDeclarationCount,
  hookCallName,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { findAncestorUntil, nodeWithin, visit } from "../../core/ast.js";
import type { ChildComponentSource } from "./model.js";
import { climbTransparentExpression } from "./carried-values.js";
import { jsxAttributeDirectlyCarries } from "./jsx-owner.js";
import { propertyName } from "./prop-bindings.js";
import ts from "typescript";

interface ContextPublication {
  contextName: string;
  property: string;
}

function memoizedResultBinding(
  object: ts.ObjectLiteralExpression,
  owner: ChildComponentSource["owner"],
): string | null {
  const call = findAncestorUntil(object, ts.isCallExpression, owner);
  if (
    !call ||
    hookCallName(call) !== "useMemo" ||
    bindingDeclarationCount(owner, "useMemo") !== 0 ||
    !call.arguments[0] ||
    !nodeWithin(object, call.arguments[0])
  ) {
    return null;
  }
  const carriedCall = climbTransparentExpression(call);
  const declaration = carriedCall.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== carriedCall ||
    !ts.isIdentifier(declaration.name) ||
    bindingDeclarationCount(owner, declaration.name.text) !== 1
  ) {
    return null;
  }
  return declaration.name.text;
}

function memoizedObjectProperty(
  expression: ts.Expression,
  owner: ChildComponentSource["owner"],
): { readonly bindingName: string; readonly name: string } | null {
  const member = expression.parent;
  if (
    !ts.isShorthandPropertyAssignment(member) &&
    !(
      ts.isPropertyAssignment(member) &&
      unwrapTransparentExpression(member.initializer) === expression
    )
  ) {
    return null;
  }
  const name = propertyName(member.name);
  const object = member.parent;
  if (!name || !ts.isObjectLiteralExpression(object)) {
    return null;
  }
  const bindingName = memoizedResultBinding(object, owner);
  return bindingName ? { bindingName, name } : null;
}

function providedContextName(
  bindingName: string,
  owner: ChildComponentSource["owner"],
): string | null {
  let contextName: string | null = null;
  let references = 0;
  let safe = true;
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== bindingName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    references += 1;
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    const provider = attribute && jsxContextProvider(attribute, node);
    if (!provider || (contextName !== null && contextName !== provider)) {
      safe = false;
      return;
    }
    contextName = provider;
  });
  return safe && references > 0 ? contextName : null;
}

export function memoizedContextPublication(
  expression: ts.Expression,
  owner: ChildComponentSource["owner"],
): ContextPublication | null {
  const published = memoizedObjectProperty(expression, owner);
  if (!published) {
    return null;
  }
  const contextName = providedContextName(published.bindingName, owner);
  return contextName ? { contextName, property: published.name } : null;
}

function jsxContextProvider(attribute: ts.JsxAttribute, expression: ts.Expression): string | null {
  if (attribute.name.getText() !== "value" || !jsxAttributeDirectlyCarries(attribute, expression)) {
    return null;
  }
  const attributes = attribute.parent;
  const opening = ts.isJsxAttributes(attributes) ? attributes.parent : null;
  const tag =
    opening && (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening))
      ? opening.tagName
      : null;
  return tag &&
    ts.isPropertyAccessExpression(tag) &&
    ts.isIdentifier(tag.expression) &&
    tag.name.text === "Provider"
    ? tag.expression.text
    : null;
}
