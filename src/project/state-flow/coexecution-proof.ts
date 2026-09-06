import type {
  ControlArm,
  Controls,
  ExecutionPath,
  FlowProof,
  Lowering,
  PathResult,
  ProofSurface,
} from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { sameControlArms } from "./control-arms.js";
import ts from "typescript";

export function coexecutionProof(
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
