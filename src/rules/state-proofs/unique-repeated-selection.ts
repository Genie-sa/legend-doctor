import {
  findAncestorUntil,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import {
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { expressionDependsOnBinding } from "./binding-lookup.js";
import { expressionIsUniquelyFiltered } from "./uniqueness-filters.js";
import { nearestRepeatedRenderCall } from "./jsx-subtrees.js";
import ts from "typescript";

export function repeatedRenderHasStableItemKey(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  const parameter = callback.parameters[0]?.name;
  if (!parameter) {
    return false;
  }
  let stable = false;
  visitSkippingNestedRuntimeFunctions(callback.body, (node) => {
    if (!ts.isJsxAttribute(node) || node.name.getText() !== "key" || !node.initializer) {
      return;
    }
    const expression = ts.isJsxExpression(node.initializer) ? node.initializer.expression : null;
    if (!expression) {
      return;
    }
    if (expressionDependsOnBinding(expression, parameter, callback)) {
      stable = true;
    }
  });
  return stable;
}

export function isUniquelySelectedRepeatedProjection(
  nodes: readonly ts.Node[],
  boundary: RuntimeFunctionLike,
): boolean {
  const selection = uniqueMapSelection(nodes, boundary);
  if (!selection) {
    return false;
  }
  const clause = soleCaseClause(nodes, selection.callback);
  if (!clause || !isPrimitiveLiteral(clause.expression)) {
    return false;
  }
  return (
    clauseSwitchesOnItem(clause, selection) &&
    clauseReturnsEvery(clause, nodes) &&
    nodesShareOneKeyedLeaf(nodes, clause)
  );
}

/** The inline `.map` callback every render node lives in, together with its item parameter. */
interface RepeatedMapSelection {
  readonly callback: ts.Expression;
  readonly item: ts.Identifier;
}

/** The nodes all render inside one `.map` over a de-duplicated array the callback cannot re-read. */
function uniqueMapSelection(
  nodes: readonly ts.Node[],
  boundary: RuntimeFunctionLike,
): RepeatedMapSelection | null {
  const repeated = soleRepeatedMapCall(nodes, boundary);
  if (!repeated || !ts.isPropertyAccessExpression(repeated.expression)) {
    return null;
  }
  const selection = mapCallbackItem(repeated);
  const receiver = unwrapTransparentExpression(repeated.expression.expression);
  if (
    !selection ||
    (ts.isIdentifier(receiver) && bindingIsReferenced(selection.callback, receiver.text))
  ) {
    return null;
  }
  return expressionIsUniquelyFiltered(repeated.expression.expression, boundary) ? selection : null;
}

/** The single `.map(...)` call that every node renders inside, or null when they differ. */
function soleRepeatedMapCall(
  nodes: readonly ts.Node[],
  boundary: RuntimeFunctionLike,
): ts.CallExpression | null {
  const repeatedCalls = nodes.map((node) => nearestRepeatedRenderCall(node, boundary));
  const [repeated] = repeatedCalls;
  return repeated &&
    repeatedCalls.every((call) => call === repeated) &&
    ts.isPropertyAccessExpression(repeated.expression) &&
    repeated.expression.name.text === "map"
    ? repeated
    : null;
}

/** The lone item parameter of an inline `.map(item => ...)` callback. */
function mapCallbackItem(call: ts.CallExpression): RepeatedMapSelection | null {
  const [callback] = call.arguments;
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return null;
  }
  const item = callback.parameters[0]?.name;
  return item && ts.isIdentifier(item) ? { callback, item } : null;
}

/** The one `case` clause that every render node sits in, or null when they disagree. */
function soleCaseClause(nodes: readonly ts.Node[], boundary: ts.Node): ts.CaseClause | null {
  const clauses = new Set(nodes.map((node) => findAncestorUntil(node, ts.isCaseClause, boundary)));
  if (clauses.size !== 1) {
    return null;
  }
  const [clause] = clauses;
  return clause ?? null;
}

/** The clause belongs to a `switch` on the map callback's own item parameter. */
function clauseSwitchesOnItem(clause: ts.CaseClause, selection: RepeatedMapSelection): boolean {
  const switchStatement = findAncestorUntil(clause, ts.isSwitchStatement, selection.callback);
  if (!switchStatement) {
    return false;
  }
  const switchExpression = unwrapTransparentExpression(switchStatement.expression);
  return ts.isIdentifier(switchExpression) && switchExpression.text === selection.item.text;
}

/** The clause body is exactly one `return` whose expression contains every render node. */
function clauseReturnsEvery(clause: ts.CaseClause, nodes: readonly ts.Node[]): boolean {
  const [returnStatement] = clause.statements;
  if (
    clause.statements.length !== 1 ||
    !returnStatement ||
    !ts.isReturnStatement(returnStatement) ||
    !returnStatement.expression
  ) {
    return false;
  }
  const returned = returnStatement.expression;
  return nodes.every((node) => nodeWithin(node, returned));
}

/** All render nodes sit under one JSX leaf whose `key` is the clause literal. */
function nodesShareOneKeyedLeaf(nodes: readonly ts.Node[], clause: ts.CaseClause): boolean {
  const leaf = nearestJsxElement(nodes[0]!, clause);
  return (
    leaf !== null &&
    nodes.every((node) => nearestJsxElement(node, clause) === leaf) &&
    jsxKeyMatchesLiteral(leaf, clause.expression)
  );
}

function bindingIsReferenced(node: ts.Node, name: string): boolean {
  let found = false;
  visit(node, (current) => {
    if (
      ts.isIdentifier(current) &&
      current.text === name &&
      !isDeclarationName(current) &&
      !isNonValueIdentifier(current)
    ) {
      found = true;
    }
  });
  return found;
}

function isPrimitiveLiteral(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  return ts.isStringLiteralLike(value) || ts.isNumericLiteral(value);
}

function nearestJsxElement(
  node: ts.Node,
  boundary: ts.Node,
): ts.JsxElement | ts.JsxSelfClosingElement | null {
  return findAncestorUntil(
    node,
    (candidate): candidate is ts.JsxElement | ts.JsxSelfClosingElement =>
      ts.isJsxElement(candidate) || ts.isJsxSelfClosingElement(candidate),
    boundary,
  );
}

function jsxKeyMatchesLiteral(
  element: ts.JsxElement | ts.JsxSelfClosingElement,
  literal: ts.Expression,
): boolean {
  const opening = ts.isJsxElement(element) ? element.openingElement : element;
  const key = opening.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === "key",
  );
  if (!key || !ts.isJsxAttribute(key) || !key.initializer) {
    return false;
  }
  const keyValue = jsxAttributeLiteral(key.initializer);
  const caseValue = unwrapTransparentExpression(literal);
  return (
    keyValue !== null &&
    ((ts.isStringLiteralLike(keyValue) &&
      ts.isStringLiteralLike(caseValue) &&
      keyValue.text === caseValue.text) ||
      (ts.isNumericLiteral(keyValue) &&
        ts.isNumericLiteral(caseValue) &&
        keyValue.text === caseValue.text))
  );
}

/** The literal behind a JSX attribute value, whether written bare or inside braces. */
function jsxAttributeLiteral(initializer: ts.JsxAttributeValue): ts.Expression | null {
  if (ts.isStringLiteral(initializer)) {
    return initializer;
  }
  return ts.isJsxExpression(initializer) && initializer.expression
    ? unwrapTransparentExpression(initializer.expression)
    : null;
}
