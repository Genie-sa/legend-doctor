import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isPromiseContinuationCallback } from "./pending-command.js";
import { isRuntimeFunctionLike } from "../../core/ast.js";
import { localFunctionBinding } from "../state-proofs/binding-lookup.js";
import ts from "typescript";

interface OwnerStateWriteScan {
  before: number;
  owner: RuntimeFunctionLike;
  ownerSetters: ReadonlySet<string>;
  seen: ReadonlySet<string>;
  skipPromiseContinuations?: boolean;
}

export function containsOwnerStateWrite(root: ts.Node, scan: OwnerStateWriteScan): boolean {
  let found = false;
  const visitNode = (node: ts.Node): void => {
    if (found || node.getStart() >= scan.before) {
      return;
    }
    if (isRuntimeFunctionLike(node) && node !== root) {
      return;
    }
    if (ts.isCallExpression(node) && callWritesOwnerState(node, scan)) {
      found = true;
      return;
    }
    node.forEachChild(visitNode);
  };
  visitNode(root);
  return found;
}

function callWritesOwnerState(call: ts.CallExpression, scan: OwnerStateWriteScan): boolean {
  return (
    calleeWritesOwnerState(call, scan) ||
    call.arguments.some(
      (argument) =>
        (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) &&
        (!scan.skipPromiseContinuations || !isPromiseContinuationCallback(argument)) &&
        containsOwnerStateWrite(argument.body, {
          before: argument.body.end,
          owner: scan.owner,
          ownerSetters: scan.ownerSetters,
          seen: scan.seen,
          skipPromiseContinuations: scan.skipPromiseContinuations ?? false,
        }),
    )
  );
}

function calleeWritesOwnerState(call: ts.CallExpression, scan: OwnerStateWriteScan): boolean {
  const callee = call.expression;
  if (!ts.isIdentifier(callee)) {
    return false;
  }
  if (scan.ownerSetters.has(callee.text)) {
    return true;
  }
  const body = localFunctionBinding(scan.owner, callee.text)?.body;
  if (body === undefined || scan.seen.has(callee.text)) {
    return false;
  }
  return containsOwnerStateWrite(body, {
    before: body.end,
    owner: scan.owner,
    ownerSetters: scan.ownerSetters,
    seen: new Set(scan.seen).add(callee.text),
  });
}
