import type { InPlaceMemoKeyScan, RawValueBinding, StaleMemo } from "./model.js";
import {
  isPureExpression,
  outermostTransparentParent,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { isConstDeclaration } from "../../core/binding-references.js";
import { sourceHasRuntimeBinding } from "../state-proofs/binding-lookup.js";
import ts from "typescript";
import { valueReferences } from "./memo-reads.js";

const PRIMITIVE_CALLS = new Set(
  "Boolean Number String Math.abs Math.ceil Math.floor Math.max Math.min Math.round".split(" "),
);
const PURE_CALLS = new Set([...PRIMITIVE_CALLS, "Object.entries", "Object.keys", "Object.values"]);
const READ_ONLY_METHODS = new Set(
  "every filter find findIndex flatMap includes indexOf join map reduce slice some".split(" "),
);
const OPERAND_RESULT_OPERATORS = new Set(["&&", "||", "??", ","]);
const PRIMITIVE_KEYWORDS = new Set(["false", "null", "true"]);

/**
 * The name of the stale memo when it is the snapshot's only reader and computes a primitive
 * without side effects, so a selector over the source replaces both and skips equal results.
 */
export function primitiveMemoName(
  binding: RawValueBinding,
  memo: StaleMemo,
  scan: InPlaceMemoKeyScan,
): string | null {
  const target = outermostTransparentParent(memo.call).parent;
  const callback = unwrapTransparentExpression(memo.call.arguments[0]!);
  const readByMemoOnly = valueReferences(binding.owner, binding.name).every(
    (reference) => reference.pos >= memo.call.pos && reference.end <= memo.call.end,
  );
  return readByMemoOnly &&
    ts.isVariableDeclaration(target) &&
    ts.isIdentifier(target.name) &&
    isConstDeclaration(target) &&
    ts.isArrowFunction(callback) &&
    !ts.isBlock(callback.body) &&
    isPrimitive(callback.body, scan.sourceFile) &&
    isPureExpression(callback.body, (call) => isPureCall(call, scan.sourceFile))
    ? target.name.text
    : null;
}

export function isPrimitive(expression: ts.Expression, sourceFile: ts.SourceFile): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isBinaryExpression(value)) {
    const operands = [value.left, value.right];
    return (
      !OPERAND_RESULT_OPERATORS.has(ts.tokenToString(value.operatorToken.kind) ?? "") ||
      operands.every((operand) => isPrimitive(operand, sourceFile))
    );
  }
  if (ts.isConditionalExpression(value)) {
    return [value.whenTrue, value.whenFalse].every((branch) => isPrimitive(branch, sourceFile));
  }
  return ts.isCallExpression(value)
    ? isGlobalCall(value, PRIMITIVE_CALLS, sourceFile)
    : ts.isPrefixUnaryExpression(value) ||
        ts.isStringLiteralLike(value) ||
        ts.isNumericLiteral(value) ||
        ts.isTemplateExpression(value) ||
        PRIMITIVE_KEYWORDS.has(ts.tokenToString(value.kind) ?? "");
}

export function isPureCall(call: ts.CallExpression, sourceFile: ts.SourceFile): boolean {
  const callee = unwrapTransparentExpression(call.expression);
  return (
    isGlobalCall(call, PURE_CALLS, sourceFile) ||
    (ts.isPropertyAccessExpression(callee) && READ_ONLY_METHODS.has(callee.name.text))
  );
}

function isGlobalCall(call: ts.CallExpression, names: Set<string>, file: ts.SourceFile): boolean {
  const name = unwrapTransparentExpression(call.expression).getText(file);
  return names.has(name) && !sourceHasRuntimeBinding(file, name.split(".")[0]!);
}
