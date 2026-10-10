import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  outermostTransparentParent,
  propertyNameText,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { findAncestor, identifiersNamed, isRuntimeFunctionLike } from "../../core/ast.js";
import { ANY_MEMBER } from "../../project/source-components/observable-in-place-writes.js";
import type { MemoRead } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";

/** Array and Map methods whose inline callback receives each element at this parameter index. */
const ELEMENT_CALLBACK_PARAMETERS: ReadonlyMap<string, number> = new Map([
  ["every", 0],
  ["filter", 0],
  ["find", 0],
  ["findIndex", 0],
  ["findLast", 0],
  ["findLastIndex", 0],
  ["flatMap", 0],
  ["forEach", 0],
  ["map", 0],
  ["reduce", 1],
  ["reduceRight", 1],
  ["some", 0],
]);
const ELEMENT_RESULT_METHODS = new Set(["at", "get"]);
const MEMBERSHIP_METHODS = new Set(["has", "includes", "indexOf", "lastIndexOf"]);
const MEMBERSHIP_PROPERTIES = new Set(["length", "size"]);
const FORWARDING_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

/**
 * Every member path the memo callback reads below `name`, or null when the callback redeclares
 * the name so its references cannot be attributed.
 */
export function memoReads(callback: RuntimeFunctionLike, name: string): MemoRead[] | null {
  if (bindingDeclarationCount(callback, name) > 0) {
    return null;
  }
  return valueReferences(callback, name).flatMap((reference) => referenceReads(reference));
}

/** Every member path the expression around one reference reads below the referenced value. */
export function referenceReads(reference: ts.Identifier): MemoRead[] {
  return readsFrom(reference, []);
}

export function valueReferences(scope: ts.Node, name: string): ts.Identifier[] {
  return identifiersNamed(scope, name).filter(
    (identifier) => !isDeclarationName(identifier) && !isNonValueIdentifier(identifier),
  );
}

function readsFrom(expression: ts.Expression, path: readonly string[]): MemoRead[] {
  const outer = outermostTransparentParent(expression);
  const { parent } = outer;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === outer) {
    return propertyReads(parent, path);
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === outer) {
    return readsFrom(parent, [...path, elementKey(parent.argumentExpression)]);
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === outer) {
    return bindingReads(parent.name, path);
  }
  return operandReads(outer, path);
}

function operandReads(operand: ts.Expression, path: readonly string[]): MemoRead[] {
  const { parent } = operand;
  if (forwardsOperand(operand, parent)) {
    return readsFrom(parent, path);
  }
  if (isMembershipTest(operand, parent)) {
    return [membershipRead(path)];
  }
  return [{ consumesContents: consumesContents(operand), path }];
}

function membershipRead(path: readonly string[]): MemoRead {
  return { consumesContents: false, path: [...path, ANY_MEMBER] };
}

function propertyReads(access: ts.PropertyAccessExpression, path: readonly string[]): MemoRead[] {
  const member = access.name.text;
  const call = access.parent;
  if (ts.isCallExpression(call) && call.expression === access) {
    return methodReads(call, member, path);
  }
  if (MEMBERSHIP_PROPERTIES.has(member)) {
    return [membershipRead(path)];
  }
  return readsFrom(access, [...path, member]);
}

function methodReads(call: ts.CallExpression, method: string, path: readonly string[]): MemoRead[] {
  const elementPath = [...path, ANY_MEMBER];
  const parameterIndex = ELEMENT_CALLBACK_PARAMETERS.get(method);
  if (parameterIndex !== undefined) {
    return [membershipRead(path), ...elementCallbackReads(call, parameterIndex, elementPath)];
  }
  if (ELEMENT_RESULT_METHODS.has(method)) {
    return readsFrom(call, elementPath);
  }
  if (MEMBERSHIP_METHODS.has(method)) {
    return [membershipRead(path)];
  }
  return [{ consumesContents: true, path }];
}

