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
import { hasStateInitializer, isSafeProjectionExpression } from "./deferred-reveal.js";
import {
  callbackIsEventRooted,
  isSafeJsxProjectionReference,
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
      usage.localRenderReads !== usage.directRenderNodes.length ||
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

    const ownerSetters = new Set(
      states
        .filter(candidate => candidate.owner === state.owner && candidate.setterName)
        .map(candidate => candidate.setterName!)
    );
    const trueCalls = usage.setterCallNodes.filter(
      call => call.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword
    );
    const pendingStart = trueCalls.length === 1 ? trueCalls[0]! : null;
    const region = pendingStart ? asyncCommandRegion(pendingStart, state.owner) : null;
    if (
      !pendingStart ||
      !region ||
      region === state.owner ||
      (!ts.isArrowFunction(region) &&
        !ts.isFunctionDeclaration(region) &&
        !ts.isFunctionExpression(region)) ||
      !callbackIsEventRooted(region, state.owner, "", new Set()) ||
      usage.setterCallNodes.some(call => {
        const candidate = asyncCommandRegion(call, state.owner);
        if (candidate === region) return false;
        return (
          (!ts.isArrowFunction(candidate) &&
            !ts.isFunctionDeclaration(candidate) &&
            !ts.isFunctionExpression(candidate)) ||
          call.arguments[0]?.kind !== ts.SyntaxKind.FalseKeyword ||
          !callbackIsEventRooted(candidate, state.owner, "", new Set())
        );
      })
    ) {
      continue;
    }

    if (
      nearestMutationFunction(pendingStart, state.owner) === region &&
      startsAsyncCommandSegment(
        pendingStart,
        usage.setterCallNodes,
        ownerSetters,
        state.owner
      ) &&
      !hasEarlierOwnerStateWrite(
        region,
        pendingStart,
        ownerSetters,
        state.owner
      ) &&
      usage.setterCallNodes.some(call =>
        call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword &&
        asyncCommandRegion(call, state.owner) === region &&
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

function startsAsyncCommandSegment(
  call: ts.CallExpression,
  setterCalls: readonly ts.CallExpression[],
  ownerSetters: ReadonlySet<string>,
  owner: RuntimeFunctionLike
): boolean {
  const statement = call.parent;
  const block = statement.parent;
  if (!ts.isExpressionStatement(statement) || !ts.isBlock(block)) return false;
  const index = block.statements.indexOf(statement);
  if (index < 0) return false;

  for (const candidate of block.statements.slice(index + 1)) {
    const awaitPosition = firstAwaitPosition(candidate);
    const promiseBoundary = containsPromiseCompletionReset(candidate, setterCalls);
    const boundary = awaitPosition ?? (promiseBoundary ? candidate.end : null);
    if (boundary !== null) {
      return !containsOwnerStateWrite(
        candidate,
        boundary,
        ownerSetters,
        owner,
        new Set(),
        awaitPosition === null
      ) && !containsEarlyExit(candidate, boundary);
    }
    if (
      containsOwnerStateWrite(
        candidate,
        candidate.end,
        ownerSetters,
        owner,
        new Set()
      ) ||
      containsEarlyExit(candidate, candidate.end)
    ) {
      return false;
    }
  }
  return false;
}

function firstAwaitPosition(statement: ts.Statement): number | null {
  let position: number | null = null;
  visitSkippingNestedRuntimeFunctions(statement, node => {
    if (ts.isAwaitExpression(node) && (position === null || node.getStart() < position)) {
      position = node.getStart();
    }
  });
  return position;
}

function containsPromiseCompletionReset(
  statement: ts.Statement,
  setterCalls: readonly ts.CallExpression[]
): boolean {
  return setterCalls.some(candidate => {
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

function hasEarlierOwnerStateWrite(
  region: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  pendingStart: ts.CallExpression,
  ownerSetters: ReadonlySet<string>,
  owner: RuntimeFunctionLike
): boolean {
  if (!region.body) return true;
  return containsOwnerStateWrite(
    region.body,
    pendingStart.getStart(),
    ownerSetters,
    owner,
    new Set()
  );
}

function containsOwnerStateWrite(
  root: ts.Node,
  before: number,
  ownerSetters: ReadonlySet<string>,
  owner: RuntimeFunctionLike,
  seen: ReadonlySet<string>,
  skipPromiseContinuations = false
): boolean {
  let found = false;
  const scan = (node: ts.Node): void => {
    if (found || node.getStart() >= before) return;
    if (isRuntimeFunctionLike(node) && node !== root) return;
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        if (ownerSetters.has(node.expression.text)) {
          found = true;
          return;
        }
        const helper = localFunctionBinding(owner, node.expression.text);
        if (helper?.body && !seen.has(node.expression.text)) {
          const nextSeen = new Set(seen).add(node.expression.text);
          if (
            containsOwnerStateWrite(
              helper.body,
              helper.body.end,
              ownerSetters,
              owner,
              nextSeen
            )
          ) {
            found = true;
            return;
          }
        }
      }
      for (const argument of node.arguments) {
        if (
          (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) &&
          (!skipPromiseContinuations || !isPromiseContinuationCallback(argument)) &&
          containsOwnerStateWrite(
            argument.body,
            argument.body.end,
            ownerSetters,
            owner,
            seen,
            skipPromiseContinuations
          )
        ) {
          found = true;
          return;
        }
      }
    }
    node.forEachChild(scan);
  };
  scan(root);
  return found;
}

function localFunctionBinding(
  owner: RuntimeFunctionLike,
  name: string
): ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null {
  if (!owner.body || bindingDeclarationCount(owner, name) !== 1) return null;
  let result: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null = null;
  visit(owner.body, node => {
    if (result) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      result = node;
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      result = node.initializer;
    }
  });
  return result;
}

function containsEarlyExit(root: ts.Node, before: number): boolean {
  let found = false;
  const scan = (node: ts.Node): void => {
    if (found || node.getStart() >= before) return;
    if (isRuntimeFunctionLike(node) && node !== root) return;
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

function hasSingleObservableLeafCallSite(
  usage: StateUsage,
  owner: RuntimeFunctionLike
): boolean {
  const valueSite = [...usage.valueTransportSites][0];
  if (valueSite === undefined || !owner.body) return false;

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
  const callSite = jsxCallSite(opening);
  if (
    usage.directRenderNodes.some(node =>
      !nodeWithin(node, callSite) ||
      findAncestorUntil(node, isRuntimeFunctionLike, callSite) !== null ||
      !isSafeLeafProjectionReference(node, owner)
    )
  ) {
    return false;
  }
  const returned = returnedExpressions(owner);
  if (returned.some(expression => nodeWithin(opening!, expression))) return true;

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
  return references.length === 1 && returned.some(expression => nodeWithin(references[0]!, expression));
}

function jsxCallSite(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement
): ts.Node {
  return ts.isJsxOpeningElement(opening) ? opening.parent : opening;
}

function isSafeLeafProjectionReference(
  node: ts.Node,
  owner: RuntimeFunctionLike
): boolean {
  if (isSafeJsxProjectionReference(node, owner)) return true;
  for (let current: ts.Node | undefined = node.parent; current && current !== owner; current = current.parent) {
    if (ts.isConditionalExpression(current) && nodeWithin(node, current.condition)) {
      return isSafeProjectionExpression(current.condition, node);
    }
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      nodeWithin(node, current.left)
    ) {
      return isSafeProjectionExpression(current.left, node);
    }
  }
  return false;
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

function returnedExpressions(owner: RuntimeFunctionLike): readonly ts.Expression[] {
  if (!owner.body) return [];
  const expressions: ts.Expression[] = [];
  visitSkippingNestedRuntimeFunctions(owner.body, node => {
    if (ts.isReturnStatement(node) && node.expression) expressions.push(node.expression);
  });
  return expressions;
}
