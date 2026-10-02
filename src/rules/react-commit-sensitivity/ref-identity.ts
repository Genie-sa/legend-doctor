import { localFunctionBinding, uniqueVariableDeclaration } from "../state-proofs/binding-lookup.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isImportedReactCall } from "./binding-resolution.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

interface RefIdentityScope {
  readonly owner: RuntimeFunctionLike;
  readonly imports: HookImports;
  readonly resolving: ReadonlySet<ts.VariableDeclaration>;
}

function conditionalRefIdentityMayChange(
  value: ts.ConditionalExpression,
  scope: RefIdentityScope,
): boolean {
  return identityMayChange(value.whenTrue, scope) || identityMayChange(value.whenFalse, scope);
}

export function refIdentityMayChange(
  expression: ts.Expression,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): boolean {
  return identityMayChange(expression, { imports, owner, resolving: new Set() });
}

function identityMayChange(expression: ts.Expression, scope: RefIdentityScope): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value) || ts.isCallExpression(value)) {
    return !ts.isCallExpression(value) || !isStableReactRefFactory(value, scope.imports);
  }
  if (ts.isConditionalExpression(value)) {
    return conditionalRefIdentityMayChange(value, scope);
  }
  return ts.isIdentifier(value) && aliasedRefIdentityMayChange(value, scope);
}

/** An alias whose conditional leads back to itself has no proven identity, so it may change. */
function aliasedRefIdentityMayChange(value: ts.Identifier, scope: RefIdentityScope): boolean {
  if (localFunctionBinding(scope.owner, value.text)) {
    return true;
  }
  const declaration = uniqueVariableDeclaration(scope.owner, value.text);
  if (!declaration?.initializer) {
    return false;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  if (ts.isConditionalExpression(initializer)) {
    return (
      scope.resolving.has(declaration) ||
      conditionalRefIdentityMayChange(initializer, {
        ...scope,
        resolving: new Set(scope.resolving).add(declaration),
      })
    );
  }
  return ts.isCallExpression(initializer) && !isStableReactRefFactory(initializer, scope.imports);
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