function elementCallbackReads(
  call: ts.CallExpression,
  parameterIndex: number,
  elementPath: readonly string[],
): MemoRead[] {
  const callback = call.arguments[0] ? unwrapTransparentExpression(call.arguments[0]) : null;
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return [{ consumesContents: true, path: elementPath }];
  }
  const parameter = callback.parameters[parameterIndex];
  return parameter ? bindingReads(parameter.name, elementPath) : [];
}

function bindingReads(binding: ts.BindingName, path: readonly string[]): MemoRead[] {
  if (ts.isIdentifier(binding)) {
    return identifierReads(binding, path);
  }
  return [...binding.elements.entries()].flatMap(([index, element]) => {
    if (ts.isOmittedExpression(element)) {
      return [];
    }
    if (element.dotDotDotToken) {
      return [{ consumesContents: true, path }];
    }
    return bindingReads(element.name, [...path, destructuredKey(binding, element, index)]);
  });
}

function identifierReads(binding: ts.Identifier, path: readonly string[]): MemoRead[] {
  const scope = findAncestor(binding, isRuntimeFunctionLike);
  if (!scope || bindingDeclarationCount(scope, binding.text) !== 1) {
    return [{ consumesContents: true, path }];
  }
  return valueReferences(scope, binding.text).flatMap((reference) => readsFrom(reference, path));
}

function destructuredKey(
  pattern: ts.ArrayBindingPattern | ts.ObjectBindingPattern,
  element: ts.BindingElement,
  index: number,
): string {
  if (ts.isArrayBindingPattern(pattern)) {
    return String(index);
  }
  const key = element.propertyName ?? element.name;
  if (ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) {
    return propertyNameText(key) ?? ANY_MEMBER;
  }
  return ANY_MEMBER;
}

function elementKey(argument: ts.Expression): string {
  const key = unwrapTransparentExpression(argument);
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : ANY_MEMBER;
}

/** `a ?? b`, `a || b`, and the branches of `c ? a : b` can evaluate to the operand itself. */
function forwardsOperand(operand: ts.Expression, parent: ts.Node): parent is ts.Expression {
  if (ts.isBinaryExpression(parent)) {
    return FORWARDING_OPERATORS.has(parent.operatorToken.kind);
  }
  return ts.isConditionalExpression(parent) && parent.condition !== operand;
}

function isMembershipTest(operand: ts.Expression, parent: ts.Node): boolean {
  return (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.InKeyword &&
    parent.right === operand
  );
}

/**
 * Operators, conditions, and interpolation read a value, and returning or storing the reference
 * hands the live object onward. Every other use, such as a call argument, spread, or loop, or a
 * literal that is itself passed to a call, computes from the contents while the callback runs.
 */
function consumesContents(expression: ts.Expression): boolean {
  const { parent } = expression;
  if (isLiteralMember(parent)) {
    return literalIsConsumed(parent);
  }
  return !(
    ts.isBinaryExpression(parent) ||
    ts.isPrefixUnaryExpression(parent) ||
    ts.isTypeOfExpression(parent) ||
    ts.isTemplateSpan(parent) ||
    ts.isConditionalExpression(parent) ||
    ts.isIfStatement(parent) ||
    ts.isReturnStatement(parent) ||
    ts.isArrowFunction(parent) ||
    ts.isJsxExpression(parent)
  );
}

function isLiteralMember(
  node: ts.Node,
): node is ts.ArrayLiteralExpression | ts.PropertyAssignment | ts.ShorthandPropertyAssignment {
  return (
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isArrayLiteralExpression(node)
  );
}

/** Follows nested object and array literals out to the expression that receives them. */
function literalIsConsumed(
  member: ts.ArrayLiteralExpression | ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
): boolean {
  let literal: ts.Expression = ts.isArrayLiteralExpression(member) ? member : member.parent;
  for (;;) {
    const { parent } = outermostTransparentParent(literal);
    if (isLiteralMember(parent)) {
      literal = ts.isArrayLiteralExpression(parent) ? parent : parent.parent;
    } else if (ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) {
      return true;
    } else {
      return ts.isCallExpression(parent) || ts.isNewExpression(parent);
    }
  }
}
