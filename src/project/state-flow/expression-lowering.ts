import type { ExecutionPath, Lowering, PathResult, RightExecution } from "./model.js";
import {
  constantBoolean,
  isShortCircuitBinary,
  shortCircuitRightExecution,
} from "./constant-conditions.js";
import { isRuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";

export function selectBranchPaths(
  constant: boolean | null,
  whenTrue: ExecutionPath[],
  whenFalse: ExecutionPath[],
): ExecutionPath[] {
  if (constant === true) {
    return whenTrue;
  }
  if (constant === false) {
    return whenFalse;
  }
  return [...whenTrue, ...whenFalse];
}

export function lowerExpression(
  expression: ts.Expression,
  incoming: readonly ExecutionPath[],
  lowering: Lowering,
): PathResult {
  return (
    lowerBranchingExpression(expression, incoming, lowering) ??
    lowerSuspendingExpression(expression, incoming, lowering) ??
    lowerChildren(expression, incoming, lowering)
  );
}

function lowerBranchingExpression(
  expression: ts.Expression,
  incoming: readonly ExecutionPath[],
  lowering: Lowering,
): PathResult | null {
  if (isRuntimeFunctionLike(expression)) {
    return { paths: clonePaths(incoming), unknown: false };
  }
  if (ts.isParenthesizedExpression(expression)) {
    return lowerExpression(expression.expression, incoming, lowering);
  }
  if (ts.isConditionalExpression(expression)) {
    return lowerConditional(expression, incoming, lowering);
  }
  if (isShortCircuitBinary(expression)) {
    return lowerShortCircuit(expression, incoming, lowering);
  }
  return null;
}

function lowerSuspendingExpression(
  expression: ts.Expression,
  incoming: readonly ExecutionPath[],
  lowering: Lowering,
): PathResult | null {
  if (ts.isAwaitExpression(expression)) {
    return advanceEpoch(lowerExpression(expression.expression, incoming, lowering));
  }
  if (ts.isYieldExpression(expression)) {
    return advanceEpoch(
      expression.expression
        ? lowerExpression(expression.expression, incoming, lowering)
        : { paths: clonePaths(incoming), unknown: false },
    );
  }
  if (ts.isCallExpression(expression)) {
    return lowerCall(expression, incoming, lowering);
  }
  return null;
}

function lowerConditional(
  expression: ts.ConditionalExpression,
  incoming: readonly ExecutionPath[],
  lowering: Lowering,
): PathResult {
  const condition = lowerExpression(expression.condition, incoming, lowering);
  const whenTrue = lowerExpression(expression.whenTrue, condition.paths, lowering);
  const whenFalse = lowerExpression(expression.whenFalse, condition.paths, lowering);
  return {
    paths: selectBranchPaths(
      constantBoolean(expression.condition),
      whenTrue.paths,
      whenFalse.paths,
    ),
    unknown: condition.unknown || whenTrue.unknown || whenFalse.unknown,
  };
}

function lowerShortCircuit(
  expression: ts.BinaryExpression,
  incoming: readonly ExecutionPath[],
  lowering: Lowering,
): PathResult {
  const leftResult = lowerExpression(expression.left, incoming, lowering);
  const rightResult = lowerExpression(expression.right, leftResult.paths, lowering);
  return {
    paths: selectShortCircuitPaths(
      shortCircuitRightExecution(expression),
      leftResult.paths,
      rightResult.paths,
    ),
    unknown: leftResult.unknown || rightResult.unknown,
  };
}

function selectShortCircuitPaths(
  execution: RightExecution,
  leftPaths: ExecutionPath[],
  rightPaths: ExecutionPath[],
): ExecutionPath[] {
  if (execution === "always") {
    return rightPaths;
  }
  if (execution === "never") {
    return leftPaths;
  }
  return [...clonePaths(leftPaths), ...rightPaths];
}

function advanceEpoch(result: PathResult): PathResult {
  return {
    paths: result.paths.map((path) => ({ ...path, awaitEpoch: path.awaitEpoch + 1 })),
    unknown: result.unknown,
  };
}

function lowerCall(
  expression: ts.CallExpression,
  incoming: readonly ExecutionPath[],
  lowering: Lowering,
): PathResult {
  if (expression.questionDotToken) {
    return { paths: clonePaths(incoming), unknown: true };
  }
  let result = lowerExpression(expression.expression, incoming, lowering);
  for (const argument of expression.arguments) {
    if (isRuntimeFunctionLike(argument)) {
      continue;
    }
    const next = lowerExpression(argument, result.paths, lowering);
    result = { paths: next.paths, unknown: result.unknown || next.unknown };
  }
  return expression === lowering.left || expression === lowering.right
    ? recordCallEvent(result, expression)
    : result;
}

function recordCallEvent(result: PathResult, call: ts.CallExpression): PathResult {
  return {
    ...result,
    paths: result.paths.map((path) => ({
      ...path,
      events: [...path.events, { call, epoch: path.awaitEpoch }],
    })),
  };
}

export function lowerChildren(
  node: ts.Node,
  incoming: readonly ExecutionPath[],
  lowering: Lowering,
): PathResult {
  let result: PathResult = { paths: clonePaths(incoming), unknown: false };
  node.forEachChild((child) => {
    if (isRuntimeFunctionLike(child)) {
      return;
    }
    const next = ts.isExpression(child)
      ? lowerExpression(child, result.paths, lowering)
      : lowerChildren(child, result.paths, lowering);
    result = { paths: next.paths, unknown: result.unknown || next.unknown };
  });
  return result;
}

export function clonePaths(paths: readonly ExecutionPath[]): ExecutionPath[] {
  return paths.map((path) => ({ ...path, events: path.events.map((event) => ({ ...event })) }));
}
