import type { EffectCandidate, StateCandidate, StateUsage } from "../analyze-source.js";
import {
  callRootIdentifier,
  isAssignmentOperator,
  localBindingNames,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import {
  nodeWithin,
  visit,
  visitSkippingNestedFunctions,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import type { RuntimeFunctionLike } from "../ast.js";
import ts from "typescript";

const EMPTY_BINDINGS: ReadonlySet<string> = new Set();

const SAFE_PROJECTION_METHODS: ReadonlySet<string> = new Set([
  "filter",
  "findIndex",
  "join",
  "slice",
  "trim",
]);

export type JsxSubtreeNode = ts.JsxElement | ts.JsxFragment | ts.JsxSelfClosingElement;

interface SchedulerDeclaration {
  handle: string;
  setter: StateCandidate;
}

export function findDeferredRevealStates(
  effects: readonly EffectCandidate[],
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
): ReadonlySet<StateCandidate> {
  const byOwner = groupStatesByOwner(states);
  const result = new Set<StateCandidate>();
  for (const effect of effects) {
    const state = effectRevealedState(effect, byOwner);
    if (state && isDeferredRevealUsage(usageByState.get(state), state)) {
      result.add(state);
    }
  }
  return result;
}

function groupStatesByOwner(
  states: readonly StateCandidate[],
): ReadonlyMap<RuntimeFunctionLike, StateCandidate[]> {
  const byOwner = new Map<RuntimeFunctionLike, StateCandidate[]>();
  for (const state of states) {
    const ownerStates = byOwner.get(state.owner) ?? [];
    ownerStates.push(state);
    byOwner.set(state.owner, ownerStates);
  }
  return byOwner;
}

function effectRevealedState(
  effect: EffectCandidate,
  byOwner: ReadonlyMap<RuntimeFunctionLike, StateCandidate[]>,
): StateCandidate | null {
  if (!effect.owner) {
    return null;
  }
  const stateBySetter = new Map(
    (byOwner.get(effect.owner) ?? []).flatMap((state) =>
      state.setterName ? [[state.setterName, state] as const] : [],
    ),
  );
  const state = deferredRevealState(effect, stateBySetter);
  return state &&
    state.owner === effect.owner &&
    hasStateInitializer(state, ts.SyntaxKind.FalseKeyword)
    ? state
    : null;
}

function isDeferredRevealUsage(usage: StateUsage | undefined, state: StateCandidate): boolean {
  return (
    usage !== undefined &&
    usage.setterReferences === 1 &&
    usage.setterCalls === 1 &&
    usage.effectWrites === 1 &&
    usage.effectReads === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences === 0 &&
    usage.directRenderNodes.length === 1 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    !usage.shadowed &&
    !usage.escaped &&
    usage.directRenderNodes.every((node) => isRenderGateReference(node, state.owner))
  );
}

function deferredRevealState(
  effect: EffectCandidate,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): StateCandidate | null {
  const { callback } = effect;
  if (
    !callback ||
    !effect.dependencies ||
    effect.dependencies.elements.length > 0 ||
    !ts.isBlock(callback.body)
  ) {
    return null;
  }
  const schedulers: SchedulerDeclaration[] = [];
  let knownSetterCalls = 0;
  visit(callback.body, (node) => {
    if (isKnownSetterCall(node, stateBySetter)) {
      knownSetterCalls += 1;
    }
    const declared = schedulerDeclaration(node, stateBySetter);
    if (declared) {
      schedulers.push(declared);
    }
  });
  const [scheduler] = schedulers;
  if (
    schedulers.length !== 1 ||
    knownSetterCalls !== 1 ||
    !scheduler ||
    !callbackCancelsDeferredHandle(callback, scheduler.handle)
  ) {
    return null;
  }
  return scheduler.setter;
}

function isKnownSetterCall(
  node: ts.Node,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    stateBySetter.has(node.expression.text)
  );
}

function schedulerDeclaration(
  node: ts.Node,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): SchedulerDeclaration | null {
  if (
    !ts.isVariableDeclaration(node) ||
    !ts.isIdentifier(node.name) ||
    !node.initializer ||
    !ts.isCallExpression(node.initializer)
  ) {
    return null;
  }
  const [callback] = node.initializer.arguments;
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return null;
  }
  const setterCall = soleLiteralTrueSetterCall(callback, stateBySetter);
  const setter = setterCall ? stateBySetter.get(setterCall.expression.text) : undefined;
  return setter ? { handle: node.name.text, setter } : null;
}

