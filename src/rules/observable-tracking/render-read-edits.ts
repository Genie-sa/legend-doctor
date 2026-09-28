import { rangeHasComment, replaceNode } from "../../core/text-edits.js";
import type { TextEdit } from "../../core/types.js";
import type { TrackingScan } from "./model.js";
import ts from "typescript";
import { useValueReference } from "../../core/use-value-import.js";
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
 * Rewrites the render-body initializer `x$.get()` to `useValue(x$)`. Abstains when an earlier
 * return would make the new hook conditional, when a comment sits between the path and the call,
 * when the installed Legend State has no `useValue`, or when importing it needs a new declaration.
 */
export function renderInitializerEdits(
  call: ts.CallExpression,
  statement: ts.Statement,
  scan: TrackingScan,
): readonly TextEdit[] | null {
  const method = call.expression;
  if (
    scan.installedLegendState?.useValueExport === "missing" ||
    !ts.isPropertyAccessExpression(method) ||
    !runsOnEveryRender(statement) ||
    rangeHasComment(scan.sourceFile, { end: call.getEnd(), pos: method.expression.getEnd() })
  ) {
    return null;
  }
  const reference = useValueReference(scan);
  const path = method.expression.getText(scan.sourceFile);
  return reference && [...reference.edits, replaceNode(scan, call, `${reference.callee}(${path})`)];
}
