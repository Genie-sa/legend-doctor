import { rangeHasComment, replaceNode } from "../../core/text-edits.js";
import type { TextEdit } from "../../core/types.js";
import type { TrackingScan } from "./model.js";
import { subscriptionHookReference } from "../../core/use-value-import.js";
import ts from "typescript";
import { visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";

function canExitEarly(statement: ts.Statement): boolean {
  let exits = false;
  visitSkippingNestedRuntimeFunctions(statement, (node) => {
    exits ||= ts.isReturnStatement(node) || ts.isThrowStatement(node);
  });
  return exits;
}

/** A hook placed at `statement` runs on every render only when no earlier statement can leave the body. */
function runsOnEveryRender(statement: ts.Statement): boolean {
  const body = statement.parent;
  if (!ts.isBlock(body)) {
    return false;
  }
  const preceding = body.statements.slice(0, body.statements.indexOf(statement));
  return !preceding.some((candidate) => canExitEarly(candidate));
}

/**
 * Rewrites the render-body initializer `x$.get()` to a subscription such as `useValue(x$)`.
 * Abstains when an earlier return would make the new hook conditional, when a comment sits between
 * the path and the call, when importing the hook needs a new declaration, and when the callee is a
 * legacy binding that the file's `replace-legacy-use-value` edits would retire.
 */
export function renderInitializerEdits(
  call: ts.CallExpression,
  statement: ts.Statement,
  scan: TrackingScan,
): readonly TextEdit[] | null {
  const method = call.expression;
  if (
    !ts.isPropertyAccessExpression(method) ||
    !runsOnEveryRender(statement) ||
    rangeHasComment(scan.sourceFile, { end: call.getEnd(), pos: method.expression.getEnd() })
  ) {
    return null;
  }
  const reference = subscriptionHookReference(scan, scan.installedLegendState);
  if (!reference || (reference.legacy && scan.installedLegendState?.useValueExport !== "missing")) {
    return null;
  }
  const path = method.expression.getText(scan.sourceFile);
  return [...reference.edits, replaceNode(scan, call, `${reference.callee}(${path})`)];
}
