import type { RuntimeFunctionLike } from "./ast.js";
import { isRuntimeFunctionLike } from "./ast.js";
import ts from "typescript";

export type FlowProof = "disproven" | "proven" | "unknown";
export type StateFlowCoverage = "complete" | "not-requested" | "unknown";

type RightExecution = "always" | "maybe" | "never";

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

interface Controls {
  left: readonly ControlArm[];
  right: readonly ControlArm[];
}

interface ProofSurface {
  controls: Controls;
  fn: RuntimeFunctionLike;
}

interface Lowering {
  breakable: boolean;
  left: ts.CallExpression;
  right: ts.CallExpression;
}

interface ClauseRun {
  outputs: ExecutionPath[];
  paths: ExecutionPath[];
  unknown: boolean;
}

interface ClauseRunInput {
  clauses: readonly ts.CaseOrDefaultClause[];
  lowering: Lowering;
  paths: readonly ExecutionPath[];
  start: number;
}

const MAX_PATHS = 128;

/**
 * Bounded structural proof that two calls share one normal execution path and
 * synchronous epoch. It proves identical control surfaces and unconditional
 * writes that dominate a controlled write. Unsupported or path-correlated
 * JavaScript returns unknown instead of growing into a general CFG or SSA.
 */
export class StateFlowIndex {
  readonly #coverage = new WeakMap<
    RuntimeFunctionLike,
    Exclude<StateFlowCoverage, "not-requested">
  >();

  public proveSynchronousCoexecution(
    fn: RuntimeFunctionLike,
    left: ts.CallExpression,
    right: ts.CallExpression,
  ): FlowProof {
    const result = proveCoexecution(fn, left, right);
    const previous = this.#coverage.get(fn);
    this.#coverage.set(fn, previous === "unknown" || result === "unknown" ? "unknown" : "complete");
    return result;
  }

  public coverageFor(fn: RuntimeFunctionLike): StateFlowCoverage {
    return this.#coverage.get(fn) ?? "not-requested";
  }
}

function proveCoexecution(
  fn: RuntimeFunctionLike,
  left: ts.CallExpression,
  right: ts.CallExpression,
): FlowProof {
  if (!fn.body || !nodeWithinFunction(left, fn) || !nodeWithinFunction(right, fn)) {
    return "unknown";
  }
  const surface: ProofSurface = {
    controls: { left: controlArms(left, fn), right: controlArms(right, fn) },
    fn,
  };
  const incompatible = incompatibleControlSurfaces(surface.controls);
  if (incompatible) {
    return incompatible;
  }
  const lowering: Lowering = { breakable: false, left, right };
  const initial: ExecutionPath = { awaitEpoch: 0, events: [], termination: null };
  const result = ts.isBlock(fn.body)
    ? lowerStatements(fn.body.statements, [initial], lowering)
    : lowerExpression(fn.body, [initial], lowering);
  return coexecutionProof(result, lowering, surface);
}

function incompatibleControlSurfaces(controls: Controls): FlowProof | null {
  if (haveOppositeSharedArm(controls.left, controls.right)) {
    return "disproven";
  }
  if (
    controls.left.length > 0 &&
    controls.right.length > 0 &&
    !sameControlArms(controls.left, controls.right) &&
    !shareSwitchControl(controls.left, controls.right)
  ) {
    return "unknown";
  }
  return null;
}

function coexecutionProof(
  result: PathResult,
  lowering: Lowering,
  surface: ProofSurface,
): FlowProof {
  if (result.unknown) {
    return "unknown";
  }
  const together = result.paths.filter(
    (path) =>
      path.events.some((event) => event.call === lowering.left) &&
      path.events.some((event) => event.call === lowering.right),
  );
  const synchronous = together.filter((path) =>
    callsShareAwaitEpoch(path, lowering.left, lowering.right),
  );
  if (synchronous.length === 0) {
    return "disproven";
  }
  if (sameControlArms(surface.controls.left, surface.controls.right)) {
    return hasEarlierCorrelatedControlRisk(surface.controls.left, surface.fn)
      ? "unknown"
      : "proven";
  }
  return unconditionalCallPrecedesControlledCall(synchronous, lowering, surface.controls)
    ? "proven"
    : "unknown";
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
  return controls.some((control) => hasEarlierControlAncestor(control.control, boundary));
}

function hasEarlierControlAncestor(control: ts.Node, boundary: RuntimeFunctionLike): boolean {
  let child = control;
  while (child.parent && child !== boundary) {
    const { parent } = child;
    if (ts.isBlock(parent) && blockHasEarlierControl(parent, child)) {
      return true;
    }
    child = parent;
  }
  return false;
}

