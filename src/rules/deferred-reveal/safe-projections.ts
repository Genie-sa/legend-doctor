import {
  callsStyleSheetTheme,
  isPureClassNameCallee,
  styleSheetMember,
} from "../state-proofs/presentation-calls.js";
import {
  isBuiltinReadMethodName,
  receiverReadsMethod,
} from "../state-proofs/builtin-read-calls.js";
import { nodeWithin, visit } from "../../core/ast.js";
import { expressionContainsJsx } from "./jsx-subtrees.js";
import { isAssignmentOperator } from "../../core/analysis-ast.js";
import ts from "typescript";

const EMPTY_BINDINGS: ReadonlySet<string> = new Set();

export interface SafeProjectionQuery {
  readonly allowedIdentifierCalls?: ReadonlySet<string>;
  readonly allowedPropertyCalls?: ReadonlySet<string>;
  readonly expression: ts.Expression;
  readonly reference: ts.Node;
}

interface CallProofs {
  readonly identifiers: ReadonlySet<string>;
  readonly properties: ReadonlySet<string>;
  /**
   * Inside a style member, calls into the style factory's theme are reads, and other members are
   * not followed, so members that call each other cannot recurse forever.
   */
  readonly insideStyleMember: boolean;
}

const STYLE_MEMBER_PROOFS: CallProofs = {
  identifiers: EMPTY_BINDINGS,
  insideStyleMember: true,
  properties: EMPTY_BINDINGS,
};

export function isSafeProjectionExpression({
  allowedIdentifierCalls = EMPTY_BINDINGS,
  allowedPropertyCalls = EMPTY_BINDINGS,
  expression,
  reference,
}: SafeProjectionQuery): boolean {
  return (
    nodeWithin(reference, expression) &&
    evaluatesWithoutSideEffects(expression, {
      identifiers: allowedIdentifierCalls,
      insideStyleMember: false,
      properties: allowedPropertyCalls,
    })
  );
}

function evaluatesWithoutSideEffects(node: ts.Node, proofs: CallProofs): boolean {
  let safe = true;
  visit(node, (current) => {
    if (
      ts.isAwaitExpression(current) ||
      ts.isYieldExpression(current) ||
      ts.isNewExpression(current) ||
      ts.isDeleteExpression(current) ||
      ts.isPostfixUnaryExpression(current) ||
      (ts.isPrefixUnaryExpression(current) &&
        (current.operator === ts.SyntaxKind.PlusPlusToken ||
          current.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isBinaryExpression(current) && isAssignmentOperator(current.operatorToken.kind)) ||
      (ts.isCallExpression(current) && !isSafeProjectionCall(current, proofs))
    ) {
      safe = false;
    }
  });
  return safe;
}

function isSafeProjectionCall(call: ts.CallExpression, proofs: CallProofs): boolean {
  const callee = call.expression;
  if (proofs.insideStyleMember && callsStyleSheetTheme(callee)) {
    return true;
  }
  if (ts.isIdentifier(callee)) {
    return proofs.identifiers.has(callee.text) || isPureClassNameCallee(callee);
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    (isReadOnlyMethodCall(call, callee) ||
      (ts.isIdentifier(callee.expression) &&
        proofs.properties.has(`${callee.expression.text}.${callee.name.text}`)) ||
      (!proofs.insideStyleMember && isPureStyleMemberCall(callee)))
  );
}

/** A style sheet member function that computes its style without writes or foreign calls. */
function isPureStyleMemberCall(callee: ts.PropertyAccessExpression): boolean {
  const member = styleSheetMember(callee);
  return member !== null && evaluatesWithoutSideEffects(member, STYLE_MEMBER_PROOFS);
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
