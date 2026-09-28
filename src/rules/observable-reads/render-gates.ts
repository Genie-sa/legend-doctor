import { findAncestorUntil, nodeWithin } from "../../core/ast.js";
import {
  hasRenderOwnedConditionalInputs,
  isConditionalRenderExpression,
} from "./conditional-jsx-slots.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

export interface RenderGateScope {
  readonly owner: RuntimeFunctionLike;
  readonly imports: HookImports;
  readonly observableValue: string;
}

/**
 * A render gate selects what the owner renders: a conditional JSX child slot, a conditional returned
 * output, or an early `return` of JSX or `null`. Its condition runs on every render and decides which
 * elements mount, so a read there is a render read. The read must sit in the selecting expression rather
 * than inside a selected element, and every input must be render-owned with no call or write, which is
 * the same proof a conditional slot cut relies on.
 */
export function isRenderGateRead(node: ts.Identifier, scope: RenderGateScope): boolean {
  const gate = renderGateExpression(node, scope.owner);
  return (
    gate !== null &&
    !isInsideJsxElement(node, gate) &&
    hasRenderOwnedConditionalInputs(gate, { ...scope, resolving: new Set() })
  );
}

function renderGateExpression(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
): ts.Expression | null {
  const slot = findAncestorUntil(node, ts.isJsxExpression, owner);
  if (slot) {
    return slot.expression && isChildSlot(slot) && isConditionalRender(slot.expression)
      ? slot.expression
      : null;
  }
  const output = ownerOutputExpression(node, owner);
  if (output) {
    return isConditionalRender(output) && selectsJsxOutput(output) ? output : null;
  }
  const guard = findAncestorUntil(node, ts.isIfStatement, owner);
  return guard && nodeWithin(node, guard.expression) && isEarlyReturnGuard(guard, owner)
    ? guard.expression
    : null;
}

function isChildSlot(slot: ts.JsxExpression): boolean {
  return ts.isJsxElement(slot.parent) || ts.isJsxFragment(slot.parent);
}

function isConditionalRender(expression: ts.Expression): boolean {
  return isConditionalRenderExpression(unwrapTransparentExpression(expression));
}

/** The returned expression that holds `node`, when `node` is not inside a nested statement. */
function ownerOutputExpression(node: ts.Node, owner: RuntimeFunctionLike): ts.Expression | null {
  const { body } = owner;
  if (!body) {
    return null;
  }
  if (!ts.isBlock(body)) {
    return body;
  }
  const statement = findAncestorUntil(node, ts.isReturnStatement, owner);
  return statement?.parent === body && statement.expression ? statement.expression : null;
}

function isEarlyReturnGuard(guard: ts.IfStatement, owner: RuntimeFunctionLike): boolean {
  const { body } = owner;
  if (!body || !ts.isBlock(body) || guard.parent !== body || guard.elseStatement) {
    return false;
  }
  const output = returnedExpression(guard.thenStatement);
  const last = body.statements.at(-1);
  return (
    output !== null &&
    isJsxOutput(output) &&
    last !== undefined &&
    ts.isReturnStatement(last) &&
    last.expression !== undefined &&
    selectsJsxOutput(last.expression)
  );
}

function returnedExpression(statement: ts.Statement): ts.Expression | null {
  const [sole] = ts.isBlock(statement) ? statement.statements : [statement];
  const only = !ts.isBlock(statement) || statement.statements.length === 1;
  return only && sole && ts.isReturnStatement(sole) && sole.expression ? sole.expression : null;
}

function isJsxOutput(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  return value.kind === ts.SyntaxKind.NullKeyword || isJsxNode(value);
}

/** Every value the expression can produce is an element or `null`, apart from logical conditions. */
function selectsJsxOutput(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isConditionalExpression(value)) {
    return selectsJsxOutput(value.whenTrue) && selectsJsxOutput(value.whenFalse);
  }
  if (ts.isBinaryExpression(value) && isConditionalRenderExpression(value)) {
    return selectsJsxOutput(value.right);
  }
  return isJsxOutput(value);
}

function isInsideJsxElement(node: ts.Node, gate: ts.Node): boolean {
  for (let current: ts.Node = node; current !== gate; current = current.parent) {
    if (isJsxNode(current)) {
      return true;
    }
  }
  return false;
}

function isJsxNode(node: ts.Node): boolean {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
}