function blockHasEarlierControl(block: ts.Block, child: ts.Node): boolean {
  const index = block.statements.findIndex(
    (candidate) => candidate === child || nodeContains(candidate, child),
  );
  if (index === -1) {
    return false;
  }
  return block.statements
    .slice(0, index)
    .some((statement) => isPotentiallyCorrelatedControlStatement(statement));
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

function selectBranchPaths(
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

function lowerExpression(
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

function isShortCircuitBinary(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  );
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

function lowerChildren(
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

function controlArms(node: ts.Node, boundary: RuntimeFunctionLike): ControlArm[] {
  const result: ControlArm[] = [];
  for (
    let current: ts.Node = node;
    current.parent && current !== boundary;
    current = current.parent
  ) {
    result.push(...armsFor(current));
  }
  return result;
}

function armsFor(current: ts.Node): ControlArm[] {
  const { parent } = current;
  if (ts.isIfStatement(parent)) {
    return ifArms(current, parent);
  }
  if (ts.isConditionalExpression(parent)) {
    return conditionalArms(current, parent);
  }
  if (isShortCircuitBinary(parent) && current === parent.right) {
    return [{ arm: "right", control: parent, exclusive: false }];
  }
  if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
    return [{ arm: String(parent.getStart()), control: parent.parent.parent, exclusive: false }];
  }
  return [];
}

function ifArms(current: ts.Node, parent: ts.IfStatement): ControlArm[] {
  const arms: ControlArm[] = [];
  if (current === parent.thenStatement) {
    arms.push({ arm: "then", control: parent, exclusive: true });
  }
  if (current === parent.elseStatement) {
    arms.push({ arm: "else", control: parent, exclusive: true });
  }
  return arms;
}

function conditionalArms(current: ts.Node, parent: ts.ConditionalExpression): ControlArm[] {
  const arms: ControlArm[] = [];
  if (current === parent.whenTrue) {
    arms.push({ arm: "true", control: parent, exclusive: true });
  }
  if (current === parent.whenFalse) {
    arms.push({ arm: "false", control: parent, exclusive: true });
  }
  return arms;
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
  lowering: Lowering,
  controls: Controls,
): boolean {
  const uncontrolled = uncontrolledCall(lowering, controls);
  const controlled = controlledCall(uncontrolled, lowering);
  if (!uncontrolled || !controlled) {
    return false;
  }
  return paths.every((path) => callPrecedes(path, uncontrolled, controlled));
}

function uncontrolledCall(lowering: Lowering, controls: Controls): ts.CallExpression | null {
  if (controls.left.length === 0 && controls.right.length > 0) {
    return lowering.left;
  }
  if (controls.right.length === 0 && controls.left.length > 0) {
    return lowering.right;
  }
  return null;
}

function controlledCall(
  uncontrolled: ts.CallExpression | null,
  lowering: Lowering,
): ts.CallExpression | null {
  if (uncontrolled === lowering.left) {
    return lowering.right;
  }
  if (uncontrolled === lowering.right) {
    return lowering.left;
  }
  return null;
}

function callPrecedes(
  path: ExecutionPath,
  uncontrolled: ts.CallExpression,
  controlled: ts.CallExpression,
): boolean {
  const uncontrolledIndex = path.events.findIndex((event) => event.call === uncontrolled);
  const controlledIndex = path.events.findIndex((event) => event.call === controlled);
  return uncontrolledIndex !== -1 && uncontrolledIndex < controlledIndex;
}

function callsShareAwaitEpoch(
  path: ExecutionPath,
  left: ts.CallExpression,
  right: ts.CallExpression,
): boolean {
  let leftEpoch: number | null = null;
  let rightEpoch: number | null = null;
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
  if (ts.isParenthesizedExpression(expression)) {
    return constantBoolean(expression.expression);
  }
  if (isNegation(expression)) {
    const value = constantBoolean(expression.operand);
    return value === null ? null : !value;
  }
  return constantValueBoolean(expression);
}

function isNegation(expression: ts.Expression): expression is ts.PrefixUnaryExpression {
  return (
    ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken
  );
}

function constantValueBoolean(expression: ts.Expression): boolean | null {
  if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(expression)
  ) {
    return false;
  }
  if (isTruthyLiteralExpression(expression)) {
    return true;
  }
  return constantLiteralTextBoolean(expression);
}

function isTruthyLiteralExpression(expression: ts.Expression): boolean {
  return (
    ts.isObjectLiteralExpression(expression) ||
    ts.isArrayLiteralExpression(expression) ||
    ts.isFunctionExpression(expression) ||
    ts.isArrowFunction(expression) ||
    ts.isClassExpression(expression)
  );
}

function constantLiteralTextBoolean(expression: ts.Expression): boolean | null {
  if (ts.isStringLiteralLike(expression)) {
    return expression.text.length > 0;
  }
  if (ts.isNumericLiteral(expression)) {
    return Number(expression.text) !== 0;
  }
  if (ts.isBigIntLiteral(expression)) {
    return expression.text !== "0n";
  }
  return null;
}

function shortCircuitRightExecution(expression: ts.BinaryExpression): RightExecution {
  if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return rightExecutionWhen(constantBoolean(expression.left), true);
  }
  if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return rightExecutionWhen(constantBoolean(expression.left), false);
  }
  return rightExecutionWhen(constantNullish(expression.left), true);
}

function rightExecutionWhen(value: boolean | null, executesWhen: boolean): RightExecution {
  if (value === null) {
    return "maybe";
  }
  return value === executesWhen ? "always" : "never";
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
