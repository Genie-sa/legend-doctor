import ts from "typescript";

import { isRuntimeFunctionLike } from "./ast.js";
import type { RuntimeFunctionLike } from "./ast.js";

export type FlowProof = "disproven" | "proven" | "unknown";
export type StateFlowCoverage = "complete" | "not-requested" | "unknown";

/**
 * Bounded structural proof that two calls share one normal execution path and
 * synchronous epoch. It proves identical control surfaces and unconditional
 * writes that dominate a controlled write. Unsupported or path-correlated
 * JavaScript returns unknown instead of growing into a general CFG or SSA.
 */
export class StateFlowIndex {
  readonly #flows = new WeakMap<RuntimeFunctionLike, FunctionWriteFlow>();
  readonly #coverage = new WeakMap<
    RuntimeFunctionLike,
    Exclude<StateFlowCoverage, "not-requested">
  >();

  proveSynchronousCoexecution(
    fn: RuntimeFunctionLike,
    left: ts.CallExpression,
    right: ts.CallExpression,
  ): FlowProof {
    let flow = this.#flows.get(fn);
    if (!flow) {
      flow = new FunctionWriteFlow(fn);
      this.#flows.set(fn, flow);
    }
    const result = flow.prove(left, right),
      previous = this.#coverage.get(fn);
    this.#coverage.set(fn, previous === "unknown" || result === "unknown" ? "unknown" : "complete");
    return result;
  }

  coverageFor(fn: RuntimeFunctionLike): StateFlowCoverage {
    return this.#coverage.get(fn) ?? "not-requested";
  }
}

interface ExecutionPath {
  awaitEpoch: number;
  events: { call: ts.CallExpression; epoch: number }[];
  termination: "break" | "return" | null;
}

interface PathResult {
  paths: ExecutionPath[];
  unknown: boolean;
}

interface ControlArm {
  arm: string;
  control: ts.Node;
  exclusive: boolean;
}

interface StatementContext {
  breakable: boolean;
}

const MAX_PATHS = 128;

class FunctionWriteFlow {
  readonly #body: ts.ConciseBody | undefined;

  constructor(private readonly fn: RuntimeFunctionLike) {
    this.#body = fn.body;
  }

