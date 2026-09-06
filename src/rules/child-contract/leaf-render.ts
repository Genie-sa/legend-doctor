import {
  bindingDeclarationCount,
  isAssignmentOperator,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import {
  findAncestor,
  findAncestorUntil,
  isRuntimeFunctionLike,
  nodeWithin,
  visit,
} from "../../core/ast.js";
import { isBindingName, referenceIsWritten } from "./prop-bindings.js";
import type { ChildComponentSource } from "./model.js";
import type { HostTagImports } from "../../core/imports.js";
import { MAX_TRACKED_NAMES } from "./model.js";
import { isHostTag } from "../../core/imports.js";
import ts from "typescript";

type LeafRenderVerdict = "ignored" | "render-read" | "unsafe";

/**
 * Decides whether a prop handed to a custom component in the child's JSX still ends in host output:
 * the receiving component must itself be a proven leaf render consumer of that attribute.
 */
export type ForwardedPropProof = (
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  propName: string,
) => boolean;

/**
 * Tags the child's own module imports from the host-component package (React Native primitives such
 * as `View` and `Text`) render host output even though they are capitalized.
 */
export interface LeafRenderProof {
  readonly forwarded: ForwardedPropProof | null;
  readonly hostTags: HostTagImports;
}

export interface LeafRenderScope extends LeafRenderProof {
  readonly tracked: Set<string>;
}

export function leafRenderVerdict(
  node: ts.Identifier,
  source: ChildComponentSource,
  scope: LeafRenderScope,
): LeafRenderVerdict {
  if (isNonValueIdentifier(node) || isBindingName(node)) {
    return "ignored";
  }
  if (findAncestor(node, isRuntimeFunctionLike) !== source.owner || referenceIsWritten(node)) {
    return "unsafe";
  }
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, source.owner);
  if (attribute) {
    return attributeVerdict(node, attribute, scope);
  }
  if (findAncestorUntil(node, isJsxNode, source.owner)) {
    return "render-read";
  }
  return tracksPureProjection(node, source.owner, scope.tracked) ? "ignored" : "unsafe";
}

function attributeVerdict(
  node: ts.Identifier,
  attribute: ts.JsxAttribute,
  { forwarded, hostTags }: LeafRenderProof,
): LeafRenderVerdict {
  const opening = jsxOpeningOf(attribute);
  if (!opening) {
    return "unsafe";
  }
  if (!isCustomJsxTag(opening, hostTags)) {
    return "render-read";
  }
  const direct =
    attribute.initializer !== undefined &&
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression === node;
  return direct && forwarded?.(opening, attribute.name.getText()) ? "render-read" : "unsafe";
}

/**
 * Classifies one JSX spread of the child's rest props: a host element receives the prop as an
 * attribute, and a custom component receives it only when that component leaf-renders the same prop.
 */
export function spreadVerdict(
  spread: ts.JsxSpreadAttribute,
  propName: string,
  { forwarded, hostTags }: LeafRenderProof,
): LeafRenderVerdict {
  const opening = jsxOpeningOf(spread);
  if (!opening) {
    return "unsafe";
  }
  if (!isCustomJsxTag(opening, hostTags)) {
    return "render-read";
  }
  return forwarded?.(opening, propName) ? "render-read" : "unsafe";
}

function jsxOpeningOf(
  attribute: ts.JsxAttribute | ts.JsxSpreadAttribute,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const container: ts.Node = attribute.parent;
  const element = ts.isJsxAttributes(container) ? container.parent : container;
  return ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element) ? element : null;
}

function isCustomJsxTag(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  hostTags: HostTagImports,
): boolean {
  return !isHostTag(element.tagName.getText(), hostTags);
}

function isJsxNode(
  node: ts.Node,
): node is ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment | ts.JsxExpression {
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
  tracked: Set<string>,
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
  visit(declaration.initializer, (current) => {
    if (!pure) {
      return;
    }
    if (
      ts.isCallExpression(current) ||
      ts.isNewExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isYieldExpression(current) ||
      ts.isSpreadElement(current) ||
      (ts.isBinaryExpression(current) && isAssignmentOperator(current.operatorToken.kind))
    ) {
      pure = false;
      return;
    }
    if (ts.isIdentifier(current) && tracked.has(current.text)) {
      depth += 1;
    }
  });
  if (!pure || depth === 0) {
    return false;
  }
  tracked.add(declaration.name.text);
  return true;
}
