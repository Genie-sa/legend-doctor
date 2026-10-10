import { EQUALITY_OPERATORS, isNullishLiteral, isRenderStableOperand } from "./projection-sites.js";
import { LOGICAL_OPERATORS, isNegation } from "./truthiness-sites.js";
import {
  NUMBER_RECEIVER,
  OBJECT_RECEIVER,
  STRING_RECEIVER,
  arrayOf,
  typeReceiver,
} from "../state-proofs/receiver-types.js";
import { admitsNullish, memberSource, sourceDomainValues } from "./value-domains.js";
import type { RawSubscription } from "./projection-subscriptions.js";
import type { Receiver } from "../state-proofs/receiver-types.js";
import type { ValueSource } from "./value-domains.js";
import { isReceiverReadCall } from "../state-proofs/builtin-read-calls.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

/** The raw subscription a condition reads, its references, and where its values are declared. */
export interface ConditionScope {
  readonly raw: RawSubscription;
  readonly references: ReadonlySet<ts.Identifier>;
  readonly source: ValueSource;
}

/** The value a derivation step reads: its declared source, or a proven primitive with none. */
interface DerivedValue {
  readonly primitive: boolean;
  readonly source: ValueSource | null;
}

export const RELATIONAL_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.LessThanToken,
]);

const LOOSE_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** The read-only built-in methods that return a boolean; the receiver's kind must read through them. */
const PREDICATE_METHODS: ReadonlySet<string> = new Set([
  "endsWith",
  "every",
  "has",
  "includes",
  "some",
  "startsWith",
]);

const COUNT_MEMBERS = {
  array: "length",
  map: "size",
  number: null,
  object: null,
  set: "size",
  string: "length",
} as const satisfies Record<Receiver["kind"], string | null>;

const PRIMITIVE: DerivedValue = { primitive: true, source: null };

/**
 * The condition evaluates without side effects from the raw value, literals, and operands fixed
 * for the render, and never throws where the render's own evaluation would not.
 */
export function isPureCondition(
  expression: ts.Expression,
  condition: ts.Expression,
  scope: ConditionScope,
): boolean {
  const node = unwrapTransparentExpression(expression);
  if (ts.isBinaryExpression(node)) {
    return isPureBinary(node, condition, scope);
  }
  if (isNegation(node)) {
    return isPureCondition(node.operand, condition, scope);
  }
  return containsReference(node, scope.references)
    ? derivedValue(node, condition, scope) !== null
    : isRenderStableOperand(node, scope.raw.owner.owner, scope.raw.statement);
}

/**
 * Loose equality is accepted only against `null` or `undefined`, and a relational side that reads
 * the raw value must be a primitive, so no comparison runs `valueOf`.
 */
function isPureBinary(
  binary: ts.BinaryExpression,
  condition: ts.Expression,
  scope: ConditionScope,
): boolean {
  const operator = binary.operatorToken.kind;
  const sides = [binary.left, binary.right];
  if (LOGICAL_OPERATORS.has(operator)) {
    return sides.every((side) => isPureCondition(side, condition, scope));
  }
  return (
    isComparison(operator) &&
    (!LOOSE_OPERATORS.has(operator) || sides.some((side) => isNullishLiteral(side))) &&
    sides.every(
      (side) =>
        isPureCondition(side, condition, scope) &&
        (!RELATIONAL_OPERATORS.has(operator) || isPrimitiveSide(side, condition, scope)),
    )
  );
}

function isPrimitiveSide(
  side: ts.Expression,
  condition: ts.Expression,
  scope: ConditionScope,
): boolean {
  if (!containsReference(side, scope.references)) {
    return true;
  }
  const value = derivedValue(side, condition, scope);
  const domain = value?.source ? sourceDomainValues(value.source) : null;
  return value !== null && (value.primitive || (domain !== null && !domain.objects));
}

/** The value a raw-rooted chain of data members, counts, and predicate calls reads. */
export function derivedValue(
  expression: ts.Expression,
  condition: ts.Expression,
  scope: ConditionScope,
): DerivedValue | null {
  const node = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(node)) {
    return scope.references.has(node) ? { primitive: false, source: scope.source } : null;
  }
  if (ts.isPropertyAccessExpression(node)) {
    return memberValue(node, condition, scope);
  }
  return ts.isCallExpression(node) && isPredicateCall(node, condition, scope) ? PRIMITIVE : null;
}

function memberValue(
  access: ts.PropertyAccessExpression,
  condition: ts.Expression,
  scope: ConditionScope,
): DerivedValue | null {
  const receiver = derivedValue(access.expression, condition, scope)?.source;
  if (!receiver || !readsSafely(access, receiver, condition)) {
    return null;
  }
  const kind = sourceReceiver(receiver)?.kind;
  if (kind !== undefined && COUNT_MEMBERS[kind] === access.name.text) {
    return PRIMITIVE;
  }
  const member = memberSource(receiver, access.name.text);
  return member ? { primitive: false, source: member } : null;
}

/**
 * A boolean read-only built-in on a raw-derived receiver of proven kind. Its one argument is a
 * render-stable operand, or a callback the built-in invokes that reads only its own parameters,
 * literals, and render-stable operands.
 */