  prove(left: ts.CallExpression, right: ts.CallExpression): FlowProof {
    if (!this.#body || !nodeWithinFunction(left, this.fn) || !nodeWithinFunction(right, this.fn)) {
      return "unknown";
    }
    const leftControls = controlArms(left, this.fn),
      rightControls = controlArms(right, this.fn);
    if (haveOppositeSharedArm(leftControls, rightControls)) {
      return "disproven";
    }
    if (
      leftControls.length > 0 &&
      rightControls.length > 0 &&
      !sameControlArms(leftControls, rightControls) &&
      !shareSwitchControl(leftControls, rightControls)
    ) {
      return "unknown";
    }

    const initial: ExecutionPath = { awaitEpoch: 0, events: [], termination: null },
      result = ts.isBlock(this.#body)
        ? lowerStatements(this.#body.statements, [initial], { breakable: false }, left, right)
        : lowerExpression(this.#body, [initial], left, right);
    if (result.unknown) {
      return "unknown";
    }
    const together = result.paths.filter(
      (path) =>
        path.events.some((event) => event.call === left) &&
        path.events.some((event) => event.call === right),
    );
    if (together.length === 0) {
      return "disproven";
    }
    const synchronous = together.filter((path) => callsShareAwaitEpoch(path, left, right));
    if (synchronous.length === 0) {
      return "disproven";
    }
    if (sameControlArms(leftControls, rightControls)) {
      return hasEarlierCorrelatedControlRisk(leftControls, this.fn) ? "unknown" : "proven";
    }
    return unconditionalCallPrecedesControlledCall(
      synchronous,
      left,
      right,
      leftControls,
      rightControls,
    )
      ? "proven"
      : "unknown";
  }
}

/**
 * Successive dynamic controls are enumerated independently. Until the lowerer
 * tracks predicate identity, an earlier control surface makes a later shared
 * arm an unsafe co-execution proof even when both calls appear in that arm.
 */
function hasEarlierCorrelatedControlRisk(
  controls: readonly ControlArm[],
  boundary: RuntimeFunctionLike,
): boolean {
  for (const control of controls) {
    let child: ts.Node = control.control;
    for (
      let { parent } = child;
      parent && child !== boundary;
      child = parent, parent = parent.parent
    ) {
      if (!ts.isBlock(parent)) {
        continue;
      }
      const statement = parent.statements.find(
        (candidate) => candidate === child || nodeContains(candidate, child),
      );
      if (!statement) {
        continue;
      }
      const index = parent.statements.indexOf(statement);
      if (parent.statements.slice(0, index).some(isPotentiallyCorrelatedControlStatement)) {
        return true;
      }
    }
  }
  return false;
}

function isPotentiallyCorrelatedControlStatement(statement: ts.Statement): boolean {
  return (
    ts.isIfStatement(statement) ||
    ts.isSwitchStatement(statement) ||
    ts.isTryStatement(statement) ||
    ts.isForStatement(statement) ||
    ts.isForInStatement(statement) ||
    ts.isForOfStatement(statement) ||
    ts.isWhileStatement(statement) ||
    ts.isDoStatement(statement)
  );
}

function nodeContains(ancestor: ts.Node, node: ts.Node): boolean {
  return node.pos >= ancestor.pos && node.end <= ancestor.end;
}

function lowerStatements(
  statements: readonly ts.Statement[],
  incoming: readonly ExecutionPath[],
  context: StatementContext,
  left: ts.CallExpression,
  right: ts.CallExpression,
): PathResult {
  let paths = clonePaths(incoming),
    unknown = false;
  for (const statement of statements) {
    const active = paths.filter((path) => path.termination === null),
      finished = paths.filter((path) => path.termination !== null);
    if (active.length === 0) {
      break;
    }
    const result = lowerStatement(statement, active, context, left, right);
    unknown ||= result.unknown;
    paths = [...finished, ...result.paths];
    if (paths.length > MAX_PATHS) {
      return { paths: paths.slice(0, MAX_PATHS), unknown: true };
    }
  }
  return { paths, unknown };
}

function lowerStatement(
  statement: ts.Statement,
  incoming: readonly ExecutionPath[],
  context: StatementContext,
  left: ts.CallExpression,
  right: ts.CallExpression,
): PathResult {
  if (ts.isBlock(statement)) {
    return lowerStatements(statement.statements, incoming, context, left, right);
  }
  if (ts.isExpressionStatement(statement)) {
    return lowerExpression(statement.expression, incoming, left, right);
  }
  if (ts.isVariableStatement(statement)) {
    let result: PathResult = { paths: clonePaths(incoming), unknown: false };
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer || isRuntimeFunctionLike(declaration.initializer)) {
        continue;
      }
      const next = lowerExpression(declaration.initializer, result.paths, left, right);
      result = { paths: next.paths, unknown: result.unknown || next.unknown };
    }
    return result;
  }
  if (ts.isIfStatement(statement)) {
    const condition = lowerExpression(statement.expression, incoming, left, right),
      thenResult = lowerStatement(statement.thenStatement, condition.paths, context, left, right),
      elseResult = statement.elseStatement
        ? lowerStatement(statement.elseStatement, condition.paths, context, left, right)
        : { paths: clonePaths(condition.paths), unknown: false },
      constant = constantBoolean(statement.expression);
    return {
      paths:
        constant === true
          ? thenResult.paths
          : constant === false
            ? elseResult.paths
            : [...thenResult.paths, ...elseResult.paths],
      unknown: condition.unknown || thenResult.unknown || elseResult.unknown,
    };
  }
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
    const result = statement.expression
      ? lowerExpression(statement.expression, incoming, left, right)
      : { paths: clonePaths(incoming), unknown: false };
    return {
      paths: result.paths.map((path) => ({ ...path, termination: "return" })),
      unknown: result.unknown,
    };
  }
  if (ts.isBreakStatement(statement)) {
    if (statement.label || !context.breakable) {
      return { paths: clonePaths(incoming), unknown: true };
    }
    return { paths: incoming.map((path) => ({ ...path, termination: "break" })), unknown: false };
  }
  if (ts.isSwitchStatement(statement)) {
    return lowerSwitch(statement, incoming, left, right);
  }
  if (ts.isFunctionDeclaration(statement) || ts.isEmptyStatement(statement)) {
    return { paths: clonePaths(incoming), unknown: false };
  }
  if (
    ts.isForStatement(statement) ||
    ts.isForInStatement(statement) ||
    ts.isForOfStatement(statement) ||
    ts.isWhileStatement(statement) ||
    ts.isDoStatement(statement) ||
    ts.isTryStatement(statement) ||
    ts.isWithStatement(statement) ||
    ts.isLabeledStatement(statement) ||
    ts.isContinueStatement(statement)
  ) {
    return { paths: clonePaths(incoming), unknown: true };
  }
  return lowerChildren(statement, incoming, left, right);
}

