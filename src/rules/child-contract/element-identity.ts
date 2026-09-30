import { findAncestor, isRuntimeFunctionLike } from "../../core/ast.js";
import type { ComponentSourceResolver } from "./model.js";
import type { HostTagImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isHostTag } from "../../core/imports.js";
import ts from "typescript";

/** The React APIs and element field through which a component can observe its children's types. */
const CHILD_INSPECTION = /\b(?:Children|cloneElement|isValidElement)\b|\.type\b/u;

/** React Native's Android `ScrollView` clones this element to inject `style` and its `children`. */
const CLONED_ELEMENT_PROP = "refreshControl";

export interface ElementIdentityScope {
  readonly hostTags: HostTagImports;
  readonly owner: RuntimeFunctionLike;
  readonly resolveComponent: ComponentSourceResolver;
}

/**
 * Proves that replacing the element at `node` with one of another type (a `Computed` block, a
 * reactive host wrapper, or a leaf subscriber) is invisible to the parent element that receives it.
 * A parent observes its children's types through `Children`, `cloneElement`, `isValidElement`, or
 * `child.type`, as `Stack.Toolbar` does when it keeps only its own button children. The receiving
 * parent must be a host element, or a component resolved from source that uses none of them.
 * Third-party and unresolved parents abstain, and so does any path to the parent other than
 * conditional branches, logical operands, and fragments.
 */
export function replacedElementTypeIsUnobserved(
  node: ts.Node,
  scope: ElementIdentityScope,
): boolean {
  const parent = receivingElement(replacedElement(node), scope.owner);
  if (parent === undefined) {
    return false;
  }
  if (parent === null) {
    return true;
  }
  const tag = parent.openingElement.tagName.getText();
  if (isHostTag(tag, scope.hostTags)) {
    return true;
  }
  const body = scope.resolveComponent(tag)?.owner.body;
  return body !== undefined && !CHILD_INSPECTION.test(body.getText());
}

/**
 * Whether the element that renders `node` is passed as a scroll view's `refreshControl`. A leaf
 * that replaces it must forward the props the scroll view injects, or the list disappears.
 */
export function renderedByClonedPropElement(node: ts.Node): boolean {
  let current: ts.Node | null = findAncestor(node, isJsxElementLike);
  while (current && passesElementThrough(current.parent, current)) {
    current = current.parent;
  }
  return (
    current !== null &&
    ts.isJsxAttribute(current.parent) &&
    current.parent.name.getText() === CLONED_ELEMENT_PROP
  );
}

function isJsxElementLike(node: ts.Node): node is ts.JsxElement | ts.JsxSelfClosingElement {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

function replacedElement(node: ts.Node): ts.Node {
  if (ts.isJsxAttribute(node)) {
    return replacedElement(node.parent.parent);
  }
  return ts.isJsxOpeningElement(node) ? node.parent : node;
}

/** The element whose children include `node`, `null` for the owner's output, or `undefined`. */
function receivingElement(
  node: ts.Node,
  owner: RuntimeFunctionLike,
): ts.JsxElement | null | undefined {
  let current = node;
  for (;;) {
    const { parent } = current;
    if (ts.isJsxElement(parent)) {
      return parent;
    }
    if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === current)) {
      return findAncestor(current, isRuntimeFunctionLike) === owner ? null : undefined;
    }
    if (!passesElementThrough(parent, current)) {
      return undefined;
    }
    current = parent;
  }
}

function passesElementThrough(parent: ts.Node, child: ts.Node): boolean {
  if (ts.isConditionalExpression(parent)) {
    return parent.condition !== child;
  }
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    return (
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      (operator === ts.SyntaxKind.AmpersandAmpersandToken && parent.right === child)
    );
  }
  return (
    ts.isParenthesizedExpression(parent) || ts.isJsxExpression(parent) || ts.isJsxFragment(parent)
  );
}
