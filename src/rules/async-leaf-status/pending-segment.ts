import type { AsyncLeafCallSites, CommandRegion, PendingCommand } from "./model.js";
import {
  asyncCommandRegion,
  isPromiseContinuationCallback,
  nearestMutationFunction,
} from "./pending-command.js";
import {
  findAncestorUntil,
  isRuntimeFunctionLike,
  nodeWithin,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import { EMPTY_SEEN } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateUsage } from "../../analysis/model.js";
import { containsOwnerStateWrite } from "./owner-state-writes.js";
import { localFunctionBinding } from "../state-proofs/binding-lookup.js";
import ts from "typescript";

interface PendingSegmentProof {
  command: PendingCommand;
  leaves: AsyncLeafCallSites;
  owner: RuntimeFunctionLike;
  usage: StateUsage;
}

interface AsyncSegmentScan {
  owner: RuntimeFunctionLike;
  ownerSetters: ReadonlySet<string>;
  requiresUnconditionalAwait: boolean;
  setterCalls: readonly ts.CallExpression[];
}

interface FollowingWriteScan {
  after: number;
  owner: RuntimeFunctionLike;
  ownerSetters: ReadonlySet<string>;
  root: ts.ConciseBody | undefined;
}

interface EarlierWriteScan {
  owner: RuntimeFunctionLike;
  ownerSetters: ReadonlySet<string>;
  pendingStart: ts.CallExpression;
  region: CommandRegion;
}

export function isProvenPendingSegment(proof: PendingSegmentProof): boolean {
  const { command, leaves, owner, usage } = proof;
  const { ownerSetters, pendingStart, region } = command;
  return (
    nearestMutationFunction(pendingStart, owner) === region &&
    startsAsyncCommandSegment(pendingStart, {
      owner,
      ownerSetters,
      requiresUnconditionalAwait: leaves.requiresUnconditionalAwait,
      setterCalls: usage.setterCallNodes,
    }) &&
    !hasEarlierOwnerStateWrite({ owner, ownerSetters, pendingStart, region }) &&
    usage.setterCallNodes.some(
      (call) =>
        call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword &&
        asyncCommandRegion(call, owner) === region &&
        call.getStart() > pendingStart.getStart(),
    )
  );
}

function startsAsyncCommandSegment(call: ts.CallExpression, scan: AsyncSegmentScan): boolean {
  const following = statementsAfterCall(call);
  if (!following) {
    return false;
  }
  for (const candidate of following) {
    const verdict = segmentBoundaryVerdict(candidate, call, scan);
    if (verdict !== null) {
      return verdict;
    }
  }
  return false;
}

function statementsAfterCall(call: ts.CallExpression): readonly ts.Statement[] | null {
  const statement = call.parent;
  const block = statement.parent;
  if (!ts.isExpressionStatement(statement) || !ts.isBlock(block)) {
    return null;
  }
  const index = block.statements.indexOf(statement);
  return index === -1 ? null : block.statements.slice(index + 1);
}

function segmentBoundaryVerdict(
  candidate: ts.Statement,
  call: ts.CallExpression,
  scan: AsyncSegmentScan,
): boolean | null {
  const { owner, ownerSetters, requiresUnconditionalAwait, setterCalls } = scan;
  const awaitExpression = firstAwaitExpression(candidate);
  const awaitPosition = awaitExpression?.getStart() ?? null;
  const promiseBoundary = containsPromiseCompletionReset(candidate, setterCalls);
  const boundary = awaitPosition ?? (promiseBoundary ? candidate.end : null);
  if (boundary === null) {
    return containsOwnerStateWrite(candidate, {
      before: candidate.end,
      owner,
      ownerSetters,
      seen: EMPTY_SEEN,
    }) || containsEarlyExit(candidate, candidate.end)
      ? false
      : null;
  }
  return (
    (!requiresUnconditionalAwait ||
      awaitExpression === null ||
      awaitIsUnconditionallyReached(awaitExpression, candidate)) &&
    !containsOwnerStateWrite(candidate, {
      before: boundary,
      owner,
      ownerSetters,
      seen: EMPTY_SEEN,
      skipPromiseContinuations: awaitPosition === null,
    }) &&
    !containsEarlyExit(candidate, boundary) &&
    (!promiseBoundary ||
      !hasFollowingSynchronousOwnerWrite({
        after: candidate.end,
        owner,
        ownerSetters,
        root: nearestMutationFunction(call, owner).body,
      }))
  );
}

