import ts from "typescript";

import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
} from "../analysis-ast.js";
import type { StateCandidate, StateUsage } from "../analyze-source.js";
import {
  findAncestorUntil,
  isRuntimeFunctionLike,
  nodeWithin,
  type RuntimeFunctionLike,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import { hasStateInitializer } from "./deferred-reveal.js";
import {
  callbackIsEventRooted,
  jsxElementCount,
  nearestRepeatedRenderCall,
} from "./state-proofs.js";

export function findAsyncLeafStatuses(
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  safeCommandStates: ReadonlySet<StateCandidate>
): ReadonlySet<StateCandidate> {
  const result = new Set<StateCandidate>();
  for (const state of states) {
    const usage = usageByState.get(state);
    if (
      !state.setterName ||
      !hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) ||
      !safeCommandStates.has(state) ||
      !usage ||
      jsxElementCount(state.owner) < 12 ||
      usage.localRenderReads !== 0 ||
      usage.effectReads !== 0 ||
      usage.effectWrites !== 0 ||
      usage.deferredReads !== 0 ||
      usage.transportedOccurrences === 0 ||
      usage.valueTransportSites.size !== 1 ||
      usage.valueTargets.size !== 1 ||
      usage.repeatedValueTransport ||
      usage.setterCallNodes.length < 2 ||
      usage.setterReferences !== usage.setterCalls ||
      usage.setterUsesPreviousValue ||
      usage.shadowed ||
      usage.escaped ||
      !hasSingleObservableLeafCallSite(usage, state.owner) ||
      !usage.setterCallNodes.every(call =>
        call.arguments.length === 1 &&
        (call.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword ||
          call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword)
      )
    ) {
      continue;
    }

    const regions = usage.setterCallNodes.map(call => asyncCommandRegion(call, state.owner));
    const region = regions[0];
    if (
      !region ||
      region === state.owner ||
      regions.some(candidate => candidate !== region) ||
      (!ts.isArrowFunction(region) &&
        !ts.isFunctionDeclaration(region) &&
        !ts.isFunctionExpression(region)) ||
      !callbackIsEventRooted(region, state.owner, "", new Set())
    ) {
      continue;
    }

    const pendingStart = usage.setterCallNodes.find(call =>
      call.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword &&
      nearestMutationFunction(call, state.owner) === region &&
      (startsAwaitedCommandSegment(call) ||
        startsPromiseCommandSegment(call, usage.setterCallNodes))
    );
    const ownerSetters = new Set(
      states
        .filter(candidate => candidate.owner === state.owner && candidate.setterName)
        .map(candidate => candidate.setterName!)
    );
    if (
      pendingStart &&
      !hasEarlierOwnerStateWrite(region, pendingStart, ownerSetters) &&
      usage.setterCallNodes.some(call =>
        call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword &&
        call.getStart() > pendingStart.getStart()
      )
    ) {
      result.add(state);
    }
  }
  return result;
}

function asyncCommandRegion(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike
): RuntimeFunctionLike {
  let region = nearestMutationFunction(call, owner);
  while (region !== owner && isPromiseContinuationCallback(region)) {
    region = nearestMutationFunction(region, owner);
  }
  return region;
}

function nearestMutationFunction(
  node: ts.Node,
  owner: RuntimeFunctionLike
): RuntimeFunctionLike {
  return findAncestorUntil(node, isRuntimeFunctionLike, owner) ?? owner;
}

function isPromiseContinuationCallback(region: RuntimeFunctionLike): boolean {
  if (!ts.isArrowFunction(region) && !ts.isFunctionExpression(region)) return false;
  const call = region.parent;
  return ts.isCallExpression(call) &&
    call.arguments.includes(region) &&
    ts.isPropertyAccessExpression(call.expression) &&
    ["then", "catch", "finally"].includes(call.expression.name.text);
}

function startsAwaitedCommandSegment(call: ts.CallExpression): boolean {
  const statement = call.parent;
  const block = statement.parent;
  if (!ts.isExpressionStatement(statement) || !ts.isBlock(block)) return false;
  const index = block.statements.indexOf(statement);
  const next = index >= 0 ? block.statements[index + 1] : undefined;
  if (!next) return false;
  let containsAwait = false;
  visitSkippingNestedRuntimeFunctions(next, node => {
    if (ts.isAwaitExpression(node)) containsAwait = true;
  });
  return containsAwait;
}

function startsPromiseCommandSegment(
  call: ts.CallExpression,
  setterCalls: readonly ts.CallExpression[]
): boolean {
  const statement = call.parent;
  const block = statement.parent;
  if (!ts.isExpressionStatement(statement) || !ts.isBlock(block)) return false;
  const index = block.statements.indexOf(statement);
  const next = index >= 0 ? block.statements[index + 1] : undefined;
  return !!next && setterCalls.some(candidate => {
    if (
      candidate.arguments[0]?.kind !== ts.SyntaxKind.FalseKeyword ||
      !nodeWithin(candidate, next)
    ) {
      return false;
    }
    const continuation = findAncestorUntil(candidate, isRuntimeFunctionLike, next);
    return continuation !== null && isPromiseContinuationCallback(continuation);
  });
}

function hasEarlierOwnerStateWrite(
  region: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  pendingStart: ts.CallExpression,
  ownerSetters: ReadonlySet<string>
): boolean {
  if (!region.body) return true;
  let found = false;
  visitSkippingNestedRuntimeFunctions(region.body, node => {
    if (
      node.getStart() < pendingStart.getStart() &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ownerSetters.has(node.expression.text)
    ) {
      found = true;
    }
  });
  return found;
}

function hasSingleObservableLeafCallSite(
  usage: StateUsage,
  owner: RuntimeFunctionLike
): boolean {
  const valueSite = [...usage.valueTransportSites][0];
  const returned = uniqueReturnedExpression(owner);
  if (valueSite === undefined || !owner.body || !returned) return false;

  let opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement | null = null;
  visit(owner.body, node => {
    if (
      opening === null &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.getStart() === valueSite
    ) {
      opening = node;
    }
  });
  if (
    opening === null ||
    nearestRepeatedRenderCall(opening, owner) ||
    !nestedFunctionsAreJsxChildren(opening, owner)
  ) {
    return false;
  }
  if (nodeWithin(opening, returned)) return true;

  const declaration = findAncestorUntil(opening, ts.isVariableDeclaration, owner);
  if (
    !declaration?.initializer ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, declaration.name.text) !== 1
  ) {
    return false;
  }
  const references: ts.Identifier[] = [];
  visit(owner.body, node => {
    if (
      ts.isIdentifier(node) &&
      node.text === declaration.name.getText() &&
      node !== declaration.name &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references.length === 1 && nodeWithin(references[0]!, returned);
}

function nestedFunctionsAreJsxChildren(
  node: ts.Node,
  owner: RuntimeFunctionLike
): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== owner; current = current.parent) {
    if (!isRuntimeFunctionLike(current)) continue;
    const expression: ts.Node = current.parent;
    if (
      !ts.isJsxExpression(expression) ||
      expression.expression !== current ||
      ts.isJsxAttribute(expression.parent)
    ) {
      return false;
    }
  }
  return true;
}

function uniqueReturnedExpression(owner: RuntimeFunctionLike): ts.Expression | null {
  if (!owner.body) return null;
  const expressions: ts.Expression[] = [];
  visitSkippingNestedRuntimeFunctions(owner.body, node => {
    if (ts.isReturnStatement(node) && node.expression) expressions.push(node.expression);
  });
  return expressions.length === 1 ? expressions[0]! : null;
}
