import { localFunctionBinding, uniqueVariableDeclaration } from "./binding-lookup.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isRuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";

/** A render may publish mutable data even when it never reads the state that scheduled it. */
export function ownerHasMutableRenderRead(owner: RuntimeFunctionLike): boolean {
  const seen = new Set<ts.Node>();
  function inspect(node: ts.Node): boolean {
    // Deferred commands may use refs without relying on the owner's render.
    if (isRuntimeFunctionLike(node)) {
      return false;
    }
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === "current") ||
      (ts.isElementAccessExpression(node) &&
        (!ts.isStringLiteralLike(node.argumentExpression) ||
          node.argumentExpression.text === "current"))
    ) {
      return true;
    }
    if (ts.isCallExpression(node) && calledHelperReadsRef(node)) {
      return true;
    }
    if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      return (
        hasImperativeRead(node.expression, owner, new Set()) || Boolean(node.forEachChild(inspect))
      );
    }
    return Boolean(node.forEachChild(inspect));
  }
  function calledHelperReadsRef(call: ts.CallExpression): boolean {
    const helper = ts.isIdentifier(call.expression)
      ? localFunctionBinding(owner, call.expression.text)
      : null;
    if (!helper?.body || seen.has(helper)) {
      return false;
    }
    seen.add(helper);
    return inspect(helper.body);
  }
  return owner.body !== undefined && inspect(owner.body);
}

function hasImperativeRead(node: ts.Node, owner: RuntimeFunctionLike, seen: Set<ts.Node>): boolean {
  if (isRuntimeFunctionLike(node)) {
    return false;
  }
  if (ts.isIdentifier(node)) {
    const declaration = uniqueVariableDeclaration(owner, node.text);
    if (declaration?.initializer && ts.isIdentifier(declaration.name) && !seen.has(declaration)) {
      seen.add(declaration);
      return hasImperativeRead(declaration.initializer, owner, seen);
    }
  }
  return (
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    Boolean(node.forEachChild((child) => hasImperativeRead(child, owner, seen)))
  );
}
