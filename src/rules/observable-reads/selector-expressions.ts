import {
  RESERVED_OBSERVABLE_MEMBERS,
  directGetReceiver,
  provenObservablePath,
} from "./observable-paths.js";
import {
  isAssignmentOperator,
  propertyPathHasBinding,
  staticPropertyPath,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { ObservableReadScan } from "./model.js";
import { sourceHasRuntimeBinding } from "../state-proofs/binding-lookup.js";
import ts from "typescript";

/** What a selector can return, as far as the change check in `useValue` is concerned. */
export type SelectorResult = "boolean" | "primitive" | "unknown";

export type SelectorBlocker =
  | "selector-calls-unproven-function"
  | "selector-observable-binding-not-proven"
  | "selector-read-not-proven"
  | "selector-syntax-not-proven";

export interface SelectorWalk {
  readonly scan: ObservableReadScan;
  readonly tracked: Map<string, ts.Expression>;
  readonly locals: Map<string, SelectorResult>;
  blocker: SelectorBlocker | null;
}

export const COMPARISON_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.InstanceOfKeyword,
]);

const NUMERIC_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);

/** Builtin queries on a snapshot value; none of them reaches back into an observable. */
const BOOLEAN_SNAPSHOT_METHODS: ReadonlySet<string> = new Set([
  "endsWith",
  "has",
  "includes",
  "startsWith",
]);
const PRIMITIVE_SNAPSHOT_METHODS: ReadonlySet<string> = new Set([
  "toLowerCase",
  "toUpperCase",
  "trim",
]);
const PRIMITIVE_GLOBAL_CALLS: ReadonlySet<string> = new Set(["Number", "String"]);
const MATH_METHODS: ReadonlySet<string> = new Set(["abs", "ceil", "floor", "max", "min", "round"]);

export function joinResults(left: SelectorResult, right: SelectorResult): SelectorResult {
  if (left === "unknown" || right === "unknown") {
    return "unknown";
  }
  return left === "boolean" && right === "boolean" ? "boolean" : "primitive";
}

export function rejectSelector(walk: SelectorWalk, blocker: SelectorBlocker): null {
  walk.blocker ??= blocker;
  return null;
}

/** The result kind of a selector expression, or null when its tracking is not statically proven. */
export function selectorExpressionResult(
  expression: ts.Expression,
  walk: SelectorWalk,
): SelectorResult | null {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return identifierResult(value, walk);
  }
  if (ts.isCallExpression(value)) {
    return callResult(value, walk);
  }
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    return memberResult(value, walk);
  }
  return operatorResult(value, walk);
}

function operatorResult(value: ts.Expression, walk: SelectorWalk): SelectorResult | null {
  if (ts.isBinaryExpression(value)) {
    return binaryResult(value, walk);
  }
  if (ts.isConditionalExpression(value)) {
    return conditionalResult(value, walk);
  }
  if (ts.isPrefixUnaryExpression(value)) {
    return prefixResult(value, walk);
  }
  if (ts.isTypeOfExpression(value) || ts.isVoidExpression(value)) {
    return selectorExpressionResult(value.expression, walk) && "primitive";
  }
  return literalResult(value) ?? compositeResult(value, walk);
}

function literalResult(value: ts.Expression): SelectorResult | null {
  if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) {
    return "boolean";
  }
  return ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    value.kind === ts.SyntaxKind.NullKeyword
    ? "primitive"
    : null;
}

function identifierResult(identifier: ts.Identifier, walk: SelectorWalk): SelectorResult | null {
  const local = walk.locals.get(identifier.text);
  if (local) {
    return local;
  }
  if (
    identifier.text === "undefined" &&
    !sourceHasRuntimeBinding(walk.scan.sourceFile, "undefined")
  ) {
    return "primitive";
  }
  return walk.scan.observableBindings.has(identifier.text)
    ? rejectSelector(walk, "selector-read-not-proven")
    : "unknown";
}

function binaryResult(binary: ts.BinaryExpression, walk: SelectorWalk): SelectorResult | null {
  const operator = binary.operatorToken.kind;
  if (isAssignmentOperator(operator) || operator === ts.SyntaxKind.CommaToken) {
    return rejectSelector(walk, "selector-syntax-not-proven");
  }
  const left = selectorExpressionResult(binary.left, walk);
  const right = left && selectorExpressionResult(binary.right, walk);
  return left && right && combinedResult(operator, left, right);
}

