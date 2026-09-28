import type { SelectorBlocker, SelectorResult, SelectorWalk } from "./selector-expressions.js";
import { joinResults, rejectSelector, selectorExpressionResult } from "./selector-expressions.js";
import type { ObservableReadScan } from "./model.js";
import ts from "typescript";

export type SelectorFunction = ts.ArrowFunction | ts.FunctionExpression;

/**
 * A `useValue(() => …)` selector whose every tracked read is a proven `path$.get()`. The selector
 * reruns on each render and each tracked change; the owner rerenders only when `result` changes.
 */
export interface SelectorSubscription {
  readonly selector: SelectorFunction;
  readonly tracked: readonly ts.Expression[];
  readonly result: SelectorResult;
}

export type SelectorModel =
  | { readonly kind: "proven"; readonly subscription: SelectorSubscription }
  | { readonly kind: "unproven"; readonly blocker: SelectorModelBlocker };

export type SelectorModelBlocker =
  | SelectorBlocker
  | "selector-function-not-proven"
  | "selector-tracks-no-observable";

export function isSelectorFunction(expression: ts.Expression): expression is SelectorFunction {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}

export function selectorModel(selector: SelectorFunction, scan: ObservableReadScan): SelectorModel {
  if (
    selector.parameters.length > 0 ||
    selector.asteriskToken ||
    selector.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  ) {
    return { kind: "unproven", blocker: "selector-function-not-proven" };
  }
  const walk: SelectorWalk = { scan, tracked: new Map(), locals: new Map(), blocker: null };
  const result = ts.isBlock(selector.body)
    ? blockResult(selector.body, walk)
    : selectorExpressionResult(selector.body, walk);
  if (!result) {
    return { kind: "unproven", blocker: walk.blocker ?? "selector-syntax-not-proven" };
  }
  if (walk.tracked.size === 0) {
    return { kind: "unproven", blocker: "selector-tracks-no-observable" };
  }
  return {
    kind: "proven",
    subscription: { selector, tracked: [...walk.tracked.values()], result },
  };
}

/** Const bindings, branches, and returns only; falling off the end returns `undefined`. */
function blockResult(block: ts.Block, walk: SelectorWalk): SelectorResult | null {
  const returns = statementsResult(block.statements, walk);
  const last = block.statements.at(-1);
  if (!returns || (last && ts.isReturnStatement(last))) {
    return returns?.result ?? null;
  }
  return returns.result ? joinResults(returns.result, "primitive") : "primitive";
}

interface ReturnedResults {
  readonly result: SelectorResult | null;
}

function statementsResult(
  statements: readonly ts.Statement[],
  walk: SelectorWalk,
): ReturnedResults | null {
  let result: SelectorResult | null = null;
  for (const statement of statements) {
    const returned = statementResult(statement, walk);
    if (!returned) {
      return null;
    }
    if (returned.result) {
      result = result ? joinResults(result, returned.result) : returned.result;
    }
  }
  return { result };
}

function statementResult(statement: ts.Statement, walk: SelectorWalk): ReturnedResults | null {
  if (ts.isReturnStatement(statement)) {
    const result = statement.expression
      ? selectorExpressionResult(statement.expression, walk)
      : "primitive";
    return result ? { result } : null;
  }
  if (ts.isIfStatement(statement)) {
    return ifStatementResult(statement, walk);
  }
  if (ts.isBlock(statement)) {
    return scopedStatementsResult(statement.statements, walk);
  }
  return ts.isVariableStatement(statement) && declareLocals(statement, walk)
    ? { result: null }
    : rejectSelector(walk, "selector-syntax-not-proven");
}

function ifStatementResult(statement: ts.IfStatement, walk: SelectorWalk): ReturnedResults | null {
  if (!selectorExpressionResult(statement.expression, walk)) {
    return null;
  }
  const whenTrue = scopedStatementsResult([statement.thenStatement], walk);
  const whenFalse = statement.elseStatement
    ? scopedStatementsResult([statement.elseStatement], walk)
    : { result: null };
  if (!whenTrue || !whenFalse) {
    return null;
  }
  if (!whenTrue.result || !whenFalse.result) {
    return { result: whenTrue.result ?? whenFalse.result };
  }
  return { result: joinResults(whenTrue.result, whenFalse.result) };
}

/** Block-scoped consts stay inside their block, so a later reference resolves to the outer binding. */
function scopedStatementsResult(
  statements: readonly ts.Statement[],
  walk: SelectorWalk,
): ReturnedResults | null {
  const scoped: SelectorWalk = { ...walk, locals: new Map(walk.locals) };
  const returned = statementsResult(statements, scoped);
  walk.blocker ??= scoped.blocker;
  return returned;
}

function declareLocals(statement: ts.VariableStatement, walk: SelectorWalk): boolean {
  if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
    return false;
  }
  return statement.declarationList.declarations.every((declaration) => {
    const result =
      ts.isIdentifier(declaration.name) &&
      declaration.initializer &&
      selectorExpressionResult(declaration.initializer, walk);
    if (!result || !ts.isIdentifier(declaration.name)) {
      return false;
    }
    walk.locals.set(declaration.name.text, result);
    return true;
  });
}
