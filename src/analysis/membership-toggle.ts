import type { StateCandidate, StateUsage } from "./model.js";
import { isValueTransitionProp, unwrapTransparentExpression } from "../core/analysis-ast.js";
import { KEY_VALUE_TUPLE_LENGTH } from "./constants.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import { nearestMutationFunction } from "./mutations.js";
import ts from "typescript";

function soleSnapshotUpdater(
  setterCall: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const updater = setterCall.arguments[0] && unwrapTransparentExpression(setterCall.arguments[0]);
  if (
    !updater ||
    (!ts.isArrowFunction(updater) && !ts.isFunctionExpression(updater)) ||
    updater.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    updater.asteriskToken ||
    updater.parameters.length !== 1 ||
    !ts.isIdentifier(updater.parameters[0]!.name)
  ) {
    return null;
  }
  return updater;
}

export function isExactControlledArrayMembershipToggle(
  state: StateCandidate,
  usage: StateUsage,
): boolean {
  if (
    usage.setterCalls !== 1 ||
    usage.setterReferences !== 1 ||
    usage.setterCallNodes.length !== 1
  ) {
    return false;
  }
  const setterCall = usage.setterCallNodes[0]!;
  const updater = soleSnapshotUpdater(setterCall);
  const previous = updater ? updater.parameters[0]!.name.getText() : null;
  const toggle = updater ? arrayMembershipToggle(updater) : null;
  const value = toggle && previous ? arrayMembershipValue(toggle.condition, previous) : null;
  if (!toggle || !previous || !value) {
    return false;
  }
  return (
    adapterTakesToggleValue(setterCall, state.owner, value) &&
    isArrayMembershipRemoval(toggle.whenPresent, previous, value) &&
    isArrayMembershipAppend(toggle.whenAbsent, previous, value)
  );
}

function adapterTakesToggleValue(
  setterCall: ts.CallExpression,
  owner: RuntimeFunctionLike,
  value: string,
): boolean {
  const adapter = nearestMutationFunction(setterCall, owner);
  return (
    adapter !== owner &&
    adapter.parameters.some(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === value,
    )
  );
}

interface MembershipToggleBranches {
  readonly condition: ts.Expression;
  readonly whenAbsent: ts.Expression;
  readonly whenPresent: ts.Expression;
}

function soleIfStatement(body: ts.ConciseBody): ts.IfStatement | null {
  if (!ts.isBlock(body) || body.statements.length !== 1) {
    return null;
  }
  const [statement] = body.statements;
  if (!statement || !ts.isIfStatement(statement) || !statement.elseStatement) {
    return null;
  }
  return statement;
}

function arrayMembershipToggle(
  updater: ts.ArrowFunction | ts.FunctionExpression,
): MembershipToggleBranches | null {
  const expression = returnedCallbackExpression(updater);
  if (expression && ts.isConditionalExpression(expression)) {
    return {
      condition: expression.condition,
      whenAbsent: expression.whenFalse,
      whenPresent: expression.whenTrue,
    };
  }
  const statement = soleIfStatement(updater.body);
  if (!statement?.elseStatement) {
    return null;
  }
  const whenPresent = returnedStatementExpression(statement.thenStatement);
  const whenAbsent = returnedStatementExpression(statement.elseStatement);
  return whenPresent && whenAbsent
    ? { condition: statement.expression, whenAbsent, whenPresent }
    : null;
}

function returnedStatementExpression(statement: ts.Statement): ts.Expression | null {
  const returned = soleReturnStatement(statement);
  return returned?.expression ? unwrapTransparentExpression(returned.expression) : null;
}

function soleReturnStatement(statement: ts.Statement): ts.ReturnStatement | null {
  if (!ts.isBlock(statement)) {
    return ts.isReturnStatement(statement) ? statement : null;
  }
  const [only] = statement.statements;
  if (statement.statements.length !== 1 || !only || !ts.isReturnStatement(only)) {
    return null;
  }
  return only;
}

