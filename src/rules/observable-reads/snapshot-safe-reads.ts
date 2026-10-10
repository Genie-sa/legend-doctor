import { isAssignmentOperator, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { isRuntimeFunctionLike, visit } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { ownerLevelReferences } from "../../core/scope-references.js";
import ts from "typescript";

/**
 * The read sits, outside any nested function, in the initializer of an owner-level `const` that
 * nothing references and whose initializer assigns nothing. Its value never reaches output, a
 * command, or shared state, and React may skip any render, so no behavior depends on the render a
 * change of the subscribed value forces.
 */
export function isUnusedBindingInitializerRead(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
): boolean {
  const declaration = enclosingInitializedDeclaration(reference);
  return (
    declaration !== null &&
    ts.isIdentifier(declaration.name) &&
    isOwnerLevelConst(declaration, owner) &&
    ownerLevelReferences(owner, declaration.name).length === 0 &&
    !writesState(declaration.initializer!)
  );
}

function enclosingInitializedDeclaration(reference: ts.Identifier): ts.VariableDeclaration | null {
  for (let current: ts.Node = reference; current.parent; current = current.parent) {
    const { parent } = current;
    if (isRuntimeFunctionLike(parent)) {
      return null;
    }
    if (ts.isVariableDeclaration(parent)) {
      return parent.initializer === current ? parent : null;
    }
  }
  return null;
}

function isOwnerLevelConst(
  declaration: ts.VariableDeclaration,
  owner: RuntimeFunctionLike,
): boolean {
  const list = declaration.parent;
  const statement = list.parent;
  return (
    ts.isVariableDeclarationList(list) &&
    (list.flags & ts.NodeFlags.Const) !== 0 &&
    ts.isVariableStatement(statement) &&
    statement.parent === owner.body
  );
}

function writesState(expression: ts.Expression): boolean {
  let writes = false;
  visit(expression, (node) => {
    writes ||=
      (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) ||
      ts.isDeleteExpression(node) ||
      ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken));
  });
  return writes;
}

/**
 * `if (value !== next) value$.set(next)`, where the comparison is the guard's last condition and
 * `next` is a literal or a local name. Legend's `set` notifies nothing when the stored value is
 * identical, so the guard skips only writes Legend drops anyway; comparing a `peek()` snapshot lets
 * each guarded write run exactly when it changes the stored value.
 */
export function isGuardedWriteRead(reference: ts.Identifier, observable: string): boolean {
  const comparison = reference.parent;
  if (
    !ts.isBinaryExpression(comparison) ||
    comparison.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    return false;
  }
  const next = comparison.left === reference ? comparison.right : comparison.left;
  const guard = guardingStatement(comparison);
  const write = guard && soleWrite(guard.thenStatement);
  return (
    write !== null && isStableOperand(next, reference.text) && isSetCallOf(write, observable, next)
  );
}

/** The `if` without `else` whose condition ends with `comparison`, joined only by `&&`. */
function guardingStatement(comparison: ts.Expression): ts.IfStatement | null {
  let condition: ts.Node = comparison;
  while (
    ts.isParenthesizedExpression(condition.parent) ||
    (ts.isBinaryExpression(condition.parent) &&
      condition.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      condition.parent.right === condition)
  ) {
    condition = condition.parent;
  }
  const statement = condition.parent;
  return ts.isIfStatement(statement) &&
    statement.expression === condition &&
    statement.elseStatement === undefined
    ? statement
    : null;
}

function soleWrite(statement: ts.Statement): ts.Expression | null {
  const [only, ...rest] = ts.isBlock(statement) ? statement.statements : [statement];
  return only && rest.length === 0 && ts.isExpressionStatement(only) ? only.expression : null;
}

function isStableOperand(operand: ts.Expression, readName: string): boolean {
  const expression = unwrapTransparentExpression(operand);
  return (
    (ts.isIdentifier(expression) && expression.text !== readName) ||
    ts.isStringLiteral(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.NullKeyword ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword
  );
}

function isSetCallOf(write: ts.Expression, observable: string, next: ts.Expression): boolean {
  const call = unwrapTransparentExpression(write);
  if (!ts.isCallExpression(call) || call.arguments.length !== 1) {
    return false;
  }
  const callee = call.expression;
  const [argument] = call.arguments;
  return (
    ts.isPropertyAccessExpression(callee) &&
    !callee.questionDotToken &&
    callee.name.text === "set" &&
    callee.expression.getText() === observable &&
    unwrapTransparentExpression(argument!).getText() === unwrapTransparentExpression(next).getText()
  );
}
