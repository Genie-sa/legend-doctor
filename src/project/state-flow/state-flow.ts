import type {
  Controls,
  ExecutionPath,
  FlowProof,
  Lowering,
  ProofSurface,
  StateFlowCoverage,
} from "./model.js";
import {
  controlArms,
  haveOppositeSharedArm,
  sameControlArms,
  shareSwitchControl,
} from "./control-arms.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { coexecutionProof } from "./coexecution-proof.js";
import { isRuntimeFunctionLike } from "../../core/ast.js";
import { lowerExpression } from "./expression-lowering.js";
import { lowerStatements } from "./statement-lowering.js";
import ts from "typescript";

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
    ? lowerStatements(relevantStatements(fn.body, left, right), [initial], lowering)
    : lowerExpression(fn.body, [initial], lowering);
  return coexecutionProof(result, lowering, surface);
}

/** Later statements cannot undo earlier calls. Keep the entire prefix and the containing
 * statement, including its catch/finally: this is an ordering proof, not dead-code removal. */
function relevantStatements(
  body: ts.Block,
  left: ts.CallExpression,
  right: ts.CallExpression,
): readonly ts.Statement[] {
  const last = Math.max(left.end, right.end);
  const index = body.statements.findIndex((statement) => statement.end >= last);
  return index === -1 ? body.statements : body.statements.slice(0, index + 1);
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