function lowerSwitch(
  statement: ts.SwitchStatement,
  incoming: readonly ExecutionPath[],
  left: ts.CallExpression,
  right: ts.CallExpression,
): PathResult {
  const discriminant = lowerExpression(statement.expression, incoming, left, right);
  let { unknown } = discriminant;
  const outputs: ExecutionPath[] = [],
    { clauses } = statement.caseBlock;
  for (let start = 0; start < clauses.length; start += 1) {
    let paths = clonePaths(discriminant.paths);
    for (let index = start; index < clauses.length; index += 1) {
      const clause = clauses[index];
      if (!clause) {
        continue;
      }
      if (ts.isCaseClause(clause) && !isInertCaseExpression(clause.expression)) {
        unknown = true;
      }
      const result = lowerStatements(
        clause.statements,
        paths.map((path) => ({ ...path, termination: null })),
        { breakable: true },
        left,
        right,
      );
      unknown ||= result.unknown;
      const broken = result.paths.filter((path) => path.termination === "break"),
        returned = result.paths.filter((path) => path.termination === "return");
      outputs.push(...broken.map((path) => ({ ...path, termination: null })), ...returned);
      paths = result.paths.filter((path) => path.termination === null);
      if (paths.length === 0) {
        break;
      }
    }
    outputs.push(...paths);
  }
  if (!clauses.some(ts.isDefaultClause)) {
    outputs.push(...clonePaths(discriminant.paths));
  }
  return { paths: outputs, unknown };
}

function lowerExpression(
  expression: ts.Expression,
  incoming: readonly ExecutionPath[],
  left: ts.CallExpression,
  right: ts.CallExpression,
): PathResult {
  if (isRuntimeFunctionLike(expression)) {
    return { paths: clonePaths(incoming), unknown: false };
  }
  if (ts.isParenthesizedExpression(expression)) {
    return lowerExpression(expression.expression, incoming, left, right);
  }
  if (ts.isConditionalExpression(expression)) {
    const condition = lowerExpression(expression.condition, incoming, left, right),
      whenTrue = lowerExpression(expression.whenTrue, condition.paths, left, right),
      whenFalse = lowerExpression(expression.whenFalse, condition.paths, left, right),
      constant = constantBoolean(expression.condition);
    return {
      paths:
        constant === true
          ? whenTrue.paths
          : constant === false
            ? whenFalse.paths
            : [...whenTrue.paths, ...whenFalse.paths],
      unknown: condition.unknown || whenTrue.unknown || whenFalse.unknown,
    };
  }
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    const leftResult = lowerExpression(expression.left, incoming, left, right),
      rightResult = lowerExpression(expression.right, leftResult.paths, left, right),
      rightExecution = shortCircuitRightExecution(expression);
    return {
      paths:
        rightExecution === "always"
          ? rightResult.paths
          : rightExecution === "never"
            ? leftResult.paths
            : [...clonePaths(leftResult.paths), ...rightResult.paths],
      unknown: leftResult.unknown || rightResult.unknown,
    };
  }
  if (ts.isAwaitExpression(expression)) {
    const result = lowerExpression(expression.expression, incoming, left, right);
    return {
      paths: result.paths.map((path) => ({ ...path, awaitEpoch: path.awaitEpoch + 1 })),
      unknown: result.unknown,
    };
  }
  if (ts.isYieldExpression(expression)) {
    const result = expression.expression
      ? lowerExpression(expression.expression, incoming, left, right)
      : { paths: clonePaths(incoming), unknown: false };
    return {
      paths: result.paths.map((path) => ({ ...path, awaitEpoch: path.awaitEpoch + 1 })),
      unknown: result.unknown,
    };
  }
  if (ts.isCallExpression(expression)) {
    if (expression.questionDotToken) {
      return { paths: clonePaths(incoming), unknown: true };
    }
    let result = lowerExpression(expression.expression, incoming, left, right);
    for (const argument of expression.arguments) {
      if (isRuntimeFunctionLike(argument)) {
        continue;
      }
      const next = lowerExpression(argument, result.paths, left, right);
      result = { paths: next.paths, unknown: result.unknown || next.unknown };
    }
    if (expression === left || expression === right) {
      result = {
        ...result,
        paths: result.paths.map((path) => ({
          ...path,
          events: [...path.events, { call: expression, epoch: path.awaitEpoch }],
        })),
      };
    }
    return result;
  }
  return lowerChildren(expression, incoming, left, right);
}

