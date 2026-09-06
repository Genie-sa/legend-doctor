import type { ClauseRun, ClauseRunInput, ExecutionPath, Lowering, PathResult } from "./model.js";
import {
  clonePaths,
  lowerChildren,
  lowerExpression,
  selectBranchPaths,
} from "./expression-lowering.js";
import { constantBoolean, isInertCaseExpression } from "./constant-conditions.js";
import { isRuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";

const MAX_PATHS = 128;

export function lowerStatements(
  statements: readonly ts.Statement[],
  incoming: readonly ExecutionPath[],
  lowering: Lowering,
): PathResult {
  let result: PathResult = { paths: clonePaths(incoming), unknown: false };
  for (const statement of statements) {
    if (result.paths.every((path) => path.termination !== null)) {
      break;
    }
    result = advanceStatement(statement, result, lowering);
    if (result.paths.length > MAX_PATHS) {
      return { paths: result.paths.slice(0, MAX_PATHS), unknown: true };
    }
  }
  return result;
}

function advanceStatement(
  statement: ts.Statement,
  current: PathResult,
  lowering: Lowering,
): PathResult {
  const active = current.paths.filter((path) => path.termination === null);
  const finished = current.paths.filter((path) => path.termination !== null);
  const next = lowerStatement(statement, active, lowering);
  return { paths: [...finished, ...next.paths], unknown: current.unknown || next.unknown };
}

function lowerStatement(
  statement: ts.Statement,
  incoming: readonly ExecutionPath[],
  lowering: Lowering,
): PathResult {
  const lowered =
    lowerStructuredStatement(statement, incoming, lowering) ??
    lowerControlStatement(statement, incoming, lowering);
  if (lowered) {
    return lowered;
  }
  if (isUnsupportedStatement(statement)) {
    return { paths: clonePaths(incoming), unknown: true };
  }
  return lowerChildren(statement, incoming, lowering);
}

function lowerStructuredStatement(
  statement: ts.Statement,
  incoming: readonly ExecutionPath[],
  lowering: Lowering,
): PathResult | null {
  if (ts.isBlock(statement)) {
    return lowerStatements(statement.statements, incoming, lowering);
  }
  if (ts.isExpressionStatement(statement)) {
    return lowerExpression(statement.expression, incoming, lowering);
  }
  if (ts.isVariableStatement(statement)) {
    return lowerVariableStatement(statement, incoming, lowering);
  }
  if (ts.isIfStatement(statement)) {
    return lowerIf(statement, incoming, lowering);
  }
  return null;
}

function lowerControlStatement(
  statement: ts.Statement,
  incoming: readonly ExecutionPath[],
  lowering: Lowering,
): PathResult | null {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
    return lowerTermination(statement, incoming, lowering);
  }
  if (ts.isBreakStatement(statement)) {
    return lowerBreak(statement, incoming, lowering);
  }
  if (ts.isSwitchStatement(statement)) {
    return lowerSwitch(statement, incoming, lowering);
  }
  if (ts.isFunctionDeclaration(statement) || ts.isEmptyStatement(statement)) {
    return { paths: clonePaths(incoming), unknown: false };
  }
  return null;
}

function isUnsupportedStatement(statement: ts.Statement): boolean {
  return (
    ts.isForStatement(statement) ||
    ts.isForInStatement(statement) ||
    ts.isForOfStatement(statement) ||
    ts.isWhileStatement(statement) ||
    ts.isDoStatement(statement) ||
    ts.isTryStatement(statement) ||
    ts.isWithStatement(statement) ||
    ts.isLabeledStatement(statement) ||
    ts.isContinueStatement(statement)
  );
}

function lowerVariableStatement(
  statement: ts.VariableStatement,
  incoming: readonly ExecutionPath[],
  lowering: Lowering,
): PathResult {
  let result: PathResult = { paths: clonePaths(incoming), unknown: false };
  for (const declaration of statement.declarationList.declarations) {
    if (!declaration.initializer || isRuntimeFunctionLike(declaration.initializer)) {
      continue;
    }
    const next = lowerExpression(declaration.initializer, result.paths, lowering);
    result = { paths: next.paths, unknown: result.unknown || next.unknown };
  }
  return result;
}

function lowerIf(
  statement: ts.IfStatement,
  incoming: readonly ExecutionPath[],
  lowering: Lowering,
): PathResult {
  const condition = lowerExpression(statement.expression, incoming, lowering);
  const thenResult = lowerStatement(statement.thenStatement, condition.paths, lowering);
  const elseResult = statement.elseStatement
    ? lowerStatement(statement.elseStatement, condition.paths, lowering)
    : { paths: clonePaths(condition.paths), unknown: false };
  return {
    paths: selectBranchPaths(
      constantBoolean(statement.expression),
      thenResult.paths,
      elseResult.paths,
    ),
    unknown: condition.unknown || thenResult.unknown || elseResult.unknown,
  };
}

function lowerTermination(
  statement: ts.ReturnStatement | ts.ThrowStatement,
  incoming: readonly ExecutionPath[],
  lowering: Lowering,
): PathResult {
  const result = statement.expression
    ? lowerExpression(statement.expression, incoming, lowering)
    : { paths: clonePaths(incoming), unknown: false };
  return {
    paths: result.paths.map((path) => ({ ...path, termination: "return" })),
    unknown: result.unknown,
  };
}

function lowerBreak(
  statement: ts.BreakStatement,
  incoming: readonly ExecutionPath[],
  lowering: Lowering,
): PathResult {
  if (statement.label || !lowering.breakable) {
    return { paths: clonePaths(incoming), unknown: true };
  }
  return { paths: incoming.map((path) => ({ ...path, termination: "break" })), unknown: false };
}

function lowerSwitch(
  statement: ts.SwitchStatement,
  incoming: readonly ExecutionPath[],
  lowering: Lowering,
): PathResult {
  const discriminant = lowerExpression(statement.expression, incoming, lowering);
  const { clauses } = statement.caseBlock;
  const runs = [...clauses.keys()].map((start) =>
    lowerClauseRun({ clauses, lowering, paths: discriminant.paths, start }),
  );
  const outputs = runs.flatMap((run) => run.outputs);
  if (!clauses.some((clause) => ts.isDefaultClause(clause))) {
    outputs.push(...clonePaths(discriminant.paths));
  }
  return { paths: outputs, unknown: discriminant.unknown || runs.some((run) => run.unknown) };
}

function lowerClauseRun(input: ClauseRunInput): ClauseRun {
  const run: ClauseRun = { outputs: [], paths: clonePaths(input.paths), unknown: false };
  for (let index = input.start; index < input.clauses.length; index += 1) {
    const clause = input.clauses[index];
    if (clause) {
      advanceClause(run, clause, input.lowering);
    }
    if (run.paths.length === 0) {
      break;
    }
  }
  run.outputs.push(...run.paths);
  return run;
}

function advanceClause(run: ClauseRun, clause: ts.CaseOrDefaultClause, lowering: Lowering): void {
  const result = lowerStatements(
    clause.statements,
    run.paths.map((path) => ({ ...path, termination: null })),
    { ...lowering, breakable: true },
  );
  const broken = result.paths.filter((path) => path.termination === "break");
  const returned = result.paths.filter((path) => path.termination === "return");
  run.outputs.push(...broken.map((path) => ({ ...path, termination: null })), ...returned);
  run.paths = result.paths.filter((path) => path.termination === null);
  run.unknown ||=
    result.unknown || (ts.isCaseClause(clause) && !isInertCaseExpression(clause.expression));
}
