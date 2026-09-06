import {
  directJsxSubtree,
  expressionContainsJsx,
  jsxSubtreeAncestors,
  localJsxFactoryReturn,
  uniqueConstJsxInitializer,
} from "./jsx-subtrees.js";
import { nodeWithin, visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";
import type { JsxSubtreeNode } from "./jsx-subtrees.js";
import { isSafeProjectionExpression } from "./safe-projections.js";
import ts from "typescript";

export function isRenderGateReference(node: ts.Node, boundary: ts.Node): boolean {
  for (
    let current: ts.Node | undefined = node;
    current && current !== boundary;
    current = current.parent
  ) {
    if (ts.isConditionalExpression(current) && nodeWithin(node, current.condition)) {
      return true;
    }
    if (
      ts.isIfStatement(current) &&
      nodeWithin(node, current.expression) &&
      statementContainsRenderableReturn(current.thenStatement, boundary)
    ) {
      return true;
    }
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      nodeWithin(node, current.left) &&
      (expressionContainsJsx(current.right) ||
        localJsxFactoryReturn(current.right, boundary) !== null)
    ) {
      return true;
    }
  }
  return false;
}

export function commonRenderGateSubtree(
  nodes: readonly ts.Node[],
  boundary: ts.Node,
): JsxSubtreeNode | null {
  const subtrees = nodes.map((node) => renderGateSubtree(node, boundary));
  const [first] = subtrees;
  return first && subtrees.every((subtree) => subtree === first) ? first : null;
}

function renderGateSubtree(node: ts.Node, boundary: ts.Node): JsxSubtreeNode | null {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (
      ts.isConditionalExpression(current) &&
      nodeWithin(node, current.condition) &&
      isSafeProjectionExpression({ expression: current.condition, reference: node })
    ) {
      return jsxSubtreeAncestors(current, boundary)[0] ?? null;
    }
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      nodeWithin(node, current.left) &&
      isSafeProjectionExpression({ expression: current.left, reference: node })
    ) {
      const subtree = directJsxSubtree(current.right, boundary);
      if (subtree) {
        return subtree;
      }
    }
  }
  return null;
}

function statementContainsRenderableReturn(statement: ts.Statement, boundary: ts.Node): boolean {
  let found = false;
  visitSkippingNestedRuntimeFunctions(statement, (node) => {
    if (
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      (expressionContainsJsx(node.expression) ||
        (ts.isIdentifier(node.expression) &&
          uniqueConstJsxInitializer(boundary, node.expression.text) !== null))
    ) {
      found = true;
    }
  });
  return found;
}
