import ts from "typescript";

import {
  bindingDeclarationCount,
  isAssignmentOperator,
  isNonValueIdentifier,
} from "../analysis-ast.js";
import { findAncestor, findAncestorUntil, isRuntimeFunctionLike, nodeWithin, visit } from "../ast.js";

export interface ChildComponentSource {
  readonly body: ts.ConciseBody;
  readonly owner:
    | ts.ArrowFunction
    | ts.FunctionDeclaration
    | ts.FunctionExpression;
}

export interface ChildContractResolver {
  resolveComponent(name: string): ChildComponentSource | null;
}

const MAX_TRACKED_NAMES = 8;

/**
 * Proves that a child component consumes one prop as a pure render value:
 * every read lands in JSX output of host elements or in bounded pure
 * projections of such reads, and no read escapes into hooks, callbacks,
 * writes, forwarding, or other calls. Only then can the owner keep the
 * observable and the call site subscribe without changing behavior.
 */
export function propIsLeafRenderConsumer(
  source: ChildComponentSource,
  propName: string
): boolean {
  const bound = boundPropIdentifier(source.owner, propName);
  if (!bound || !source.owner.body) return false;
  if (bindingDeclarationCount(source.owner, bound.text) !== 1) return false;

  let safe = true;
  let renderReads = 0;
  const tracked = new Set([bound.text]);
  visit(source.owner.body, node => {
    if (!safe || !ts.isIdentifier(node) || !tracked.has(node.text)) return;
    if (isNonValueIdentifier(node)) return;
    if (isBindingName(node)) return;
    if (findAncestor(node, isRuntimeFunctionLike) !== source.owner) {
      safe = false;
      return;
    }
    if (referenceIsWritten(node)) {
      safe = false;
      return;
    }
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, source.owner);
    if (attribute) {
      if (isCustomJsxTag(attribute)) {
        safe = false;
        return;
      }
      renderReads += 1;
      return;
    }
    if (findAncestorUntil(node, isJsxNode, source.owner)) {
      renderReads += 1;
      return;
    }
    if (tracksPureProjection(node, source.owner, tracked)) return;
    safe = false;
  });
  return safe && renderReads > 0;
}

function boundPropIdentifier(
  owner: ChildComponentSource["owner"],
  propName: string
): ts.Identifier | null {
  const parameter = owner.parameters[0];
  if (!parameter || owner.parameters.length !== 1) return null;
  if (!ts.isObjectBindingPattern(parameter.name)) return null;
  for (const element of parameter.name.elements) {
    if (!ts.isBindingElement(element) || element.dotDotDotToken) continue;
    if (!ts.isIdentifier(element.name) || element.initializer) continue;
    const source =
      element.propertyName && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : element.name.text;
    if (source === propName) return element.name;
  }
  return null;
}

function isBindingName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ts.isBindingElement(parent) ||
    ts.isVariableDeclaration(parent) ||
    (ts.isParameter(parent) && parent.name === node)
  );
}

function referenceIsWritten(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === node &&
      isAssignmentOperator(parent.operatorToken.kind)) ||
    (ts.isPrefixUnaryExpression(parent) && parent.operand === node) ||
    (ts.isPostfixUnaryExpression(parent) && parent.operand === node) ||
    (ts.isDeleteExpression(parent) && parent.expression === node)
  );
}

function isCustomJsxTag(attribute: ts.JsxAttribute): boolean {
  const container: ts.Node = attribute.parent;
  const element = ts.isJsxAttributes(container) ? container.parent : container;
  if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) {
    return true;
  }
  const tag = element.tagName.getText();
  return /^[A-Z]/.test(tag) || tag.includes(".");
}

function isJsxNode(node: ts.Node): node is ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment | ts.JsxExpression {
  return (
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxFragment(node) ||
    ts.isJsxExpression(node)
  );
}

/**
 * Accepts one bounded chain of immutable pure projections
 * (`const label = open ? "Close" : "Open"`) whose expression contains no
 * calls, awaits, assignments, or spreads, and tracks the projected name so
 * its own later reads participate in the same proof.
 */
function tracksPureProjection(
  node: ts.Identifier,
  owner: ChildComponentSource["owner"],
  tracked: Set<string>
): boolean {
  const declaration = findAncestorUntil(node, ts.isVariableDeclaration, owner);
  if (
    !declaration ||
    !declaration.initializer ||
    !nodeWithin(node, declaration.initializer) ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, declaration.name.text) !== 1 ||
    tracked.size >= MAX_TRACKED_NAMES
  ) {
    return false;
  }
  let depth = 0;
  let pure = true;
  visit(declaration.initializer, current => {
    if (!pure) return;
    if (
      ts.isCallExpression(current) ||
      ts.isNewExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isYieldExpression(current) ||
      ts.isSpreadElement(current) ||
      ts.isBinaryExpression(current) && isAssignmentOperator(current.operatorToken.kind)
    ) {
      pure = false;
      return;
    }
    if (ts.isIdentifier(current) && tracked.has(current.text)) depth += 1;
  });
  if (!pure || depth === 0) return false;
  tracked.add(declaration.name.text);
  return true;
}
