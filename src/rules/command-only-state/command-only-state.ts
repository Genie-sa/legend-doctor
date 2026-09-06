import {
  isDeclarationName,
  isEvaluationInert,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import {
  isRuntimeFunctionLike,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import { setterCallUsesPreviousValue } from "../state-proofs/state-proofs.js";
import ts from "typescript";

interface CommandOnlyUsage {
  setterCallNodes: readonly ts.CallExpression[];
  setterUsesPreviousValue: boolean;
}

export function refWouldChangeCommandSnapshot(
  state: StateCandidate,
  usage: CommandOnlyUsage,
  readsAreEventRooted: boolean,
): boolean {
  const writes = usage.setterCallNodes.map((call) => ({
    call,
    regions: commandRuntimeRegions(call, state.owner),
  }));
  if (writes.every((write) => write.regions.length === 0)) {
    return false;
  }

  let shared = false;
  visit(state.owner.body, (node) => {
    if (
      shared ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      node.parent === state.call.parent ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const readRegions = commandRuntimeRegions(node, state.owner);
    shared = writes.some((write) => {
      const commonRegions = readRegions.filter((region) => write.regions.includes(region));
      if (commonRegions.length === 0) {
        return false;
      }
      const readBeforeWrite =
        nodeWithin(node, write.call) || node.getStart() < write.call.getStart();
      return !readBeforeWrite || !readsAreEventRooted;
    });
  });
  return shared;
}

function commandRuntimeRegions(node: ts.Node, owner: RuntimeFunctionLike): RuntimeFunctionLike[] {
  const regions: RuntimeFunctionLike[] = [];
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (isRuntimeFunctionLike(current)) {
      regions.push(current);
    }
  }
  return regions;
}

export function functionalUpdaterPrecedesSnapshotRead(
  state: StateCandidate,
  usage: CommandOnlyUsage,
  nearestMutationFunction: (node: ts.Node, owner: RuntimeFunctionLike) => RuntimeFunctionLike,
): boolean {
  if (!usage.setterUsesPreviousValue) {
    return false;
  }
  return usage.setterCallNodes.some((call) => {
    if (!setterCallUsesPreviousValue(call)) {
      return false;
    }
    const region = nearestMutationFunction(call, state.owner);
    if (!region.body) {
      return true;
    }
    let readAfterWrite = false;
    visitSkippingNestedRuntimeFunctions(region.body, (node) => {
      if (
        ts.isIdentifier(node) &&
        node.text === state.valueName &&
        node.getStart() > call.end &&
        !isDeclarationName(node) &&
        !isNonValueIdentifier(node)
      ) {
        readAfterWrite = true;
      }
    });
    return readAfterWrite;
  });
}

export function functionalCounterUpdaterPreservesSnapshot(
  state: StateCandidate,
  usage: CommandOnlyUsage,
  nearestMutationFunction: (node: ts.Node, owner: RuntimeFunctionLike) => RuntimeFunctionLike,
): boolean {
  const [call] = usage.setterCallNodes;
  if (usage.setterCallNodes.length !== 1 || !call || !isInertCounterUpdater(call.arguments[0])) {
    return false;
  }
  const region = nearestMutationFunction(call, state.owner);
  return region.body !== undefined && snapshotReadsFollowCall(region.body, state.valueName, call);
}

function isInertCounterUpdater(updater: ts.Expression | undefined): boolean {
  if (
    !updater ||
    !ts.isArrowFunction(updater) ||
    updater.parameters.length !== 1 ||
    !ts.isIdentifier(updater.parameters[0]!.name) ||
    ts.isBlock(updater.body)
  ) {
    return false;
  }
  const expression = updater.body;
  const parameter = updater.parameters[0]!.name.text;
  return (
    ts.isBinaryExpression(expression) &&
    [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(expression.operatorToken.kind) &&
    ts.isIdentifier(expression.left) &&
    expression.left.text === parameter &&
    isEvaluationInert(expression.right)
  );
}

function snapshotReadsFollowCall(
  body: ts.Node,
  valueName: string,
  call: ts.CallExpression,
): boolean {
  let readsAfter = 0;
  let unsafe = false;
  visitSkippingNestedRuntimeFunctions(body, (node) => {
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) {
      unsafe = true;
    }
    if (
      ts.isIdentifier(node) &&
      node.text === valueName &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      if (node.getStart() <= call.end) {
        unsafe = true;
      } else {
        readsAfter += 1;
      }
    }
  });
  return !unsafe && readsAfter > 0;
}