function soleLiteralTrueSetterCall(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): (ts.CallExpression & { expression: ts.Identifier }) | null {
  const calls: (ts.CallExpression & { expression: ts.Identifier })[] = [];
  visitSkippingNestedFunctions(callback.body, callback, (node) => {
    if (isKnownSetterCall(node, stateBySetter)) {
      // SAFETY: isKnownSetterCall proves the node is a call whose target is an Identifier.
      calls.push(node as ts.CallExpression & { expression: ts.Identifier });
    }
  });
  const [call] = calls;
  return calls.length === 1 &&
    call?.arguments.length === 1 &&
    call.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword
    ? call
    : null;
}

function callbackCancelsDeferredHandle(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  handle: string,
): boolean {
  return (
    ts.isBlock(callback.body) &&
    callback.body.statements.some((statement) => statementCancelsHandle(statement, handle))
  );
}

function statementCancelsHandle(statement: ts.Statement, handle: string): boolean {
  if (!ts.isReturnStatement(statement) || !statement.expression) {
    return false;
  }
  const cleanup = statement.expression;
  if (!ts.isArrowFunction(cleanup) && !ts.isFunctionExpression(cleanup)) {
    return false;
  }
  if (localBindingNames(cleanup, null).has(handle)) {
    return false;
  }
  const call = cleanupCallExpression(cleanup);
  return call !== null && callCancelsHandle(call, handle);
}

function cleanupCallExpression(
  cleanup: ts.ArrowFunction | ts.FunctionExpression,
): ts.CallExpression | null {
  if (!ts.isBlock(cleanup.body)) {
    return ts.isCallExpression(cleanup.body) ? cleanup.body : null;
  }
  const [only] = cleanup.body.statements;
  if (cleanup.body.statements.length !== 1 || !only || !ts.isExpressionStatement(only)) {
    return null;
  }
  return ts.isCallExpression(only.expression) ? only.expression : null;
}

function callCancelsHandle(call: ts.CallExpression, handle: string): boolean {
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === handle &&
    /^(?:cancel|clear|remove)$/u.test(call.expression.name.text) &&
    call.arguments.length === 0
  ) {
    return true;
  }
  const [argument] = call.arguments;
  return (
    ts.isIdentifier(call.expression) &&
    /^(?:cancel|clear|remove)/u.test(call.expression.text) &&
    call.arguments.length === 1 &&
    argument !== undefined &&
    ts.isIdentifier(argument) &&
    argument.text === handle
  );
}

export function isRenderGateReference(node: ts.Node, boundary: ts.Node): boolean {
  for (
    let current: ts.Node | undefined = node;
    current && current !== boundary;
    current = current.parent
  ) {
    if (ts.isConditionalExpression(current) && nodeWithin(node, current.condition)) {
      return true;
    }
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
      (expressionContainsJsx(current.right) ||
        localJsxFactoryReturn(current.right, boundary) !== null)
    ) {
      return true;
    }
  }
  return false;
}

export function commonRenderGateSubtree(
  nodes: readonly ts.Node[],
  boundary: ts.Node,
): JsxSubtreeNode | null {
  const subtrees = nodes.map((node) => renderGateSubtree(node, boundary));
  const [first] = subtrees;
  return first && subtrees.every((subtree) => subtree === first) ? first : null;
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
      isSafeProjectionExpression({ expression: current.condition, reference: node })
    ) {
      return jsxSubtreeAncestors(current, boundary)[0] ?? null;
    }
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      nodeWithin(node, current.left) &&
      isSafeProjectionExpression({ expression: current.left, reference: node })
    ) {
      const subtree = directJsxSubtree(current.right, boundary);
      if (subtree) {
        return subtree;
      }
    }
  }
  return null;
}

function directJsxSubtree(expression: ts.Expression, boundary: ts.Node): JsxSubtreeNode | null {
  const current = unwrapTransparentExpression(expression);
  return literalJsxSubtree(current) ?? localJsxFactoryReturn(current, boundary);
}

function literalJsxSubtree(expression: ts.Expression): JsxSubtreeNode | null {
  const current = unwrapTransparentExpression(expression);
  return ts.isJsxElement(current) ||
    ts.isJsxFragment(current) ||
    ts.isJsxSelfClosingElement(current)
    ? current
    : null;
}

function localJsxFactoryReturn(
  expression: ts.Expression,
  boundary: ts.Node,
): JsxSubtreeNode | null {
  const call = unwrapTransparentExpression(expression);
  if (
    !ts.isCallExpression(call) ||
    call.questionDotToken ||
    call.arguments.length > 0 ||
    !ts.isIdentifier(call.expression)
  ) {
    return null;
  }
  const factory = nullaryJsxFactory(boundary, call.expression.text);
  return factory ? factoryJsxResult(factory) : null;
}

