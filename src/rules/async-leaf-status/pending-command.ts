import type { CommandRegion, PendingCommand } from "./model.js";
import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import { findAncestorUntil, isRuntimeFunctionLike } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";

export function pendingCommand(
  state: StateCandidate,
  usage: StateUsage,
  states: readonly StateCandidate[],
): PendingCommand | null {
  const trueCalls = usage.setterCallNodes.filter(
    (call) => call.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword,
  );
  const [firstTrueCall] = trueCalls;
  const pendingStart = trueCalls.length === 1 && firstTrueCall ? firstTrueCall : null;
  const region = pendingStart ? asyncCommandRegion(pendingStart, state.owner) : null;
  if (!pendingStart || !region || region === state.owner || !isCommandRegion(region)) {
    return null;
  }
  const alternateResetRegions = alternateResetRegionsFor(usage, state.owner, region);
  return alternateResetRegions
    ? {
        alternateResetRegions,
        ownerSetters: ownerSetterNames(states, state.owner),
        pendingStart,
        region,
      }
    : null;
}

export function isCommandRegion(region: ts.Node): region is CommandRegion {
  return (
    ts.isArrowFunction(region) ||
    ts.isFunctionDeclaration(region) ||
    ts.isFunctionExpression(region)
  );
}

function ownerSetterNames(
  states: readonly StateCandidate[],
  owner: RuntimeFunctionLike,
): ReadonlySet<string> {
  return new Set(
    states.flatMap((candidate) =>
      candidate.owner === owner && candidate.setterName ? [candidate.setterName] : [],
    ),
  );
}

function alternateResetRegionsFor(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
  region: RuntimeFunctionLike,
): readonly CommandRegion[] | null {
  const alternates: CommandRegion[] = [];
  for (const call of usage.setterCallNodes) {
    const candidate = asyncCommandRegion(call, owner);
    if (candidate === region) {
      continue;
    }
    if (!isCommandRegion(candidate) || call.arguments[0]?.kind !== ts.SyntaxKind.FalseKeyword) {
      return null;
    }
    alternates.push(candidate);
  }
  return alternates;
}

export function asyncCommandRegion(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): RuntimeFunctionLike {
  let region = nearestMutationFunction(call, owner);
  while (region !== owner && isPromiseContinuationCallback(region)) {
    region = nearestMutationFunction(region, owner);
  }
  return region;
}

export function nearestMutationFunction(
  node: ts.Node,
  owner: RuntimeFunctionLike,
): RuntimeFunctionLike {
  return findAncestorUntil(node, isRuntimeFunctionLike, owner) ?? owner;
}

export function isPromiseContinuationCallback(region: RuntimeFunctionLike): boolean {
  if (!ts.isArrowFunction(region) && !ts.isFunctionExpression(region)) {
    return false;
  }
  const call = region.parent;
  return (
    ts.isCallExpression(call) &&
    call.arguments.includes(region) &&
    ts.isPropertyAccessExpression(call.expression) &&
    ["then", "catch", "finally"].includes(call.expression.name.text)
  );
}