function combinedResult(
  operator: ts.BinaryOperator,
  left: SelectorResult,
  right: SelectorResult,
): SelectorResult {
  if (COMPARISON_OPERATORS.has(operator)) {
    return "boolean";
  }
  if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
    // Every falsy value is primitive, so only the right operand can contribute an object.
    return joinResults(left === "boolean" ? "boolean" : "primitive", right);
  }
  return NUMERIC_OPERATORS.has(operator) ? "primitive" : joinResults(left, right);
}

function conditionalResult(
  conditional: ts.ConditionalExpression,
  walk: SelectorWalk,
): SelectorResult | null {
  const condition = selectorExpressionResult(conditional.condition, walk);
  const whenTrue = condition && selectorExpressionResult(conditional.whenTrue, walk);
  const whenFalse = whenTrue && selectorExpressionResult(conditional.whenFalse, walk);
  return whenTrue && whenFalse ? joinResults(whenTrue, whenFalse) : null;
}

function prefixResult(value: ts.PrefixUnaryExpression, walk: SelectorWalk): SelectorResult | null {
  if (
    value.operator === ts.SyntaxKind.PlusPlusToken ||
    value.operator === ts.SyntaxKind.MinusMinusToken
  ) {
    return rejectSelector(walk, "selector-syntax-not-proven");
  }
  const operand = selectorExpressionResult(value.operand, walk);
  return operand && (value.operator === ts.SyntaxKind.ExclamationToken ? "boolean" : "primitive");
}

function compositeResult(value: ts.Expression, walk: SelectorWalk): SelectorResult | null {
  if (ts.isTemplateExpression(value)) {
    return value.templateSpans.every((span) => selectorExpressionResult(span.expression, walk))
      ? "primitive"
      : null;
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.every((element) =>
      selectorExpressionResult(ts.isSpreadElement(element) ? element.expression : element, walk),
    )
      ? "unknown"
      : null;
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.every((property) => objectMemberIsProven(property, walk))
      ? "unknown"
      : null;
  }
  return rejectSelector(walk, "selector-syntax-not-proven");
}

function objectMemberIsProven(member: ts.ObjectLiteralElementLike, walk: SelectorWalk): boolean {
  if (ts.isPropertyAssignment(member) && !ts.isComputedPropertyName(member.name)) {
    return selectorExpressionResult(member.initializer, walk) !== null;
  }
  if (ts.isShorthandPropertyAssignment(member)) {
    return identifierResult(member.name, walk) !== null;
  }
  if (ts.isSpreadAssignment(member)) {
    return selectorExpressionResult(member.expression, walk) !== null;
  }
  return rejectSelector(walk, "selector-syntax-not-proven") !== null;
}

/** A member of a snapshot or closure value; a member of an observable node is an untracked proxy. */
function memberResult(
  member: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  walk: SelectorWalk,
): SelectorResult | null {
  if (observableNodeRoot(member, walk.scan.observableBindings)) {
    return rejectSelector(walk, "selector-read-not-proven");
  }
  const receiver = selectorExpressionResult(member.expression, walk);
  if (!receiver || ts.isPropertyAccessExpression(member)) {
    return receiver && "unknown";
  }
  return selectorExpressionResult(member.argumentExpression, walk) && "unknown";
}

function callResult(call: ts.CallExpression, walk: SelectorWalk): SelectorResult | null {
  const receiver = directGetReceiver(call);
  if (receiver) {
    return trackedReadResult(receiver, walk);
  }
  const blocker = callBlocker(call, walk.scan.observableBindings);
  const known = blocker ? null : (globalCallResult(call, walk) ?? snapshotMethodResult(call, walk));
  if (!known) {
    return rejectSelector(walk, blocker ?? "selector-calls-unproven-function");
  }
  return call.arguments.every((argument) => selectorExpressionResult(argument, walk))
    ? known
    : null;
}

function callBlocker(
  call: ts.CallExpression,
  observableBindings: ReadonlySet<string>,
): SelectorBlocker | null {
  if (untrackedObservableCall(call, observableBindings)) {
    return "selector-read-not-proven";
  }
  return call.questionDotToken || call.arguments.some(ts.isSpreadElement)
    ? "selector-calls-unproven-function"
    : null;
}

