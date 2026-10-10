import { callRootIdentifier, isAssignmentOperator } from "../../core/analysis-ast.js";
import {
  isBuiltinReadMethodName,
  receiverReadsMethod,
} from "../state-proofs/builtin-read-calls.js";
import { nodeWithin, visit } from "../../core/ast.js";
import { expressionContainsJsx } from "./jsx-subtrees.js";
import ts from "typescript";

const EMPTY_BINDINGS: ReadonlySet<string> = new Set();

export interface SafeProjectionQuery {
  readonly allowedIdentifierCalls?: ReadonlySet<string>;
  readonly allowedPropertyCalls?: ReadonlySet<string>;
  readonly expression: ts.Expression;
  readonly reference: ts.Node;
}

export function isSafeProjectionExpression({
  allowedIdentifierCalls = EMPTY_BINDINGS,
  allowedPropertyCalls = EMPTY_BINDINGS,
  expression,
  reference,
}: SafeProjectionQuery): boolean {
  if (!nodeWithin(reference, expression)) {
    return false;
  }
  let safe = true;
  visit(expression, (node) => {
    if (
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isDeleteExpression(node) ||
      ts.isPostfixUnaryExpression(node) ||
      (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) ||
      (ts.isCallExpression(node) &&
        !isSafeProjectionCall(node, allowedIdentifierCalls, allowedPropertyCalls))
    ) {
      safe = false;
    }
  });
  return safe;
}

function isSafeProjectionCall(
  call: ts.CallExpression,
  allowedIdentifierCalls: ReadonlySet<string>,
  allowedPropertyCalls: ReadonlySet<string>,
): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return allowedIdentifierCalls.has(callee.text);
  }
  if (!ts.isPropertyAccessExpression(callee)) {
    return false;
  }
  const root = callRootIdentifier(callee);
  return (
    isReadOnlyMethodCall(call, callee) ||
    (ts.isIdentifier(callee.expression) &&
      allowedPropertyCalls.has(`${callee.expression.text}.${callee.name.text}`)) ||
    root === "styles" ||
    root === "cn"
  );
}

/**
 * A built-in read the receiver's declared type supports, or any built-in read when that type is
 * unknown. A method whose callback produces JSX is a render callback, not a value projection; the
 * repeated rows it renders keep their own mount-identity proofs.
 */
function isReadOnlyMethodCall(
  call: ts.CallExpression,
  callee: ts.PropertyAccessExpression,
): boolean {
  return (
    !call.arguments.some((argument) => expressionContainsJsx(argument)) &&
    (receiverReadsMethod(callee) ?? isBuiltinReadMethodName(callee.name.text))
  );
}