function lowerChildren(
  node: ts.Node,
  incoming: readonly ExecutionPath[],
  left: ts.CallExpression,
  right: ts.CallExpression,
): PathResult {
  let result: PathResult = { paths: clonePaths(incoming), unknown: false };
  node.forEachChild((child) => {
    if (isRuntimeFunctionLike(child)) {
      return;
    }
    const next = ts.isExpression(child)
      ? lowerExpression(child, result.paths, left, right)
      : lowerChildren(child, result.paths, left, right);
    result = { paths: next.paths, unknown: result.unknown || next.unknown };
  });
  return result;
}

function controlArms(node: ts.Node, boundary: RuntimeFunctionLike): ControlArm[] {
  const result: ControlArm[] = [];
  for (
    let current: ts.Node = node;
    current.parent && current !== boundary;
    current = current.parent
  ) {
    const { parent } = current;
    if (ts.isIfStatement(parent)) {
      if (current === parent.thenStatement) {
        result.push({ arm: "then", control: parent, exclusive: true });
      }
      if (current === parent.elseStatement) {
        result.push({ arm: "else", control: parent, exclusive: true });
      }
    } else if (ts.isConditionalExpression(parent)) {
      if (current === parent.whenTrue) {
        result.push({ arm: "true", control: parent, exclusive: true });
      }
      if (current === parent.whenFalse) {
        result.push({ arm: "false", control: parent, exclusive: true });
      }
    } else if (
      ts.isBinaryExpression(parent) &&
      current === parent.right &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      result.push({ arm: "right", control: parent, exclusive: false });
    } else if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
      result.push({
        arm: String(parent.getStart()),
        control: parent.parent.parent,
        exclusive: false,
      });
    }
  }
  return result;
}

function haveOppositeSharedArm(left: readonly ControlArm[], right: readonly ControlArm[]): boolean {
  return left.some(
    (leftArm) =>
      leftArm.exclusive &&
      right.some(
        (rightArm) =>
          rightArm.exclusive &&
          leftArm.control === rightArm.control &&
          leftArm.arm !== rightArm.arm,
      ),
  );
}

function sameControlArms(left: readonly ControlArm[], right: readonly ControlArm[]): boolean {
  return (
    left.length === right.length &&
    left.every((leftArm) =>
      right.some(
        (rightArm) => leftArm.control === rightArm.control && leftArm.arm === rightArm.arm,
      ),
    )
  );
}

function shareSwitchControl(left: readonly ControlArm[], right: readonly ControlArm[]): boolean {
  return left.some(
    (leftArm) =>
      !leftArm.exclusive &&
      right.some((rightArm) => !rightArm.exclusive && leftArm.control === rightArm.control),
  );
}

