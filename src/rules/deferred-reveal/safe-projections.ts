import { callRootIdentifier, isAssignmentOperator } from "../../core/analysis-ast.js";
import { nodeWithin, visit } from "../../core/ast.js";
import ts from "typescript";

const EMPTY_BINDINGS: ReadonlySet<string> = new Set();

/** Read-only prototype methods of arrays, strings, maps, and sets; none mutates its receiver. */
const SAFE_PROJECTION_METHODS: ReadonlySet<string> = new Set([
  "at",
  "charAt",
  "concat",
  "endsWith",
  "entries",
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "flat",
  "flatMap",
  "get",
  "has",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "localeCompare",
  "map",
  "padEnd",
  "padStart",
  "replace",
  "replaceAll",
  "slice",
  "some",
  "split",
  "startsWith",
  "substring",
  "toFixed",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "toLowerCase",
  "toSorted",
  "toString",
  "toUpperCase",
  "trim",
  "values",
]);

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
  const name = callee.name.text;
  const root = callRootIdentifier(callee);
  return (
    (SAFE_PROJECTION_METHODS.has(name) && !isRenderCallbackCall(call)) ||
    (ts.isIdentifier(callee.expression) &&
      allowedPropertyCalls.has(`${callee.expression.text}.${name}`)) ||
    root === "styles" ||
    root === "cn"
  );
}

/**
 * A prototype method whose callback produces JSX is a render callback, not a value projection; the
 * repeated rows it renders keep their own mount-identity proofs.
 */
function isRenderCallbackCall(call: ts.CallExpression): boolean {
  return call.arguments.some((argument) => containsJsx(argument));
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  visit(node, (candidate) => {
    if (
      ts.isJsxElement(candidate) ||
      ts.isJsxSelfClosingElement(candidate) ||
      ts.isJsxFragment(candidate)
    ) {
      found = true;
    }
  });
  return found;
}
