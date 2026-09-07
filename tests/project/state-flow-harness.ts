import { isRuntimeFunctionLike, visit } from "../../src/core/ast.js";
import assert from "node:assert/strict";
import ts from "typescript";

export const requireValue = <Value>(value: Value | undefined): Value => {
  assert.ok(value);
  return value;
};
export const requireCall = (
  calls: ReadonlyMap<string, ts.CallExpression>,
  name: string,
): ts.CallExpression => requireValue(calls.get(name));

interface FunctionAndCalls {
  calls: Map<string, ts.CallExpression>;
  fn: ts.FunctionDeclaration;
}

export function functionAndCalls(source: string): FunctionAndCalls {
  const file = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true);
  const fn = file.statements.find(ts.isFunctionDeclaration);
  assert.ok(fn && isRuntimeFunctionLike(fn));
  const calls = new Map<string, ts.CallExpression>();
  visit(fn.body, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      /^set[A-Z]/u.test(node.expression.text)
    ) {
      calls.set(node.expression.text, node);
    }
  });
  return { calls, fn };
}
