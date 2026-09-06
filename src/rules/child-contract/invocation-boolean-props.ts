import {
  bindingDeclarationCount,
  isAssignmentOperator,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { bindingElementPropertyName, isBindingName } from "./prop-bindings.js";
import { isRuntimeFunctionLike, nodeWithin, visit } from "../../core/ast.js";
import type { ChildComponentSource } from "./model.js";
import { climbTransparentExpression } from "./carried-values.js";
import ts from "typescript";

function bindingIsWritten(
  source: ChildComponentSource,
  binding: ts.Identifier,
  declared: ts.BindingName,
): boolean {
  let written = false;
  visit(source.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === binding.text &&
      node !== declared &&
      !isNonValueIdentifier(node) &&
      referenceIsWithinWriteTarget(node, source.owner)
    ) {
      written = true;
    }
  });
  return written;
}

function boundBooleanProp(
  source: ChildComponentSource,
  element: ts.BindingElement,
  propName: string,
): boolean | null {
  const value = booleanPropValueAtInvocation(source, propName);
  if (value !== "absent") {
    return value;
  }
  return element.initializer
    ? booleanLiteral(unwrapTransparentExpression(element.initializer))
    : null;
}

export function booleanPropAtInvocation(
  source: ChildComponentSource,
  binding: ts.Identifier,
): boolean | null {
  const [parameter] = source.owner.parameters;
  if (!parameter || !ts.isObjectBindingPattern(parameter.name)) {
    return null;
  }
  const matches = parameter.name.elements.filter(
    (element) =>
      !element.dotDotDotToken &&
      ts.isIdentifier(element.name) &&
      element.name.text === binding.text,
  );
  const element = matches.length === 1 ? matches[0] : null;
  const propName = element ? bindingElementPropertyName(element) : null;
  if (
    !element ||
    !propName ||
    bindingDeclarationCount(source.owner, binding.text) !== 1 ||
    bindingIsWritten(source, binding, element.name)
  ) {
    return null;
  }
  return boundBooleanProp(source, element, propName);
}

function jsxBooleanAttributeValue(
  attribute: ts.JsxAttribute,
  propName: string,
): boolean | "absent" | null {
  if (attribute.name.getText() !== propName) {
    return "absent";
  }
  if (!attribute.initializer) {
    return true;
  }
  if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) {
    return null;
  }
  return booleanLiteral(unwrapTransparentExpression(attribute.initializer.expression));
}

function booleanPropValueAtInvocation(
  source: ChildComponentSource,
  propName: string,
): boolean | "absent" | null {
  if (!source.invocation) {
    return null;
  }
  let value: boolean | "absent" = "absent";
  for (const attribute of source.invocation.attributes.properties) {
    const contributed = ts.isJsxAttribute(attribute)
      ? jsxBooleanAttributeValue(attribute, propName)
      : booleanPropFromSpread(source.invocationOwner, attribute.expression, propName);
    if (contributed === null) {
      return null;
    }
    if (contributed !== "absent") {
      value = contributed;
    }
  }
  return value;
}

function spreadRestBinding(
  owner: ChildComponentSource,
  name: string,
): ts.ObjectBindingPattern | null {
  const [parameter] = owner.owner.parameters;
  if (!parameter || !ts.isObjectBindingPattern(parameter.name)) {
    return null;
  }
  const rest = parameter.name.elements.filter(
    (element) =>
      element.dotDotDotToken && ts.isIdentifier(element.name) && element.name.text === name,
  );
  if (rest.length !== 1 || bindingDeclarationCount(owner.owner, name) !== 1) {
    return null;
  }
  return parameter.name;
}

function spreadRestOnlyForwards(owner: ChildComponentSource, name: string): boolean {
  let safe = true;
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isBindingName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const carried = climbTransparentExpression(node);
    if (!ts.isJsxSpreadAttribute(carried.parent) || carried.parent.expression !== carried) {
      safe = false;
    }
  });
  return safe;
}

function booleanPropFromSpread(
  owner: ChildComponentSource | undefined,
  expression: ts.Expression,
  propName: string,
): boolean | "absent" | null {
  const value = unwrapTransparentExpression(expression);
  if (!owner || !ts.isIdentifier(value)) {
    return null;
  }
  const pattern = spreadRestBinding(owner, value.text);
  if (!pattern || !spreadRestOnlyForwards(owner, value.text)) {
    return null;
  }
  const excluded = pattern.elements.some(
    (element) => !element.dotDotDotToken && bindingElementPropertyName(element) === propName,
  );
  return excluded ? "absent" : booleanPropValueAtInvocation(owner, propName);
}

function booleanLiteral(expression: ts.Expression): boolean | null {
  if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expression.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  return null;
}

type WriteTargetVerdict = "continue" | "no" | "yes";

function writeTargetVerdict(
  reference: ts.Identifier,
  current: ts.Node,
  parent: ts.Node,
): WriteTargetVerdict {
  if (ts.isBinaryExpression(parent) && isAssignmentOperator(parent.operatorToken.kind)) {
    return nodeWithin(reference, parent.left) ? "yes" : "no";
  }
  if (
    (ts.isPostfixUnaryExpression(parent) && parent.operand === current) ||
    (ts.isPrefixUnaryExpression(parent) &&
      parent.operand === current &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken))
  ) {
    return "yes";
  }
  if (
    (ts.isDeleteExpression(parent) && parent.expression === current) ||
    ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) &&
      nodeWithin(reference, parent.initializer))
  ) {
    return "yes";
  }
  if (ts.isStatement(parent) || ts.isCallExpression(parent) || isRuntimeFunctionLike(parent)) {
    return "no";
  }
  return "continue";
}

function referenceIsWithinWriteTarget(
  reference: ts.Identifier,
  owner: ChildComponentSource["owner"],
): boolean {
  for (
    let current: ts.Node = reference;
    current.parent && current.parent !== owner;
    current = current.parent
  ) {
    const verdict = writeTargetVerdict(reference, current, current.parent);
    if (verdict !== "continue") {
      return verdict === "yes";
    }
  }
  return false;
}
