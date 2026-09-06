import {
  isSafeJsxProjectionReference,
  nearestRepeatedRenderCall,
} from "../state-proofs/jsx-subtrees.js";
import type { KeyedRecordEntry } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import { isMembershipMountGate } from "./rendered-list-membership.js";
import { nearestNestedFunction } from "../../core/ast.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

export function renderedRecordEntry(
  state: StateCandidate,
  nodes: readonly ts.Node[],
): KeyedRecordEntry | null {
  let result: KeyedRecordEntry | null = null;
  for (const node of nodes) {
    const entry = renderedRecordEntryForNode(node, state);
    if (
      !entry ||
      (result && (result.repeated !== entry.repeated || !accessPathsEqual(result.path, entry.path)))
    ) {
      return null;
    }
    result = entry;
  }
  return result;
}

function renderedRecordEntryForNode(node: ts.Node, state: StateCandidate): KeyedRecordEntry | null {
  if (!ts.isIdentifier(node)) {
    return null;
  }
  const access = node.parent;
  if (
    !ts.isElementAccessExpression(access) ||
    access.expression !== node ||
    !access.argumentExpression
  ) {
    return null;
  }
  const render = repeatedRecordRender(node, access, state.owner);
  const path = render && accessPathFromBinding(access.argumentExpression, render.itemName);
  if (
    !render ||
    !path ||
    path.length === 0 ||
    !hasMatchingKeyedAncestor(access, render.callback, path) ||
    isMembershipMountGate(access, render.callback) ||
    !isSafeJsxProjectionReference(node, render.callback, new Set(["cn"]))
  ) {
    return null;
  }
  return { path, repeated: render.repeated };
}

interface RepeatedRecordRender {
  callback: ts.ArrowFunction | ts.FunctionExpression;
  itemName: string;
  repeated: ts.CallExpression;
}

function repeatedRecordRender(
  node: ts.Identifier,
  access: ts.ElementAccessExpression,
  owner: RuntimeFunctionLike,
): RepeatedRecordRender | null {
  const repeated = nearestRepeatedRenderCall(access, owner);
  const callback = repeated?.arguments[0];
  if (
    !repeated ||
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    nearestNestedFunction(node, owner) !== callback ||
    !callback.parameters[0] ||
    !ts.isIdentifier(callback.parameters[0]!.name)
  ) {
    return null;
  }
  return { callback, itemName: callback.parameters[0]!.name.text, repeated };
}

function hasMatchingKeyedAncestor(
  node: ts.Node,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  path: readonly string[],
): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== callback;
    current = current.parent
  ) {
    const opening = jsxOpeningOf(current);
    const expression = opening && jsxKeyExpression(opening);
    const item = callback.parameters[0]?.name;
    if (
      expression &&
      item &&
      ts.isIdentifier(item) &&
      accessPathsEqual(accessPathFromBinding(expression, item.text), path)
    ) {
      return true;
    }
  }
  return false;
}

function jsxKeyExpression(opening: ts.JsxOpeningLikeElement): ts.Expression | null {
  const key = opening.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === "key",
  );
  const initializer = key && ts.isJsxAttribute(key) ? key.initializer : null;
  return initializer && ts.isJsxExpression(initializer) ? (initializer.expression ?? null) : null;
}

export function accessPathFromBinding(
  expression: ts.Expression,
  binding: string,
): readonly string[] | null {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return value.text === binding ? [] : null;
  }
  const segment = accessPathSegment(value);
  if (!segment) {
    return null;
  }
  const parent = accessPathFromBinding(segment.target, binding);
  return parent ? [...parent, segment.part] : null;
}

interface AccessPathSegment {
  part: string;
  target: ts.Expression;
}

function accessPathSegment(value: ts.Expression): AccessPathSegment | null {
  if (ts.isPropertyAccessExpression(value)) {
    return { part: `.${value.name.text}`, target: value.expression };
  }
  if (!ts.isElementAccessExpression(value) || !value.argumentExpression) {
    return null;
  }
  const key = unwrapTransparentExpression(value.argumentExpression);
  if (ts.isStringLiteralLike(key)) {
    return { part: `[s:${key.text}]`, target: value.expression };
  }
  return ts.isNumericLiteral(key) ? { part: `[n:${key.text}]`, target: value.expression } : null;
}

export function accessPathsEqual(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  );
}

function jsxOpeningOf(node: ts.Node): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  if (ts.isJsxElement(node)) {
    return node.openingElement;
  }
  return ts.isJsxSelfClosingElement(node) ? node : null;
}
