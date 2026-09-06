import {
  findAncestorUntil,
  nearestNestedFunction,
  nodeWithin,
  visit,
  visitSkippingNestedFunctions,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import {
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { expressionContainsJsx } from "../deferred-reveal/jsx-subtrees.js";
import { expressionDependsOnBinding } from "../state-proofs/binding-lookup.js";
import { nearestRepeatedRenderCall } from "../state-proofs/jsx-subtrees.js";
import ts from "typescript";

export function isStableRenderedMembership(
  membership: ts.CallExpression,
  owner: RuntimeFunctionLike,
): boolean {
  const callback = renderedListCallback(membership, owner);
  if (
    !callback ||
    !membershipUsesCallbackKey(membership, callback) ||
    membershipControlsRepeatedMount(membership, owner)
  ) {
    return false;
  }
  const callbackName = memoizedCallbackName(callback.parent);
  const opening = callbackName ? soleRenderItemOpening(owner, callbackName) : null;
  const extractor = opening ? keyExtractorFunction(opening) : null;
  return extractor !== null && returnsItemPropertyPath(extractor);
}

function soleRenderItemOpening(
  owner: RuntimeFunctionLike,
  callbackName: string,
): ts.JsxOpeningLikeElement | null {
  const openings = new Set<ts.JsxOpeningLikeElement>();
  let callbackConfined = true;
  visit(owner.body, (node) => {
    if (
      !callbackConfined ||
      !ts.isIdentifier(node) ||
      node.text !== callbackName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const opening = renderItemAttributeOwner(node);
    if (opening) {
      openings.add(opening);
    } else {
      callbackConfined = false;
    }
  });
  return callbackConfined && openings.size === 1 ? [...openings][0]! : null;
}

function renderItemAttributeOwner(node: ts.Identifier): ts.JsxOpeningLikeElement | null {
  const expression = node.parent;
  if (!ts.isJsxExpression(expression) || expression.expression !== node) {
    return null;
  }
  const attribute = expression.parent;
  return ts.isJsxAttribute(attribute) &&
    attribute.name.getText() === "renderItem" &&
    ts.isJsxAttributes(attribute.parent)
    ? attribute.parent.parent
    : null;
}

function keyExtractorFunction(
  opening: ts.JsxOpeningLikeElement,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const keyExtractor = opening.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === "keyExtractor",
  );
  if (!keyExtractor || !ts.isJsxAttribute(keyExtractor)) {
    return null;
  }
  const { initializer } = keyExtractor;
  const expression = initializer && ts.isJsxExpression(initializer) ? initializer.expression : null;
  if (!expression) {
    return null;
  }
  const extractor = unwrapTransparentExpression(expression);
  return ts.isArrowFunction(extractor) || ts.isFunctionExpression(extractor) ? extractor : null;
}

function returnsItemPropertyPath(extractor: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const parameter = extractor.parameters[0]?.name;
  if (!parameter || !ts.isIdentifier(parameter) || ts.isBlock(extractor.body)) {
    return false;
  }
  let root = unwrapTransparentExpression(extractor.body);
  let propertyDepth = 0;
  while (ts.isPropertyAccessExpression(root)) {
    propertyDepth += 1;
    root = unwrapTransparentExpression(root.expression);
  }
  return propertyDepth > 0 && ts.isIdentifier(root) && root.text === parameter.text;
}

export function membershipUsesCallbackKey(
  call: ts.CallExpression,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  const [argument] = call.arguments;
  const parameter = callback.parameters[0]?.name;
  if (!argument || !parameter) {
    return false;
  }
  return expressionDependsOnBinding(argument, parameter, callback);
}

export function renderedListCallback(
  node: ts.Node,
  owner: RuntimeFunctionLike,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const callback = nearestNestedFunction(node, owner);
  if (!callback) {
    return null;
  }
  const initializer = callback.parent;
  const declaration =
    ts.isCallExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === "useCallback"
      ? initializer.parent
      : callback.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) {
    return null;
  }
  // SAFETY: Reaching this branch requires a variable declaration initialized
  // It is initialized directly by this callback or by a useCallback call containing it.
  return bindingIsRenderItemAttribute(owner, declaration.name.text)
    ? (callback as ts.ArrowFunction | ts.FunctionExpression)
    : null;
}

function bindingIsRenderItemAttribute(owner: RuntimeFunctionLike, bindingName: string): boolean {
  let rendered = false;
  visit(owner.body, (current) => {
    if (
      ts.isIdentifier(current) &&
      current.text === bindingName &&
      isListRenderAttributeReference(current)
    ) {
      rendered = true;
    }
  });
  return rendered;
}

function isListRenderAttributeReference(node: ts.Identifier): boolean {
  const expression = node.parent;
  if (!ts.isJsxExpression(expression) || expression.expression !== node) {
    return false;
  }
  const attribute = expression.parent;
  return ts.isJsxAttribute(attribute) && attribute.name.getText() === "renderItem";
}

export function membershipControlsRepeatedMount(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): boolean {
  const repeated = nearestRepeatedRenderCall(call, owner);
  const callback = repeated?.arguments[0] ?? renderedListCallback(call, owner);
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return true;
  }
  const declaration = findAncestorUntil(call, ts.isVariableDeclaration, callback);
  return declaration &&
    ts.isIdentifier(declaration.name) &&
    declaration.initializer &&
    nodeWithin(call, declaration.initializer)
    ? aliasedMembershipGatesMount(declaration.name, callback)
    : isMembershipMountGate(call, callback);
}

function aliasedMembershipGatesMount(
  declarationName: ts.Identifier,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  const aliasName = declarationName.text;
  const references: ts.Identifier[] = [];
  visitSkippingNestedFunctions(callback.body, callback, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === aliasName &&
      node !== declarationName &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return (
    references.length > 0 &&
    references.every((reference) => isMembershipMountGate(reference, callback))
  );
}

export function isMembershipMountGate(node: ts.Node, callback: RuntimeFunctionLike): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== callback;
    current = current.parent
  ) {
    if (
      (ts.isIfStatement(current) &&
        nodeWithin(node, current.expression) &&
        statementContainsReturn(current.thenStatement)) ||
      (ts.isConditionalExpression(current) &&
        nodeWithin(node, current.condition) &&
        !findAncestorUntil(current, ts.isJsxAttribute, callback) &&
        (expressionIsNullish(current.whenTrue) || expressionIsNullish(current.whenFalse))) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
        nodeWithin(node, current.left) &&
        expressionContainsJsx(current.right))
    ) {
      return true;
    }
  }
  return false;
}

function statementContainsReturn(statement: ts.Statement): boolean {
  let found = false;
  visitSkippingNestedRuntimeFunctions(statement, (node) => {
    if (ts.isReturnStatement(node)) {
      found = true;
    }
  });
  return found;
}

function expressionIsNullish(expression: ts.Expression): boolean {
  return (
    expression.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expression) && expression.text === "undefined")
  );
}

function memoizedCallbackName(declaration: ts.Node): string | null {
  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
    return declaration.name.text;
  }
  return ts.isCallExpression(declaration) &&
    ts.isVariableDeclaration(declaration.parent) &&
    ts.isIdentifier(declaration.parent.name)
    ? declaration.parent.name.text
    : null;
}