function unconditionalCallPrecedesControlledCall(
  paths: readonly ExecutionPath[],
  left: ts.CallExpression,
  right: ts.CallExpression,
  leftControls: readonly ControlArm[],
  rightControls: readonly ControlArm[],
): boolean {
  const uncontrolled =
    leftControls.length === 0 && rightControls.length > 0
      ? left
      : rightControls.length === 0 && leftControls.length > 0
        ? right
        : null;
  const controlled = uncontrolled === left ? right : uncontrolled === right ? left : null;
  if (!uncontrolled || !controlled) {
    return false;
  }
  return paths.every((path) => {
    const uncontrolledIndex = path.events.findIndex((event) => event.call === uncontrolled),
      controlledIndex = path.events.findIndex((event) => event.call === controlled);
    return uncontrolledIndex !== -1 && uncontrolledIndex < controlledIndex;
  });
}

function callsShareAwaitEpoch(
  path: ExecutionPath,
  left: ts.CallExpression,
  right: ts.CallExpression,
): boolean {
  let leftEpoch: number | null = null,
    rightEpoch: number | null = null;
  for (const event of path.events) {
    if (event.call === left) {
      leftEpoch = event.epoch;
    }
    if (event.call === right) {
      rightEpoch = event.epoch;
    }
  }
  return leftEpoch !== null && rightEpoch !== null && leftEpoch === rightEpoch;
}

function clonePaths(paths: readonly ExecutionPath[]): ExecutionPath[] {
  return paths.map((path) => ({ ...path, events: path.events.map((event) => ({ ...event })) }));
}

function nodeWithinFunction(node: ts.Node, fn: RuntimeFunctionLike): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === fn) {
      return true;
    }
    if (current !== node && isRuntimeFunctionLike(current)) {
      return false;
    }
  }
  return false;
}

function constantBoolean(expression: ts.Expression): boolean | null {
  if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expression.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (expression.kind === ts.SyntaxKind.NullKeyword) {
    return false;
  }
  if (ts.isStringLiteralLike(expression)) {
    return expression.text.length > 0;
  }
  if (ts.isNumericLiteral(expression)) {
    return Number(expression.text) !== 0;
  }
  if (ts.isBigIntLiteral(expression)) {
    return expression.text !== "0n";
  }
  if (
    ts.isObjectLiteralExpression(expression) ||
    ts.isArrayLiteralExpression(expression) ||
    ts.isFunctionExpression(expression) ||
    ts.isArrowFunction(expression) ||
    ts.isClassExpression(expression)
  ) {
    return true;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return constantBoolean(expression.expression);
  }
  if (ts.isVoidExpression(expression)) {
    return false;
  }
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    const value = constantBoolean(expression.operand);
    return value === null ? null : !value;
  }
  return null;
}

function shortCircuitRightExecution(expression: ts.BinaryExpression): "always" | "maybe" | "never" {
  const leftBoolean = constantBoolean(expression.left);
  if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return leftBoolean === true ? "always" : leftBoolean === false ? "never" : "maybe";
  }
  if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return leftBoolean === false ? "always" : leftBoolean === true ? "never" : "maybe";
  }
  const leftNullish = constantNullish(expression.left);
  return leftNullish === true ? "always" : leftNullish === false ? "never" : "maybe";
}

function constantNullish(expression: ts.Expression): boolean | null {
  if (expression.kind === ts.SyntaxKind.NullKeyword) {
    return true;
  }
  if (
    ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isObjectLiteralExpression(expression) ||
    ts.isArrayLiteralExpression(expression) ||
    ts.isFunctionExpression(expression) ||
    ts.isArrowFunction(expression) ||
    ts.isClassExpression(expression)
  ) {
    return false;
  }
  return ts.isParenthesizedExpression(expression) ? constantNullish(expression.expression) : null;
}

function isInertCaseExpression(expression: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword ||
    ts.isIdentifier(expression) ||
    ts.isPropertyAccessExpression(expression)
  );
}
