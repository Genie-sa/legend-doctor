import {
  findAncestorUntil,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import type { JsxSubtreeNode } from "../deferred-reveal/jsx-subtrees.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isSafeProjectionExpression } from "../deferred-reveal/safe-projections.js";
import { jsxSubtreeAncestors } from "../deferred-reveal/jsx-subtrees.js";
import ts from "typescript";

export const EMPTY_BINDINGS: ReadonlySet<string> = new Set();

const jsxElementCounts = new WeakMap<ts.Node, number>();

export function isSafeJsxProjectionReference(
  node: ts.Node,
  boundary: ts.Node,
  allowedIdentifierCalls: ReadonlySet<string> = EMPTY_BINDINGS,
): boolean {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, boundary);
  if (attribute) {
    if (attribute.name.getText() === "key") {
      return false;
    }
    const { initializer } = attribute;
    return (
      initializer !== undefined &&
      ts.isJsxExpression(initializer) &&
      initializer.expression !== undefined &&
      isSafeProjectionExpression({
        expression: initializer.expression,
        reference: node,
        allowedIdentifierCalls,
      })
    );
  }
  const expression = findAncestorUntil(node, ts.isJsxExpression, boundary);
  return (
    expression !== null &&
    expression.expression !== undefined &&
    isSafeProjectionExpression({
      expression: expression.expression,
      reference: node,
      allowedIdentifierCalls,
    })
  );
}

export function nearestRepeatedRenderCall(
  node: ts.Node,
  boundary: ts.Node,
): ts.CallExpression | null {
  for (
    let current: ts.Node | undefined = node;
    current && current !== boundary;
    current = current.parent
  ) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ["map", "flatMap"].includes(current.expression.name.text)
    ) {
      return current;
    }
  }
  return null;
}

export function lowestCommonJsxSubtree(
  nodes: readonly ts.Node[],
  boundary: ts.Node,
): JsxSubtreeNode | null {
  const ancestorLists = nodes.map((node) => jsxSubtreeAncestors(node, boundary));
  const [first] = ancestorLists;
  if (!first || ancestorLists.some((ancestors) => ancestors.length === 0)) {
    return null;
  }
  return (
    first.find((candidate) => ancestorLists.every((ancestors) => ancestors.includes(candidate))) ??
    null
  );
}

export function jsxElementCountIn(node: ts.Node): number {
  const cached = jsxElementCounts.get(node);
  if (cached !== undefined) {
    return cached;
  }
  let count = 0;
  visit(node, (current) => {
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) {
      count += 1;
    }
  });
  jsxElementCounts.set(node, count);
  return count;
}

export function jsxElementCount(owner: RuntimeFunctionLike): number {
  return owner.body ? jsxElementCountIn(owner.body) : 0;
}

export function hasRepeatedJsxRenderWorkOutside(
  owner: RuntimeFunctionLike,
  excludedSubtree: ts.Node,
): boolean {
  if (!owner.body) {
    return false;
  }
  let repeated = false;
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (
      repeated ||
      !ts.isCallExpression(node) ||
      nodeWithin(node, excludedSubtree) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      !["map", "flatMap"].includes(node.expression.name.text) ||
      node.questionDotToken !== undefined ||
      node.expression.questionDotToken !== undefined ||
      isConditionallyEvaluated(node, owner)
    ) {
      return;
    }
    const [callback] = node.arguments;
    if (
      callback &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      jsxElementCountIn(callback.body) > 0
    ) {
      repeated = true;
    }
  });
  return repeated;
}

function isConditionallyEvaluated(node: ts.Node, boundary: ts.Node): boolean {
  for (let current = node.parent; current && current !== boundary; current = current.parent) {
    if (
      ts.isConditionalExpression(current) ||
      ts.isIfStatement(current) ||
      ts.isSwitchStatement(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current) ||
      ts.isTryStatement(current) ||
      ts.isCatchClause(current) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
    ) {
      return true;
    }
  }
  return false;
}

export function hasUnstableSubtreeLifetime(node: JsxSubtreeNode, boundary: ts.Node): boolean {
  let renderReturns = 0;
  visitSkippingNestedRuntimeFunctions(boundary, (current) => {
    if (ts.isReturnStatement(current) && current.expression) {
      renderReturns += 1;
    }
  });
  if (renderReturns > 1) {
    return true;
  }
  for (
    let current: ts.Node | undefined = node;
    current && current !== boundary;
    current = current.parent
  ) {
    if (
      (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) &&
      (ts.isJsxElement(current) ? current.openingElement : current).attributes.properties.some(
        (property) => ts.isJsxAttribute(property) && property.name.getText() === "key",
      )
    ) {
      return true;
    }
    if (
      ts.isConditionalExpression(current) ||
      ts.isIfStatement(current) ||
      ts.isSwitchStatement(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) ||
      (ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        ["map", "flatMap"].includes(current.expression.name.text))
    ) {
      return true;
    }
  }
  return false;
}
