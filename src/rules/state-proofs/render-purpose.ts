import { localFunctionBinding, uniqueVariableDeclaration } from "./binding-lookup.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isRuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";

/** A render may publish mutable data even when it never reads the state that scheduled it. */
export function ownerHasMutableRenderRead(
  owner: RuntimeFunctionLike,
  trackedRead: ts.CallExpression | null = null,
  trackedSources: ReadonlySet<ts.Node> = new Set(),
): boolean {
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
    // Subscription cuts also preserve prop snapshots. Command-only state retains
    // Its separate callback proof rather than treating callback factories as snapshots.
    if (
      (ts.isJsxExpression(node) || ts.isJsxSpreadAttribute(node)) &&
      node.expression &&
      (trackedRead !== null || (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)))
    ) {
      return (
        hasImperativeRead(node.expression, { owner, trackedRead, trackedSources }, new Set()) ||
        Boolean(node.forEachChild(inspect))
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

interface ImperativeReadScope {
  readonly trackedSources: ReadonlySet<ts.Node>;
  readonly owner: RuntimeFunctionLike;
  readonly trackedRead: ts.CallExpression | null;
}

function hasImperativeRead(node: ts.Node, scope: ImperativeReadScope, seen: Set<ts.Node>): boolean {
  const { owner, trackedRead } = scope;
  // A subscription being relocated already has its own update source; it is not a mutable snapshot.
  if (node === trackedRead || scope.trackedSources.has(node) || isRuntimeFunctionLike(node)) {
    return false;
  }
  if (ts.isIdentifier(node)) {
    const declaration = uniqueVariableDeclaration(owner, node.text);
    if (declaration?.initializer && ts.isIdentifier(declaration.name) && !seen.has(declaration)) {
      seen.add(declaration);
      return hasImperativeRead(declaration.initializer, scope, seen);
    }
  }
  return (
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    Boolean(node.forEachChild((child) => hasImperativeRead(child, scope, seen)))
  );
}
