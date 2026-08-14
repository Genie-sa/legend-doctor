import ts from "typescript";

import {
  callRootIdentifier,
  isAssignmentOperator,
  localBindingNames,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import {
  nodeWithin,
  type RuntimeFunctionLike,
  visit,
  visitSkippingNestedFunctions,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import type { EffectCandidate, StateCandidate, StateUsage } from "../analyze-source.js";

const EMPTY_BINDINGS: ReadonlySet<string> = new Set();

export type JsxSubtreeNode = ts.JsxElement | ts.JsxFragment | ts.JsxSelfClosingElement;

export function findDeferredRevealStates(
  effects: readonly EffectCandidate[],
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>
): ReadonlySet<StateCandidate> {
  const statesByOwner = new Map<RuntimeFunctionLike, StateCandidate[]>();
  for (const state of states) {
    const ownerStates = statesByOwner.get(state.owner) ?? [];
    ownerStates.push(state);
    statesByOwner.set(state.owner, ownerStates);
  }

  const result = new Set<StateCandidate>();
  for (const effect of effects) {
    if (!effect.owner) continue;
    const stateBySetter = new Map(
      (statesByOwner.get(effect.owner) ?? []).flatMap(state =>
        state.setterName ? [[state.setterName, state] as const] : []
      )
    );
    const state = deferredRevealState(effect, stateBySetter);
    if (
      !state ||
      state.owner !== effect.owner ||
      !hasStateInitializer(state, ts.SyntaxKind.FalseKeyword)
    ) {
      continue;
    }
    const usage = usageByState.get(state);
    if (
      !usage ||
      usage.setterReferences !== 1 ||
      usage.setterCalls !== 1 ||
      usage.effectWrites !== 1 ||
      usage.effectReads > 0 ||
      usage.deferredReads > 0 ||
      usage.transportedOccurrences > 0 ||
      usage.directRenderNodes.length !== 1 ||
      usage.localRenderReads !== usage.directRenderNodes.length ||
      usage.shadowed ||
      usage.escaped ||
      !usage.directRenderNodes.every(node => isRenderGateReference(node, state.owner))
    ) {
      continue;
    }
    result.add(state);
  }
  return result;
}

function deferredRevealState(
  effect: EffectCandidate,
  stateBySetter: ReadonlyMap<string, StateCandidate>
): StateCandidate | null {
  if (
    !effect.callback ||
    !effect.dependencies ||
    effect.dependencies.elements.length !== 0 ||
    !ts.isBlock(effect.callback.body)
  ) {
    return null;
  }
  const schedulerDeclarations: Array<{
    handle: string;
    setter: StateCandidate;
  }> = [];
  const knownSetterCalls: ts.CallExpression[] = [];
  visit(effect.callback.body, node => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      stateBySetter.has(node.expression.text)
    ) {
      knownSetterCalls.push(node);
    }
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.initializer ||
      !ts.isCallExpression(node.initializer)
    ) {
      return;
    }
    const callback = node.initializer.arguments[0];
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return;
    const setterCall = soleLiteralTrueSetterCall(callback, stateBySetter);
    const setter = setterCall ? stateBySetter.get(setterCall.expression.text) : undefined;
    if (setter) schedulerDeclarations.push({ handle: node.name.text, setter });
  });
  if (schedulerDeclarations.length !== 1 || knownSetterCalls.length !== 1) return null;
  const scheduler = schedulerDeclarations[0];
  if (!scheduler || !callbackCancelsDeferredHandle(effect.callback, scheduler.handle)) {
    return null;
  }
  return scheduler.setter;
}

function soleLiteralTrueSetterCall(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>
): (ts.CallExpression & { expression: ts.Identifier }) | null {
  const calls: Array<ts.CallExpression & { expression: ts.Identifier }> = [];
  visitSkippingNestedFunctions(callback.body, callback, node => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      stateBySetter.has(node.expression.text)
    ) {
      calls.push(node as ts.CallExpression & { expression: ts.Identifier });
    }
  });
  const call = calls[0];
  return calls.length === 1 &&
    call?.arguments.length === 1 &&
    call.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword
    ? call
    : null;
}

function callbackCancelsDeferredHandle(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  handle: string
): boolean {
  if (!ts.isBlock(callback.body)) return false;
  return callback.body.statements.some(statement => {
    if (!ts.isReturnStatement(statement) || !statement.expression) return false;
    const cleanup = statement.expression;
    if (!ts.isArrowFunction(cleanup) && !ts.isFunctionExpression(cleanup)) return false;
    const cleanupBindings = localBindingNames(cleanup, null);
    if (cleanupBindings.has(handle)) return false;
    const call = ts.isBlock(cleanup.body)
      ? (() => {
          const only = cleanup.body.statements[0];
          return cleanup.body.statements.length === 1 && only && ts.isExpressionStatement(only)
            ? only.expression
            : null;
        })()
      : cleanup.body;
    if (!call || !ts.isCallExpression(call)) return false;
    if (
      ts.isPropertyAccessExpression(call.expression) &&
      ts.isIdentifier(call.expression.expression) &&
      call.expression.expression.text === handle &&
      /^(?:cancel|clear|remove)$/.test(call.expression.name.text) &&
      call.arguments.length === 0
    ) {
      return true;
    }
    const argument = call.arguments[0];
    return (
      ts.isIdentifier(call.expression) &&
      /^(?:cancel|clear|remove)/.test(call.expression.text) &&
      call.arguments.length === 1 &&
      !!argument &&
      ts.isIdentifier(argument) &&
      argument.text === handle
    );
  });
}

