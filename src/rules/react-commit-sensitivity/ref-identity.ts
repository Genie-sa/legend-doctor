import { localFunctionBinding, uniqueVariableDeclaration } from "../state-proofs/binding-lookup.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isImportedReactCall } from "./binding-resolution.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

function conditionalRefIdentityMayChange(
  value: ts.ConditionalExpression,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): boolean {
  return (
    refIdentityMayChange(value.whenTrue, owner, imports) ||
    refIdentityMayChange(value.whenFalse, owner, imports)
  );
}

export function refIdentityMayChange(
  expression: ts.Expression,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value) || ts.isCallExpression(value)) {
    return !ts.isCallExpression(value) || !isStableReactRefFactory(value, imports);
  }
  if (ts.isConditionalExpression(value)) {
    return conditionalRefIdentityMayChange(value, owner, imports);
  }
  return ts.isIdentifier(value) && aliasedRefIdentityMayChange(value, owner, imports);
}

function aliasedRefIdentityMayChange(
  value: ts.Identifier,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): boolean {
  if (localFunctionBinding(owner, value.text)) {
    return true;
  }
  const declaration = uniqueVariableDeclaration(owner, value.text);
  if (!declaration?.initializer) {
    return false;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  if (ts.isConditionalExpression(initializer)) {
    return conditionalRefIdentityMayChange(initializer, owner, imports);
  }
  return ts.isCallExpression(initializer) && !isStableReactRefFactory(initializer, imports);
}

function isStableReactRefFactory(call: ts.CallExpression, imports: HookImports): boolean {
  if (isImportedReactCall(call, imports, "useRef")) {
    return true;
  }
  if (!isImportedReactCall(call, imports, "useCallback")) {
    return false;
  }
  const [, dependencies] = call.arguments;
  if (!dependencies) {
    return false;
  }
  const value = unwrapTransparentExpression(dependencies);
  return ts.isArrayLiteralExpression(value) && value.elements.length === 0;
}
