import { bindingDeclarationCount, outermostTransparentParent } from "../../core/analysis-ast.js";
import type { RenderFunction } from "../observable-tracking/render-owners.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import { ownerLevelReferences } from "../../core/scope-references.js";
import ts from "typescript";

/**
 * How a read consumes the raw value: `test` keeps only its truthiness; `falsy-render` hands a
 * falsy value to JSX, which renders `0`, `NaN`, and `""` but nothing for `false`, `null`, or
 * `undefined`, while a truthy value never escapes.
 */
export type TruthinessUse = "falsy-render" | "test";

export interface TruthinessSite {
  /** The node the boolean binding replaces: the whole `!!raw` or `Boolean(raw)`, else the reference. */
  readonly replaced: ts.Expression;
  readonly use: TruthinessUse;
}

/** How the value of an expression escapes: rendered as a JSX child, or used as a value elsewhere. */
export type PositionUse = TruthinessUse | "render" | "value";

export const LOGICAL_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
]);

/** Every owner read of `raw` depends on it only through its truthiness. */
export function truthinessSites(
  owner: RenderFunction,
  raw: ts.Identifier,
): readonly [TruthinessSite, ...TruthinessSite[]] | null {
  if (bindingDeclarationCount(owner, raw.text) !== 1) {
    return null;
  }
  const sites: TruthinessSite[] = [];
  for (const reference of ownerLevelReferences(owner, raw)) {
    const use = positionUse(reference);
    if (use !== "test" && use !== "falsy-render") {
      return null;
    }
    sites.push({ replaced: coercion(reference) ?? reference, use });
  }
  const [first, ...rest] = sites;
  return first ? [first, ...rest] : null;
}

export function positionUse(expression: ts.Expression): PositionUse {
  const outer = outermostTransparentParent(expression);
  const { parent } = outer;
  if (isTestPosition(parent, outer)) {
    return "test";
  }
  if (ts.isBinaryExpression(parent) && LOGICAL_OPERATORS.has(parent.operatorToken.kind)) {
    return logicalOperandUse(parent, outer);
  }
  return ts.isJsxExpression(parent) &&
    (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent))
    ? "render"
    : "value";
}

function isTestPosition(parent: ts.Node, child: ts.Expression): boolean {
  return (
    isNegation(parent) ||
    isBooleanCall(parent, child) ||
    ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
      parent.expression === child) ||
    (ts.isForStatement(parent) && parent.condition === child) ||
    (ts.isConditionalExpression(parent) && parent.condition === child)
  );
}

/**
 * `a && b` yields `a` only when it is falsy and `a || b` only when it is truthy; either yields `b`
 * otherwise. A test of the whole tests each operand, and a whole that escapes only when falsy lets
 * `b` escape only when falsy too.
 */
function logicalOperandUse(binary: ts.BinaryExpression, operand: ts.Expression): PositionUse {
  const whole = positionUse(binary);
  if (whole === "test") {
    return "test";
  }
  if (binary.right === operand) {
    return whole === "falsy-render" ? "falsy-render" : "value";
  }
  if (binary.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return whole === "render" || whole === "falsy-render" ? "falsy-render" : "value";
  }
  return whole === "falsy-render" ? "test" : "value";
}

function isBooleanCall(parent: ts.Node, child: ts.Expression): parent is ts.CallExpression {
  return (
    ts.isCallExpression(parent) &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === "Boolean" &&
    lexicalBinding(parent.expression) === null &&
    parent.arguments.length === 1 &&
    parent.arguments[0] === child
  );
}

/** `!!raw` or `Boolean(raw)`, which the boolean binding replaces whole. */
function coercion(reference: ts.Identifier): ts.Expression | null {
  const outer = outermostTransparentParent(reference);
  const { parent } = outer;
  if (isBooleanCall(parent, outer)) {
    return parent;
  }
  const outerNegation = isNegation(parent) ? outermostTransparentParent(parent).parent : null;
  return outerNegation && isNegation(outerNegation) ? outerNegation : null;
}

export function isNegation(node: ts.Node): node is ts.PrefixUnaryExpression {
  return ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken;
}