/** `x$.peek()`, `x$.get(true)`, or another observable member call that does not track `x$` deeply. */
function untrackedObservableCall(
  call: ts.CallExpression,
  observableBindings: ReadonlySet<string>,
): boolean {
  const callee = unwrapTransparentExpression(call.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    RESERVED_OBSERVABLE_MEMBERS.has(callee.name.text) &&
    observableNodeRoot(callee.expression, observableBindings)
  );
}

function trackedReadResult(receiver: ts.Expression, walk: SelectorWalk): SelectorResult | null {
  const path = provenObservablePath(receiver, walk.scan.observableBindings);
  if (path) {
    walk.tracked.set(path.getText(walk.scan.sourceFile), path);
    return walk.scan.primitivePaths?.has(path.getText(walk.scan.sourceFile))
      ? "primitive"
      : "unknown";
  }
  if (!observableNodeRoot(receiver, walk.scan.observableBindings)) {
    return rejectSelector(walk, "selector-observable-binding-not-proven");
  }
  if (!keyedObservablePath(receiver, walk)) {
    return rejectSelector(walk, "selector-read-not-proven");
  }
  walk.tracked.set(receiver.getText(walk.scan.sourceFile), receiver);
  return "unknown";
}

/** `items$[key].title` with render-time keys: the selector reruns every render, so it tracks the current key. */
function keyedObservablePath(receiver: ts.Expression, walk: SelectorWalk): boolean {
  const links = memberChain(receiver);
  return (
    links.some((link) => ts.isElementAccessExpression(link)) &&
    links.every((link) => keyedLinkIsProven(link, walk))
  );
}

function memberChain(
  expression: ts.Expression,
): (ts.ElementAccessExpression | ts.PropertyAccessExpression)[] {
  const links: (ts.ElementAccessExpression | ts.PropertyAccessExpression)[] = [];
  for (
    let current = unwrapTransparentExpression(expression);
    ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current);
    current = unwrapTransparentExpression(current.expression)
  ) {
    links.push(current);
  }
  return links;
}

function keyedLinkIsProven(
  link: ts.ElementAccessExpression | ts.PropertyAccessExpression,
  walk: SelectorWalk,
): boolean {
  if (link.questionDotToken) {
    return false;
  }
  return ts.isPropertyAccessExpression(link)
    ? !RESERVED_OBSERVABLE_MEMBERS.has(link.name.text)
    : selectorExpressionResult(link.argumentExpression, walk) !== null;
}

/** The longest static prefix of a member chain, `items$.byId` for `items$.byId[key].title`. */
export function staticMemberPrefix(expression: ts.Expression): readonly string[] | null {
  let current = unwrapTransparentExpression(expression);
  for (;;) {
    const path = staticPropertyPath(current);
    if (path) {
      return path;
    }
    if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) {
      return null;
    }
    current = unwrapTransparentExpression(current.expression);
  }
}

function observableNodeRoot(
  expression: ts.Expression,
  observableBindings: ReadonlySet<string>,
): boolean {
  const path = staticMemberPrefix(expression);
  return path !== null && propertyPathHasBinding(path, observableBindings);
}

function globalCallResult(call: ts.CallExpression, walk: SelectorWalk): SelectorResult | null {
  const callee = unwrapTransparentExpression(call.expression);
  const { sourceFile } = walk.scan;
  if (ts.isIdentifier(callee) && !sourceHasRuntimeBinding(sourceFile, callee.text)) {
    if (callee.text === "Boolean") {
      return "boolean";
    }
    return PRIMITIVE_GLOBAL_CALLS.has(callee.text) ? "primitive" : null;
  }
  return ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Math" &&
    MATH_METHODS.has(callee.name.text) &&
    !sourceHasRuntimeBinding(sourceFile, "Math")
    ? "primitive"
    : null;
}

function snapshotMethodResult(call: ts.CallExpression, walk: SelectorWalk): SelectorResult | null {
  const callee = unwrapTransparentExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken) {
    return null;
  }
  const method = callee.name.text;
  const kind = BOOLEAN_SNAPSHOT_METHODS.has(method)
    ? "boolean"
    : PRIMITIVE_SNAPSHOT_METHODS.has(method) && "primitive";
  if (!kind) {
    return null;
  }
  if (observableNodeRoot(callee.expression, walk.scan.observableBindings)) {
    return rejectSelector(walk, "selector-read-not-proven");
  }
  return selectorExpressionResult(callee.expression, walk) && kind;
}
