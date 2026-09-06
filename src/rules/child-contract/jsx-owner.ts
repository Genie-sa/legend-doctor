import { bindingDeclarationCount, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import type { ChildComponentSource } from "./model.js";
import { booleanPropAtInvocation } from "./invocation-boolean-props.js";
import ts from "typescript";
import { uniqueVariableDeclaration } from "../state-proofs/binding-lookup.js";

export function jsxAttributeDirectlyCarries(
  attribute: ts.JsxAttribute,
  expression: ts.Expression,
): boolean {
  const { initializer } = attribute;
  return (
    initializer !== undefined &&
    ts.isJsxExpression(initializer) &&
    initializer.expression !== undefined &&
    unwrapTransparentExpression(initializer.expression) === unwrapTransparentExpression(expression)
  );
}

export function jsxOwnerTarget(attribute: ts.JsxAttribute | ts.JsxSpreadAttribute): string | null {
  const opening = jsxOwnerOpening(attribute);
  return opening ? jsxTagName(opening.tagName) : null;
}

function jsxOwnerOpening(
  attribute: ts.JsxAttribute | ts.JsxSpreadAttribute,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const attributes = attribute.parent;
  const opening = ts.isJsxAttributes(attributes) ? attributes.parent : null;
  return opening && (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening))
    ? opening
    : null;
}

function jsxOwnerIsIntrinsic(attribute: ts.JsxAttribute | ts.JsxSpreadAttribute): boolean {
  const opening = jsxOwnerOpening(attribute);
  return (
    opening !== null && ts.isIdentifier(opening.tagName) && /^[a-z]/u.test(opening.tagName.text)
  );
}

export function atJsxInvocation(
  source: ChildComponentSource,
  attribute: ts.JsxAttribute | ts.JsxSpreadAttribute,
  invocationOwner: ChildComponentSource | undefined,
): ChildComponentSource {
  const invocation = jsxOwnerOpening(attribute);
  if (!invocation) {
    return source;
  }
  if (!invocationOwner) {
    return { ...source, invocation };
  }
  return { ...source, invocation, invocationOwner };
}

function conditionalTagDeclaration(
  source: ChildComponentSource,
  tagName: string,
): ts.ConditionalExpression | null {
  const declaration = uniqueVariableDeclaration(source.body, tagName);
  if (
    !declaration?.initializer ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(source.owner, declaration.name.text) !== 1
  ) {
    return null;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  return ts.isConditionalExpression(initializer) ? initializer : null;
}

function selectedTagIsIntrinsic(selected: ts.Expression | null): boolean {
  if (!selected) {
    return false;
  }
  const target = unwrapTransparentExpression(selected);
  return ts.isStringLiteralLike(target) && /^[a-z]/u.test(target.text);
}

function conditionalTagResolvesToIntrinsic(source: ChildComponentSource, tagName: string): boolean {
  const initializer = conditionalTagDeclaration(source, tagName);
  if (!initializer) {
    return false;
  }
  const condition = unwrapTransparentExpression(initializer.condition);
  if (!ts.isIdentifier(condition)) {
    return false;
  }
  return selectedTagIsIntrinsic(
    selectedConditionalBranch(initializer, booleanPropAtInvocation(source, condition)),
  );
}

export function jsxOwnerIsDeferredEventTarget(
  attribute: ts.JsxAttribute | ts.JsxSpreadAttribute,
  source: ChildComponentSource | undefined,
): boolean {
  if (jsxOwnerIsIntrinsic(attribute)) {
    return true;
  }
  const opening = jsxOwnerOpening(attribute);
  if (!source?.invocation || !opening || !ts.isIdentifier(opening.tagName)) {
    return false;
  }
  return conditionalTagResolvesToIntrinsic(source, opening.tagName.text);
}

function selectedConditionalBranch(
  initializer: ts.ConditionalExpression,
  conditionValue: boolean | null,
): ts.Expression | null {
  if (conditionValue === true) {
    return initializer.whenTrue;
  }
  return conditionValue === false ? initializer.whenFalse : null;
}

function jsxTagName(name: ts.JsxTagNameExpression): string | null {
  return ts.isIdentifier(name) || ts.isPropertyAccessExpression(name) ? name.getText() : null;
}
