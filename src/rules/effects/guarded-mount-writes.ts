import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

/** A folded constant; numbers are tagged because only they order under `<` and `>`. */
type Constant =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "other"; readonly value: boolean | string | null };

interface DiscriminantPins {
  readonly literals: readonly Constant[];
  readonly subject: string;
}

interface Substitution {
  readonly literal: Constant;
  readonly subject: string;
}

const KEYWORD_CONSTANTS: ReadonlyMap<ts.SyntaxKind, Constant> = new Map([
  [ts.SyntaxKind.TrueKeyword, { kind: "other", value: true }],
  [ts.SyntaxKind.FalseKeyword, { kind: "other", value: false }],
  [ts.SyntaxKind.NullKeyword, { kind: "other", value: null }],
]);

const NUMBER_ORDERINGS: ReadonlyMap<ts.SyntaxKind, (left: number, right: number) => boolean> =
  new Map([
    [ts.SyntaxKind.GreaterThanToken, (left, right) => left > right],
    [ts.SyntaxKind.GreaterThanEqualsToken, (left, right) => left >= right],
    [ts.SyntaxKind.LessThanToken, (left, right) => left < right],
    [ts.SyntaxKind.LessThanEqualsToken, (left, right) => left <= right],
  ]);

const PRINTER = ts.createPrinter({ removeComments: true });

/** Source tokens without their layout, so an equal expression at another indentation compares equal. */
export function printedExpression(node: ts.Expression): string {
  return PRINTER.printNode(ts.EmitHint.Expression, node, node.getSourceFile());
}

/**
 * Whether a guard of the form `x === "a" || x === "b"` pins `x` to literals under each of which
 * the written value and the state's initializer fold to the same constant. The mount run of the
 * guarded write then stores the value the state already holds, so the first commit is unchanged.
 */
export function guardPinsInitialValue(
  guard: ts.Expression,
  value: ts.Expression,
  initial: ts.Expression,
): boolean {
  const pins = discriminantPins(guard);
  return (
    pins !== null &&
    pins.literals.every((literal) => {
      const substitution = { literal, subject: pins.subject };
      const written = fold(value, substitution, true);
      const initialValue = fold(initial, substitution, true);
      return written !== null && initialValue !== null && written.value === initialValue.value;
    })
  );
}

function discriminantPins(guard: ts.Expression): DiscriminantPins | null {
  const node = unwrapTransparentExpression(guard);
  if (!ts.isBinaryExpression(node)) {
    return null;
  }
  if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return disjunctionPins(node);
  }
  return node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    ? equalityPins(node)
    : null;
}

function disjunctionPins(node: ts.BinaryExpression): DiscriminantPins | null {
  const left = discriminantPins(node.left);
  const right = discriminantPins(node.right);
  return left && right && left.subject === right.subject
    ? { literals: [...left.literals, ...right.literals], subject: left.subject }
    : null;
}

function equalityPins(node: ts.BinaryExpression): DiscriminantPins | null {
  const leftLiteral = literalConstant(node.left);
  const rightLiteral = literalConstant(node.right);
  if (leftLiteral && !rightLiteral) {
    return { literals: [leftLiteral], subject: printedExpression(node.right) };
  }
  return rightLiteral && !leftLiteral
    ? { literals: [rightLiteral], subject: printedExpression(node.left) }
    : null;
}

function literalConstant(expression: ts.Expression): Constant | null {
  const node = unwrapTransparentExpression(expression);
  if (ts.isStringLiteralLike(node)) {
    return { kind: "other", value: node.text };
  }
  if (ts.isNumericLiteral(node)) {
    return { kind: "number", value: Number(node.text) };
  }
  return KEYWORD_CONSTANTS.get(node.kind) ?? null;
}

/**
 * The constant an expression evaluates to once the pinned subject is replaced by its literal. A
 * subject pinned by `=== 0` may be `-0`, which React's `Object.is` tells apart from `0`, so it
 * folds only where it is compared or tested rather than stored.
 */
function fold(
  expression: ts.Expression,
  substitution: Substitution,
  stored: boolean,
): Constant | null {
  const node = unwrapTransparentExpression(expression);
  if (printedExpression(node) === substitution.subject) {
    return stored && substitution.literal.value === 0 ? null : substitution.literal;
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = fold(node.operand, substitution, false);
    return operand && { kind: "other", value: !operand.value };
  }
  return foldOperation(node, substitution, stored);
}

function foldOperation(
  node: ts.Expression,
  substitution: Substitution,
  stored: boolean,
): Constant | null {
  if (ts.isConditionalExpression(node)) {
    const condition = fold(node.condition, substitution, false);
    return (
      condition && fold(condition.value ? node.whenTrue : node.whenFalse, substitution, stored)
    );
  }
  return ts.isBinaryExpression(node)
    ? foldBinary(node, substitution, stored)
    : literalConstant(node);
}

function foldBinary(
  node: ts.BinaryExpression,
  substitution: Substitution,
  stored: boolean,
): Constant | null {
  const operator = node.operatorToken.kind;
  if (
    operator === ts.SyntaxKind.AmpersandAmpersandToken ||
    operator === ts.SyntaxKind.BarBarToken
  ) {
    const left = fold(node.left, substitution, stored);
    const shortCircuits =
      left !== null && Boolean(left.value) === (operator === ts.SyntaxKind.BarBarToken);
    return left === null || shortCircuits ? left : fold(node.right, substitution, stored);
  }
  const left = fold(node.left, substitution, false);
  const right = fold(node.right, substitution, false);
  return left && right && compare(operator, left, right);
}

function compare(operator: ts.SyntaxKind, left: Constant, right: Constant): Constant | null {
  if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken) {
    return { kind: "other", value: left.value === right.value };
  }
  if (operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
    return { kind: "other", value: left.value !== right.value };
  }
  const ordering = NUMBER_ORDERINGS.get(operator);
  return ordering && left.kind === "number" && right.kind === "number"
    ? { kind: "other", value: ordering(left.value, right.value) }
    : null;
}