function nullaryJsxFactory(
  boundary: ts.Node,
  factoryName: string,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const declaration = uniqueConstDeclaration(boundary, factoryName);
  if (!declaration?.initializer) {
    return null;
  }
  const factory = unwrapTransparentExpression(declaration.initializer);
  if (
    (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) ||
    factory.parameters.length > 0 ||
    factory.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    (ts.isFunctionExpression(factory) && factory.asteriskToken)
  ) {
    return null;
  }
  return factory;
}

function factoryJsxResult(
  factory: ts.ArrowFunction | ts.FunctionExpression,
): JsxSubtreeNode | null {
  if (!ts.isBlock(factory.body)) {
    return literalJsxSubtree(factory.body);
  }
  const returns: ts.ReturnStatement[] = [];
  visitSkippingNestedFunctions(factory.body, factory, (node) => {
    if (ts.isReturnStatement(node)) {
      returns.push(node);
    }
  });
  const returned = returns[0]?.expression;
  return returns.length === 1 && returned ? literalJsxSubtree(returned) : null;
}

function statementContainsRenderableReturn(statement: ts.Statement, boundary: ts.Node): boolean {
  let found = false;
  visitSkippingNestedRuntimeFunctions(statement, (node) => {
    if (
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      (expressionContainsJsx(node.expression) ||
        (ts.isIdentifier(node.expression) &&
          uniqueConstJsxInitializer(boundary, node.expression.text) !== null))
    ) {
      found = true;
    }
  });
  return found;
}

function uniqueConstDeclaration(boundary: ts.Node, name: string): ts.VariableDeclaration | null {
  const declarations: ts.VariableDeclaration[] = [];
  visitSkippingNestedRuntimeFunctions(boundary, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      declarations.push(node);
    }
  });
  const [declaration] = declarations;
  if (
    declarations.length !== 1 ||
    !declaration?.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  return declaration;
}

function uniqueConstJsxInitializer(boundary: ts.Node, name: string): ts.Expression | null {
  const initializer = uniqueConstDeclaration(boundary, name)?.initializer;
  return initializer && expressionContainsJsx(initializer) ? initializer : null;
}

export function expressionContainsJsx(expression: ts.Expression): boolean {
  let found = false;
  visit(expression, (node) => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node) || ts.isJsxSelfClosingElement(node)) {
      found = true;
    }
  });
  return found;
}

export interface SafeProjectionQuery {
  readonly allowedIdentifierCalls?: ReadonlySet<string>;
  readonly allowedPropertyCalls?: ReadonlySet<string>;
  readonly expression: ts.Expression;
  readonly reference: ts.Node;
}

export function isSafeProjectionExpression({
  allowedIdentifierCalls = EMPTY_BINDINGS,
  allowedPropertyCalls = EMPTY_BINDINGS,
  expression,
  reference,
}: SafeProjectionQuery): boolean {
  if (!nodeWithin(reference, expression)) {
    return false;
  }
  let safe = true;
  visit(expression, (node) => {
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
      (ts.isCallExpression(node) &&
        !isSafeProjectionCall(node, allowedIdentifierCalls, allowedPropertyCalls))
    ) {
      safe = false;
    }
  });
  return safe;
}

function isSafeProjectionCall(
  call: ts.CallExpression,
  allowedIdentifierCalls: ReadonlySet<string>,
  allowedPropertyCalls: ReadonlySet<string>,
): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return allowedIdentifierCalls.has(callee.text);
  }
  if (!ts.isPropertyAccessExpression(callee)) {
    return false;
  }
  const name = callee.name.text;
  const root = callRootIdentifier(callee);
  return (
    SAFE_PROJECTION_METHODS.has(name) ||
    (ts.isIdentifier(callee.expression) &&
      allowedPropertyCalls.has(`${callee.expression.text}.${name}`)) ||
    root === "styles" ||
    root === "cn"
  );
}

export function jsxSubtreeAncestors(node: ts.Node, boundary: ts.Node): JsxSubtreeNode[] {
  const ancestors: JsxSubtreeNode[] = [];
  for (
    let current: ts.Node | undefined = node;
    current && current !== boundary;
    current = current.parent
  ) {
    if (
      ts.isJsxElement(current) ||
      ts.isJsxFragment(current) ||
      ts.isJsxSelfClosingElement(current)
    ) {
      ancestors.push(current);
    }
  }
  return ancestors;
}

export function hasStateInitializer(state: StateCandidate, kind: ts.SyntaxKind): boolean {
  return state.call.arguments.length === 1 && state.call.arguments[0]?.kind === kind;
}
