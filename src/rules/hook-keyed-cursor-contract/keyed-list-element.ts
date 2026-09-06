import {
  isImportedUseCallback,
  jsxAttributeContaining,
  uniqueDirectJsxAttributeReference,
} from "./binding-references.js";
import { isPureExpression, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";
import { uniqueVariableDeclaration } from "../state-proofs/binding-lookup.js";
import { visit } from "../../core/ast.js";

export function keyedListElementIsStable(
  owner: RuntimeFunctionLike,
  renderName: ts.Identifier,
  extraDataReference: ts.Identifier,
): boolean {
  const renderAttribute = uniqueDirectJsxAttributeReference(owner, renderName, "renderItem");
  const extraAttribute = jsxAttributeContaining(extraDataReference, "extraData");
  if (!renderAttribute || !extraAttribute || renderAttribute.parent !== extraAttribute.parent) {
    return false;
  }
  const opening = renderAttribute.parent.parent;
  if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) {
    return false;
  }
  const keyAttribute = opening.attributes.properties.find(
    (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText() === "keyExtractor",
  );
  return (
    keyAttribute !== undefined &&
    ts.isJsxAttribute(keyAttribute) &&
    keyExtractorIsStable(keyAttribute, owner)
  );
}

function keyExtractorIsStable(attribute: ts.JsxAttribute, owner: RuntimeFunctionLike): boolean {
  const callback = keyExtractorCallback(attribute, owner);
  const item = callback?.parameters[0]?.name;
  if (!callback || !item || !ts.isIdentifier(item)) {
    return false;
  }
  return returnsItemPropertyWithoutIndex(callback, item);
}

function keyExtractorCallback(
  attribute: ts.JsxAttribute,
  owner: RuntimeFunctionLike,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const expression =
    attribute.initializer && ts.isJsxExpression(attribute.initializer)
      ? attribute.initializer.expression
      : null;
  return expression ? callbackFromExpression(expression, owner) : null;
}

function returnsItemPropertyWithoutIndex(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  item: ts.Identifier,
): boolean {
  const index = callback.parameters[1]?.name;
  const returned = callbackReturnExpression(callback);
  if (!returned || !isPureExpression(returned)) {
    return false;
  }
  let itemProperty = false;
  let usesIndex = false;
  visit(returned, (node) => {
    if (ts.isPropertyAccessExpression(node) && propertyAccessRoot(node)?.text === item.text) {
      itemProperty = true;
    }
    if (index && ts.isIdentifier(index) && ts.isIdentifier(node) && node.text === index.text) {
      usesIndex = true;
    }
  });
  return itemProperty && !usesIndex;
}

function inlineCallback(value: ts.Expression): ts.ArrowFunction | ts.FunctionExpression | null {
  return ts.isArrowFunction(value) || ts.isFunctionExpression(value) ? value : null;
}

function callbackFromExpression(
  expression: ts.Expression,
  owner: RuntimeFunctionLike,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const value = unwrapTransparentExpression(expression);
  const inline = inlineCallback(value);
  if (inline || !ts.isIdentifier(value)) {
    return inline;
  }
  const declaration = uniqueVariableDeclaration(owner, value.text);
  return declaration?.initializer ? callbackFromInitializer(declaration.initializer) : null;
}

function callbackFromInitializer(
  source: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const initializer = unwrapTransparentExpression(source);
  const inline = inlineCallback(initializer);
  if (inline) {
    return inline;
  }
  if (!ts.isCallExpression(initializer) || !isImportedUseCallback(initializer)) {
    return null;
  }
  const [callback] = initializer.arguments;
  return callback ? inlineCallback(callback) : null;
}

function callbackReturnExpression(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | null {
  if (!ts.isBlock(callback.body)) {
    return callback.body;
  }
  const { statements } = callback.body;
  return statements.length === 1 && ts.isReturnStatement(statements[0]!)
    ? (statements[0]!.expression ?? null)
    : null;
}

function propertyAccessRoot(expression: ts.PropertyAccessExpression): ts.Identifier | null {
  let current: ts.Expression = expression.expression;
  while (ts.isPropertyAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current : null;
}