function returnedCallbackExpression(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | null {
  if (!ts.isBlock(callback.body)) {
    return unwrapTransparentExpression(callback.body);
  }
  const [statement] = callback.body.statements;
  return callback.body.statements.length === 1 &&
    statement !== undefined &&
    ts.isReturnStatement(statement) &&
    statement.expression !== undefined
    ? unwrapTransparentExpression(statement.expression)
    : null;
}

function arrayMembershipValue(condition: ts.Expression, previous: string): string | null {
  const value = unwrapTransparentExpression(condition);
  if (
    !ts.isCallExpression(value) ||
    value.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(value.expression) ||
    value.expression.name.text !== "includes" ||
    !isIdentifierNamed(value.expression.expression, previous)
  ) {
    return null;
  }
  const member = unwrapTransparentExpression(value.arguments[0]!);
  return ts.isIdentifier(member) ? member.text : null;
}

function isArrayMembershipRemoval(
  expression: ts.Expression,
  previous: string,
  value: string,
): boolean {
  const removal = unwrapTransparentExpression(expression);
  if (
    !ts.isCallExpression(removal) ||
    removal.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(removal.expression) ||
    removal.expression.name.text !== "filter" ||
    !isIdentifierNamed(removal.expression.expression, previous)
  ) {
    return false;
  }
  const predicate = unwrapTransparentExpression(removal.arguments[0]!);
  if (
    (!ts.isArrowFunction(predicate) && !ts.isFunctionExpression(predicate)) ||
    predicate.parameters.length !== 1 ||
    !ts.isIdentifier(predicate.parameters[0]!.name)
  ) {
    return false;
  }
  const item = predicate.parameters[0]!.name.text;
  const comparison = returnedCallbackExpression(predicate);
  return (
    comparison !== null &&
    ts.isBinaryExpression(comparison) &&
    comparison.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    isIdentifierNamed(comparison.left, item) &&
    isIdentifierNamed(comparison.right, value)
  );
}

function isArrayMembershipAppend(
  expression: ts.Expression,
  previous: string,
  value: string,
): boolean {
  const append = unwrapTransparentExpression(expression);
  if (!ts.isArrayLiteralExpression(append) || append.elements.length !== KEY_VALUE_TUPLE_LENGTH) {
    return false;
  }
  const [spread, member] = append.elements;
  return (
    spread !== undefined &&
    ts.isSpreadElement(spread) &&
    isIdentifierNamed(spread.expression, previous) &&
    member !== undefined &&
    !ts.isSpreadElement(member) &&
    isIdentifierNamed(member, value)
  );
}

function isIdentifierNamed(expression: ts.Expression, name: string): boolean {
  const value = unwrapTransparentExpression(expression);
  return ts.isIdentifier(value) && value.text === name;
}

export function isValueTransitionAttribute(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
  valueName: string,
): boolean {
  return isValueTransitionProp(name) || isPairedSetterProp(opening, name, valueName);
}

export function isVisibilityTransitionAttribute(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
  valueName: string,
): boolean {
  if (/^on(?:Open|Visible|Visibility)Change$/u.test(name)) {
    return true;
  }
  if (!isPairedSetterProp(opening, name, valueName)) {
    return false;
  }
  return opening.attributes.properties.some(
    (attribute) =>
      ts.isJsxAttribute(attribute) &&
      /^(?:isOpen|isVisible|open|visible)$/u.test(attribute.name.getText()) &&
      attribute.initializer !== undefined &&
      ts.isJsxExpression(attribute.initializer) &&
      attribute.initializer.expression !== undefined &&
      ts.isIdentifier(attribute.initializer.expression) &&
      attribute.initializer.expression.text === valueName,
  );
}

export function isPairedSetterProp(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement | undefined,
  name: string,
  valueName: string,
): boolean {
  const setter = /^set(?<suffix>[A-Z][A-Za-z0-9]*)$/u.exec(name)?.groups?.suffix;
  if (!opening || !setter) {
    return false;
  }
  const normalizedSetter = normalizeStatePropName(setter);
  return opening.attributes.properties.some((attribute) => {
    if (
      !ts.isJsxAttribute(attribute) ||
      !attribute.initializer ||
      !ts.isJsxExpression(attribute.initializer) ||
      !attribute.initializer.expression ||
      !ts.isIdentifier(attribute.initializer.expression) ||
      attribute.initializer.expression.text !== valueName
    ) {
      return false;
    }
    return normalizeStatePropName(attribute.name.getText()) === normalizedSetter;
  });
}

function normalizeStatePropName(name: string): string {
  return name.replace(/^is(?=[A-Z])/u, "").toLowerCase();
}
