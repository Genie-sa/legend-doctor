import ts from "typescript";

export function isSynchronousRenderCallback(node: ts.FunctionLikeDeclaration): boolean {
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && isImmediatelyInvoked(node)) {
    return true;
  }
  const { parent } = node;
  if (!ts.isCallExpression(parent)) {
    return false;
  }
  if (ts.isIdentifier(parent.expression) && parent.expression.text === "useMemo") {
    return true;
  }
  return (
    ts.isPropertyAccessExpression(parent.expression) &&
    [
      "every",
      "filter",
      "find",
      "findIndex",
      "flatMap",
      "map",
      "reduce",
      "reduceRight",
      "some",
    ].includes(parent.expression.name.text)
  );
}

/** The function is the callee of its own call, seen through transparent wrapper expressions. */
function isImmediatelyInvoked(node: ts.ArrowFunction | ts.FunctionExpression): boolean {
  let expression: ts.Expression = node;
  while (
    (ts.isParenthesizedExpression(expression.parent) ||
      ts.isAsExpression(expression.parent) ||
      ts.isTypeAssertionExpression(expression.parent) ||
      ts.isSatisfiesExpression(expression.parent) ||
      ts.isNonNullExpression(expression.parent)) &&
    expression.parent.expression === expression
  ) {
    expression = expression.parent;
  }
  return ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
}

export function isJsxNode(
  node: ts.Node,
): node is
  | ts.JsxElement
  | ts.JsxSelfClosingElement
  | ts.JsxExpression
  | ts.JsxAttribute
  | ts.JsxFragment {
  return (
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxExpression(node) ||
    ts.isJsxAttribute(node) ||
    ts.isJsxFragment(node)
  );
}

export function isHookDependencyReference(
  node: ts.Identifier,
  hookNames: ReadonlySet<string>,
  namespaces?: ReadonlySet<string>,
): boolean {
  const array = node.parent;
  if (!ts.isArrayLiteralExpression(array) || !array.elements.includes(node)) {
    return false;
  }
  const call = array.parent;
  if (!ts.isCallExpression(call) || call.arguments[1] !== array) {
    return false;
  }
  if (ts.isIdentifier(call.expression)) {
    return hookNames.has(call.expression.text);
  }
  return (
    namespaces !== undefined &&
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    namespaces.has(call.expression.expression.text) &&
    hookNames.has(call.expression.name.text)
  );
}
