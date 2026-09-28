import type { TrackingScan } from "./model.js";
import { provenObservablePath } from "../observable-reads/observable-paths.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

const OBSERVABLE_WRITE_METHODS: ReadonlySet<string> = new Set([
  "assign",
  "delete",
  "set",
  "toggle",
]);

/**
 * A read in the condition of an `if` without `else` whose branch only writes proven observables.
 * The value decides render-phase writes and never reaches rendered output, so subscribing would
 * add renders without making any output fresher.
 */
export function guardsOnlyObservableWrites(call: ts.CallExpression, scan: TrackingScan): boolean {
  let condition: ts.Node = call;
  while (ts.isExpression(condition.parent) && !ts.isFunctionLike(condition.parent)) {
    condition = condition.parent;
  }
  const guard = condition.parent;
  return (
    ts.isIfStatement(guard) &&
    guard.expression === condition &&
    guard.elseStatement === undefined &&
    onlyWritesObservables(guard.thenStatement, scan)
  );
}

function onlyWritesObservables(statement: ts.Statement, scan: TrackingScan): boolean {
  if (ts.isBlock(statement)) {
    return (
      statement.statements.length > 0 &&
      statement.statements.every((child) => onlyWritesObservables(child, scan))
    );
  }
  if (ts.isIfStatement(statement)) {
    return (
      onlyWritesObservables(statement.thenStatement, scan) &&
      (statement.elseStatement === undefined ||
        onlyWritesObservables(statement.elseStatement, scan))
    );
  }
  return ts.isExpressionStatement(statement) && isObservableWrite(statement.expression, scan);
}

function isObservableWrite(expression: ts.Expression, scan: TrackingScan): boolean {
  const call = unwrapTransparentExpression(expression);
  return (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    OBSERVABLE_WRITE_METHODS.has(call.expression.name.text) &&
    provenObservablePath(call.expression.expression, scan.observableBindings) !== null
  );
}