export function isRenderGateReference(node: ts.Node, boundary: ts.Node): boolean {
  for (
    let current: ts.Node | undefined = node;
    current && current !== boundary;
    current = current.parent
  ) {
    if (ts.isConditionalExpression(current) && nodeWithin(node, current.condition)) return true;
    if (
      ts.isIfStatement(current) &&
      nodeWithin(node, current.expression) &&
      statementContainsRenderableReturn(current.thenStatement, boundary)
    ) {
      return true;
    }
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      nodeWithin(node, current.left) &&
      expressionContainsJsx(current.right)
    ) {
      return true;
    }
  }
  return false;
}

export function commonRenderGateSubtree(
  nodes: readonly ts.Node[],
  boundary: ts.Node
): JsxSubtreeNode | null {
  const subtrees = nodes.map(node => renderGateSubtree(node, boundary));
  const first = subtrees[0];
  return first && subtrees.every(subtree => subtree === first) ? first : null;
}

function renderGateSubtree(node: ts.Node, boundary: ts.Node): JsxSubtreeNode | null {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (
      ts.isConditionalExpression(current) &&
      nodeWithin(node, current.condition) &&
      isSafeProjectionExpression(current.condition, node)
    ) {
      return jsxSubtreeAncestors(current, boundary)[0] ?? null;
    }
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      nodeWithin(node, current.left) &&
      isSafeProjectionExpression(current.left, node)
    ) {
      const subtree = directJsxSubtree(current.right);
      if (subtree) return subtree;
    }
  }
  return null;
}

function directJsxSubtree(expression: ts.Expression): JsxSubtreeNode | null {
  const current = unwrapTransparentExpression(expression);
  return ts.isJsxElement(current) || ts.isJsxFragment(current) || ts.isJsxSelfClosingElement(current)
    ? current
    : null;
}

function statementContainsRenderableReturn(statement: ts.Statement, boundary: ts.Node): boolean {
  let found = false;
  visitSkippingNestedRuntimeFunctions(statement, node => {
    if (
      ts.isReturnStatement(node) &&
      !!node.expression &&
      (expressionContainsJsx(node.expression) ||
        (ts.isIdentifier(node.expression) &&
          uniqueConstJsxInitializer(boundary, node.expression.text) !== null))
    ) {
      found = true;
    }
  });
  return found;
}

function uniqueConstJsxInitializer(boundary: ts.Node, name: string): ts.Expression | null {
  const declarations: ts.VariableDeclaration[] = [];
  visitSkippingNestedRuntimeFunctions(boundary, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      declarations.push(node);
    }
  });
  const declaration = declarations[0];
  if (
    declarations.length !== 1 ||
    !declaration?.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    !expressionContainsJsx(declaration.initializer)
  ) {
    return null;
  }
  return declaration.initializer;
}

export function expressionContainsJsx(expression: ts.Expression): boolean {
  let found = false;
  visit(expression, node => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node) || ts.isJsxSelfClosingElement(node)) {
      found = true;
    }
  });
  return found;
}

export function isSafeProjectionExpression(
  expression: ts.Expression,
  reference: ts.Node,
  allowedIdentifierCalls: ReadonlySet<string> = EMPTY_BINDINGS
): boolean {
  if (!nodeWithin(reference, expression)) return false;
  let safe = true;
  visit(expression, node => {
    if (
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isDeleteExpression(node) ||
      ts.isPostfixUnaryExpression(node) ||
      (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) ||
      (ts.isCallExpression(node) && !isSafeProjectionCall(node, allowedIdentifierCalls))
    ) {
      safe = false;
    }
  });
  return safe;
}

function isSafeProjectionCall(
  call: ts.CallExpression,
  allowedIdentifierCalls: ReadonlySet<string>
): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return allowedIdentifierCalls.has(callee.text);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const name = callee.name.text;
  if (["filter", "findIndex", "join", "slice", "trim"].includes(name)) return true;
  const root = callRootIdentifier(callee);
  return root === "styles" || root === "cn";
}

export function jsxSubtreeAncestors(node: ts.Node, boundary: ts.Node): JsxSubtreeNode[] {
  const ancestors: JsxSubtreeNode[] = [];
  for (
    let current: ts.Node | undefined = node;
    current && current !== boundary;
    current = current.parent
  ) {
    if (ts.isJsxElement(current) || ts.isJsxFragment(current) || ts.isJsxSelfClosingElement(current)) {
      ancestors.push(current);
    }
  }
  return ancestors;
}

export function hasStateInitializer(state: StateCandidate, kind: ts.SyntaxKind): boolean {
  return state.call.arguments.length === 1 && state.call.arguments[0]?.kind === kind;
}