function isPredicateCall(
  call: ts.CallExpression,
  condition: ts.Expression,
  scope: ConditionScope,
): boolean {
  const callee = unwrapTransparentExpression(call.expression);
  const [argument, ...extra] = call.arguments;
  if (!ts.isPropertyAccessExpression(callee) || !argument || extra.length > 0) {
    return false;
  }
  const source = derivedValue(callee.expression, condition, scope)?.source;
  const receiver = source ? sourceReceiver(source) : null;
  return (
    PREDICATE_METHODS.has(callee.name.text) &&
    source !== null &&
    source !== undefined &&
    receiver !== null &&
    readsSafely(callee, source, condition) &&
    isReceiverReadCall(call, receiver, {
      isPureCallback: (callback) => isPureCallback(callback, scope),
      isPureCallee: () => false,
    }) &&
    !containsReference(argument, scope.references) &&
    (ts.isArrowFunction(argument) ||
      isRenderStableOperand(argument, scope.raw.owner.owner, scope.raw.statement))
  );
}

/**
 * A member read on a value that may be `null` or `undefined` uses `?.`, or sits on the right of
 * an `&&` whose left side tests that same receiver, so the selector throws only where the render
 * would.
 */
function readsSafely(
  access: ts.PropertyAccessExpression,
  receiver: ValueSource,
  condition: ts.Expression,
): boolean {
  if (access.questionDotToken || !admitsNullish(receiver)) {
    return true;
  }
  const tested = unwrapTransparentExpression(access.expression).getText();
  for (let child: ts.Node = access; child !== condition && child.parent; child = child.parent) {
    const { parent } = child;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right === child &&
      presenceSubject(parent.left)?.getText() === tested
    ) {
      return true;
    }
  }
  return false;
}

/** The expression that `value`, `!!value`, `Boolean(value)`, or `value != null` tests. */
function presenceSubject(test: ts.Expression): ts.Expression | null {
  const node = unwrapTransparentExpression(test);
  if (isNegation(node)) {
    const inner = unwrapTransparentExpression(node.operand);
    return isNegation(inner) ? presenceSubject(inner.operand) : null;
  }
  if (ts.isCallExpression(node)) {
    return booleanCallSubject(node);
  }
  if (ts.isBinaryExpression(node)) {
    return node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken &&
      node.right.kind === ts.SyntaxKind.NullKeyword
      ? unwrapTransparentExpression(node.left)
      : null;
  }
  return unwrapTransparentExpression(node);
}

function booleanCallSubject(call: ts.CallExpression): ts.Expression | null {
  const [argument, ...extra] = call.arguments;
  const callee = call.expression;
  return ts.isIdentifier(callee) &&
    callee.text === "Boolean" &&
    lexicalBinding(callee) === null &&
    argument &&
    extra.length === 0
    ? presenceSubject(argument)
    : null;
}

/** An expression-bodied arrow with plain parameters, reading as `isPureCallbackBody` allows. */
function isPureCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  scope: ConditionScope,
): boolean {
  const parameters = new Set<string>();
  for (const parameter of callback.parameters) {
    if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken) {
      return false;
    }
    parameters.add(parameter.name.text);
  }
  return (
    ts.isArrowFunction(callback) &&
    !ts.isBlock(callback.body) &&
    isPureCallbackBody(callback.body, parameters, scope)
  );
}

/** Comparisons and logical operators over parameter member chains and render-stable operands. */
function isPureCallbackBody(
  expression: ts.Expression,
  parameters: ReadonlySet<string>,
  scope: ConditionScope,
): boolean {
  const node = unwrapTransparentExpression(expression);
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    return (
      (LOGICAL_OPERATORS.has(operator) ||
        (EQUALITY_OPERATORS.has(operator) &&
          (!LOOSE_OPERATORS.has(operator) ||
            isNullishLiteral(node.left) ||
            isNullishLiteral(node.right)))) &&
      isPureCallbackBody(node.left, parameters, scope) &&
      isPureCallbackBody(node.right, parameters, scope)
    );
  }
  if (isNegation(node)) {
    return isPureCallbackBody(node.operand, parameters, scope);
  }
  let root = node;
  while (ts.isPropertyAccessExpression(root)) {
    root = unwrapTransparentExpression(root.expression);
  }
  return ts.isIdentifier(root) && parameters.has(root.text)
    ? true
    : !containsReference(node, scope.references) &&
        isRenderStableOperand(node, scope.raw.owner.owner, scope.raw.statement);
}

/** The built-in kind of a value, from its declared type or its widened seed. */
function sourceReceiver(source: ValueSource): Receiver | null {
  if (source.kind === "type") {
    return typeReceiver(source.type);
  }
  const seed = unwrapTransparentExpression(source.seed);
  if (ts.isArrayLiteralExpression(seed)) {
    return arrayOf(null);
  }
  if (ts.isStringLiteralLike(seed)) {
    return STRING_RECEIVER;
  }
  if (ts.isNumericLiteral(seed)) {
    return NUMBER_RECEIVER;
  }
  return ts.isObjectLiteralExpression(seed) ? OBJECT_RECEIVER : null;
}

export function isComparison(operator: ts.SyntaxKind): boolean {
  return EQUALITY_OPERATORS.has(operator) || RELATIONAL_OPERATORS.has(operator);
}

/** Whether `node` is or contains one of `references`. */
export function containsReference(node: ts.Node, references: ReadonlySet<ts.Node>): boolean {
  return (
    references.has(node) ||
    (ts.forEachChild(node, (child) => containsReference(child, references) || undefined) ?? false)
  );
}
