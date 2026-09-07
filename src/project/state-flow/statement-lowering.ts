import type { ClauseRun, ClauseRunInput, ExecutionPath, Lowering, PathResult } from "./model.js";
import {
  clonePaths,
  lowerChildren,
  lowerExpression,
  selectBranchPaths,
} from "./expression-lowering.js";
import { constantBoolean, isInertCaseExpression } from "./constant-conditions.js";
import { boundPaths } from "./path-budget.js";
import { isRuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";

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
    result = boundPaths(advanceStatement(statement, result, lowering));
    if (result.unknown) {
      return result;
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
  if (ts.isTryStatement(statement)) {
    return lowerTry(statement, incoming, lowering);
  }
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
    paths: result.paths.map((path) => ({
      ...path,
      termination: ts.isThrowStatement(statement) ? "throw" : "return",
    })),
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
  const returned = result.paths.filter(
    (path) => path.termination === "return" || path.termination === "throw",
  );
  run.outputs.push(...broken.map((path) => ({ ...path, termination: null })), ...returned);
  run.paths = result.paths.filter((path) => path.termination === null);
  run.unknown ||=
    result.unknown || (ts.isCaseClause(clause) && !isInertCaseExpression(clause.expression));
}

/** Keep normal completion and every possible partial execution reaching a catch/finally. */
function lowerTry(
  statement: ts.TryStatement,
  incoming: readonly ExecutionPath[],
  lowering: Lowering,
): PathResult {
  let result: PathResult = { paths: [], unknown: false };
  for (const initial of incoming) {
    const next = lowerTryPath(statement, initial, lowering);
    result = boundPaths({ paths: [...result.paths, ...next.paths], unknown: next.unknown });
    if (result.unknown) {
      return result;
    }
  }
  return statement.finallyBlock ? lowerFinally(statement.finallyBlock, result, lowering) : result;
}

function lowerTryPath(
  statement: ts.TryStatement,
  initial: ExecutionPath,
  lowering: Lowering,
): PathResult {
  const tried = lowerStatements(statement.tryBlock.statements, [initial], lowering);
  if (tried.unknown) {
    return tried;
  }
  const exceptional = exceptionPrefixes(initial, tried.paths);
  if (exceptional.unknown) {
    return exceptional;
  }
  const caught = statement.catchClause
    ? lowerStatements(statement.catchClause.block.statements, exceptional.paths, lowering)
    : {
        paths: exceptional.paths.map((path) => ({ ...path, termination: "throw" as const })),
        unknown: false,
      };
  return boundPaths({
    paths: [...tried.paths.filter((path) => path.termination !== "throw"), ...caught.paths],
    unknown: caught.unknown,
  });
}

function exceptionPrefixes(initial: ExecutionPath, paths: readonly ExecutionPath[]): PathResult {
  let result: PathResult = { paths: [], unknown: false };
  for (const path of paths) {
    for (let { length } = initial.events; length <= path.events.length; length += 1) {
      const firstEpoch = path.events[length - 1]?.epoch ?? initial.awaitEpoch;
      const lastEpoch = path.events[length]?.epoch ?? path.awaitEpoch;
      for (let epoch = firstEpoch; epoch <= lastEpoch; epoch += 1) {
        result = boundPaths({
          paths: [
            ...result.paths,
            { events: path.events.slice(0, length), awaitEpoch: epoch, termination: null },
          ],
          unknown: false,
        });
        if (result.unknown) {
          return result;
        }
      }
    }
  }
  return result;
}

function lowerFinally(block: ts.Block, incoming: PathResult, lowering: Lowering): PathResult {
  let result: PathResult = { paths: [], unknown: false };
  for (const path of incoming.paths) {
    const finalized = lowerStatements(block.statements, [{ ...path, termination: null }], lowering);
    result = boundPaths({
      paths: [
        ...result.paths,
        ...finalized.paths.map((next) => ({
          ...next,
          termination: next.termination ?? path.termination,
        })),
      ],
      unknown: finalized.unknown,
    });
    if (result.unknown) {
      return result;
    }
  }
  return result;
}
