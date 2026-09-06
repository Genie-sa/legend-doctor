import {
  bindingDeclarationCount,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { findAncestorUntil, nearestNestedFunction, nodeWithin, visit } from "../../core/ast.js";
import {
  isSafeJsxProjectionReference,
  nearestRepeatedRenderCall,
} from "../state-proofs/jsx-subtrees.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import { bindingReferencesIn } from "./array-set-aliases.js";
import { expressionDependsOnBinding } from "../state-proofs/binding-lookup.js";
import { isJsxNode } from "../state-proofs/callback-sites.js";
import { isMembershipMountGate } from "./rendered-list-membership.js";
import { repeatedRenderHasStableItemKey } from "../state-proofs/unique-repeated-selection.js";
import ts from "typescript";

export function isSelectedItemLookup(
  initializer: ts.Expression,
  stateReference: ts.Identifier,
): boolean {
  const callback = nullCoalescedFindCallback(initializer);
  if (!callback || !comparesStateToItem(callback, stateReference)) {
    return false;
  }
  return identifierReadCount(initializer, stateReference.text) === 1;
}

function nullCoalescedFindCallback(
  initializer: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | null {
  let expression = unwrapTransparentExpression(initializer);
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    unwrapTransparentExpression(expression.right).kind === ts.SyntaxKind.NullKeyword
  ) {
    expression = unwrapTransparentExpression(expression.left);
  }
  if (
    !ts.isCallExpression(expression) ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.name.text !== "find" ||
    expression.arguments.length !== 1
  ) {
    return null;
  }
  const [callback] = expression.arguments;
  return callback &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    !ts.isBlock(callback.body) &&
    callback.parameters.length === 1
    ? callback
    : null;
}

function comparesStateToItem(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateReference: ts.Identifier,
): boolean {
  if (ts.isBlock(callback.body)) {
    return false;
  }
  const comparison = unwrapTransparentExpression(callback.body);
  if (
    !ts.isBinaryExpression(comparison) ||
    comparison.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return false;
  }
  const left = unwrapTransparentExpression(comparison.left);
  const right = unwrapTransparentExpression(comparison.right);
  const other = oppositeComparisonOperand(left, right, stateReference);
  return (
    other !== null && expressionDependsOnBinding(other, callback.parameters[0]!.name, callback)
  );
}

function identifierReadCount(node: ts.Node, name: string): number {
  let reads = 0;
  visit(node, (child) => {
    if (ts.isIdentifier(child) && child.text === name && !isNonValueIdentifier(child)) {
      reads += 1;
    }
  });
  return reads;
}

export function isRepeatedScalarKeyProjection(node: ts.Node, state: StateCandidate): boolean {
  if (!ts.isIdentifier(node)) {
    return false;
  }
  const repeated = nearestRepeatedRenderCall(node, state.owner);
  const callback = repeated?.arguments[0];
  if (
    !repeated ||
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    nearestNestedFunction(node, state.owner) !== callback ||
    !repeatedRenderHasStableItemKey(callback) ||
    !scalarComparisonUsesRepeatedKey(node, callback)
  ) {
    return false;
  }
  const declaration = findAncestorUntil(node, ts.isVariableDeclaration, callback);
  return declaration?.initializer &&
    ts.isIdentifier(declaration.name) &&
    nodeWithin(node, declaration.initializer)
    ? aliasedKeyProjectionIsSafe({ callback, declaration, owner: state.owner, repeated })
    : isSafeKeyProjectionReference(node, callback);
}

function isSafeKeyProjectionReference(
  reference: ts.Identifier,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  return (
    !isMembershipMountGate(reference, callback) &&
    findAncestorUntil(reference, isJsxNode, callback) !== null &&
    isSafeJsxProjectionReference(reference, callback, new Set(["cn"]))
  );
}

interface AliasedKeyProjection {
  callback: ts.ArrowFunction | ts.FunctionExpression;
  declaration: ts.VariableDeclaration;
  owner: RuntimeFunctionLike;
  repeated: ts.CallExpression;
}

function aliasedKeyProjectionIsSafe(projection: AliasedKeyProjection): boolean {
  const { callback, declaration, owner, repeated } = projection;
  if (
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(callback, declaration.name.text) !== 1
  ) {
    return false;
  }
  const references = bindingReferencesIn(callback, declaration.name, declaration.name.getText());
  return (
    references.length > 0 &&
    references.every(
      (reference) =>
        nearestRepeatedRenderCall(reference, owner) === repeated &&
        isSafeKeyProjectionReference(reference, callback),
    )
  );
}

function scalarComparisonUsesRepeatedKey(
  node: ts.Identifier,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== callback;
    current = current.parent
  ) {
    if (
      !ts.isBinaryExpression(current) ||
      ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
        current.operatorToken.kind,
      )
    ) {
      continue;
    }
    const other = oppositeContainingOperand(current, node);
    if (
      other &&
      callback.parameters.some((parameter) =>
        expressionDependsOnBinding(other, parameter.name, callback),
      )
    ) {
      return true;
    }
  }
  return false;
}

function oppositeComparisonOperand(
  left: ts.Expression,
  right: ts.Expression,
  reference: ts.Node,
): ts.Expression | null {
  if (left === reference) {
    return right;
  }
  return right === reference ? left : null;
}

function oppositeContainingOperand(
  comparison: ts.BinaryExpression,
  node: ts.Node,
): ts.Expression | null {
  if (nodeWithin(node, comparison.left)) {
    return comparison.right;
  }
  return nodeWithin(node, comparison.right) ? comparison.left : null;
}
