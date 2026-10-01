import type { SetterMutation, StateCandidate } from "../model.js";
import { calleeName, visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";
import type { SourceAnalysis } from "../proofs/contracts.js";
import { collectSetterMutations } from "../companion-writes.js";
import ts from "typescript";

/**
 * React 19 commits the updates of one synchronous stretch in one render, `useValue` notifications
 * included, so co-writes that always share a stretch already publish atomically. A transition owner
 * may not.
 */
export function cowritesShareOneStretch(
  members: readonly StateCandidate[],
  { commitSensitiveOwners, stateFlow }: SourceAnalysis,
): boolean {
  const [first] = members;
  if (!first || commitSensitiveOwners.has(first.owner)) {
    return false;
  }
  const mutations = collectSetterMutations(first.owner, members);
  return mutations.every((left, index) =>
    mutations
      .slice(index + 1)
      .every(
        (right) =>
          left.state === right.state ||
          left.region !== right.region ||
          (stateFlow.proveSynchronousCoexecution(left.region, left.call, right.call) !==
            "unknown" &&
            !commitsBetween(left, right)),
      ),
  );
}

/** The flow proof needs only one shared path; an `await` or a `flushSync` between still splits. */
function commitsBetween(
  { call: left, region }: SetterMutation,
  { call: right }: SetterMutation,
): boolean {
  const start = Math.min(left.getStart(), right.getStart());
  const end = Math.max(left.getStart(), right.getStart());
  let splits = false;
  visitSkippingNestedRuntimeFunctions(region, (node) => {
    splits ||=
      node.getStart() > start &&
      node.getStart() < end &&
      (ts.isAwaitExpression(node) ||
        (ts.isCallExpression(node) && calleeName(node.expression) === "flushSync"));
  });
  return splits;
}