function hasFollowingSynchronousOwnerWrite(scan: FollowingWriteScan): boolean {
  const { after, root } = scan;
  if (!root) {
    return true;
  }
  let found = false;
  const visitNode = (node: ts.Node): void => {
    if (found || node.end <= after) {
      return;
    }
    if (isRuntimeFunctionLike(node) && node !== root) {
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.getStart() > after &&
      callWritesOwnerStateAfter(node, scan)
    ) {
      found = true;
      return;
    }
    node.forEachChild(visitNode);
  };
  visitNode(root);
  return found;
}

function callWritesOwnerStateAfter(call: ts.CallExpression, scan: FollowingWriteScan): boolean {
  const callee = call.expression;
  if (!ts.isIdentifier(callee)) {
    return false;
  }
  if (scan.ownerSetters.has(callee.text)) {
    return true;
  }
  const body = localFunctionBinding(scan.owner, callee.text)?.body;
  return (
    body !== undefined &&
    containsOwnerStateWrite(body, {
      before: body.end,
      owner: scan.owner,
      ownerSetters: scan.ownerSetters,
      seen: EMPTY_SEEN,
    })
  );
}

function firstAwaitExpression(statement: ts.Statement): ts.AwaitExpression | null {
  let first: ts.AwaitExpression | null = null;
  visitSkippingNestedRuntimeFunctions(statement, (node) => {
    if (ts.isAwaitExpression(node) && (first === null || node.getStart() < first.getStart())) {
      first = node;
    }
  });
  return first;
}

function awaitIsUnconditionallyReached(
  awaitExpression: ts.AwaitExpression,
  boundary: ts.Statement,
): boolean {
  for (let current: ts.Node = awaitExpression; current !== boundary; current = current.parent) {
    const { parent } = current;
    if (
      (ts.isIfStatement(parent) &&
        (nodeWithin(awaitExpression, parent.thenStatement) ||
          (parent.elseStatement !== undefined &&
            nodeWithin(awaitExpression, parent.elseStatement)))) ||
      (ts.isConditionalExpression(parent) &&
        (nodeWithin(awaitExpression, parent.whenTrue) ||
          nodeWithin(awaitExpression, parent.whenFalse))) ||
      (ts.isBinaryExpression(parent) &&
        isShortCircuitOperator(parent.operatorToken.kind) &&
        nodeWithin(awaitExpression, parent.right)) ||
      ts.isIterationStatement(parent, false) ||
      ts.isCaseOrDefaultClause(parent) ||
      ts.isCatchClause(parent)
    ) {
      return false;
    }
  }
  return true;
}

function isShortCircuitOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

function containsPromiseCompletionReset(
  statement: ts.Statement,
  setterCalls: readonly ts.CallExpression[],
): boolean {
  return setterCalls.some((candidate) => {
    if (
      candidate.arguments[0]?.kind !== ts.SyntaxKind.FalseKeyword ||
      !nodeWithin(candidate, statement)
    ) {
      return false;
    }
    const continuation = findAncestorUntil(candidate, isRuntimeFunctionLike, statement);
    return continuation !== null && isPromiseContinuationCallback(continuation);
  });
}

function hasEarlierOwnerStateWrite(scan: EarlierWriteScan): boolean {
  const { owner, ownerSetters, pendingStart, region } = scan;
  if (!region.body) {
    return true;
  }
  return containsOwnerStateWrite(region.body, {
    before: pendingStart.getStart(),
    owner,
    ownerSetters,
    seen: EMPTY_SEEN,
  });
}

function containsEarlyExit(root: ts.Node, before: number): boolean {
  let found = false;
  const scan = (node: ts.Node): void => {
    if (found || node.getStart() >= before) {
      return;
    }
    if (isRuntimeFunctionLike(node) && node !== root) {
      return;
    }
    if (
      ts.isReturnStatement(node) ||
      ts.isThrowStatement(node) ||
      ts.isBreakStatement(node) ||
      ts.isContinueStatement(node)
    ) {
      found = true;
      return;
    }
    node.forEachChild(scan);
  };
  scan(root);
  return found;
}
