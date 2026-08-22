import ts from "typescript";

import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
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
import {
  commonRenderGateSubtree,
  hasStateInitializer,
  isSafeProjectionExpression,
} from "./deferred-reveal.js";
import {
  callbackIsEventRooted,
  hasIndependentRenderCutWitness,
  isHookDependencyReference,
  isSafeJsxProjectionReference,
  jsxElementCount,
  localFunctionBinding,
  lowestCommonJsxSubtree,
  nearestRepeatedRenderCall,
} from "./state-proofs.js";

export interface AsyncLeafStatusAnalysis {
  cohesive: ReadonlySet<StateCandidate>;
  isolated: ReadonlySet<StateCandidate>;
}

export function findAsyncLeafStatuses(
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  safeCommandStates: ReadonlySet<StateCandidate>,
  reactiveMutationAffectedStates: ReadonlySet<StateCandidate>,
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>
): AsyncLeafStatusAnalysis {
  const cohesive = new Set<StateCandidate>();
  const isolated = new Set<StateCandidate>();
  for (const state of states) {
    const usage = usageByState.get(state);
    if (
      !state.setterName ||
      !hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) ||
      !safeCommandStates.has(state) ||
      reactiveMutationAffectedStates.has(state) ||
      !usage ||
      usage.localRenderReads !== usage.directRenderNodes.length ||
      usage.effectReads !== 0 ||
      usage.effectWrites !== 0 ||
      usage.deferredReads !== 0 ||
      !hasResolvableAsyncLeafReferences(usage) ||
      usage.repeatedValueTransport ||
      usage.setterCallNodes.length < 2 ||
      usage.setterReferences !== usage.setterCalls ||
      usage.setterUsesPreviousValue ||
      usage.shadowed ||
      usage.escaped ||
      !usage.setterCallNodes.every(call =>
        call.arguments.length === 1 &&
        (call.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword ||
          call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword)
      )
    ) {
      continue;
    }
    const leaf = asyncLeafCallSite(usage, state.owner);
    if (!leaf) {
      continue;
    }
    const hasRenderCut = jsxElementCount(state.owner) >= 12 ||
      hasIndependentRenderCutWitness(
        leaf.returned,
        [leaf.boundary],
        localComponents,
        sourceComponents
      );

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
      !asyncCallbackIsEventRooted(region, state.owner) ||
      usage.setterCallNodes.some(call => {
        const candidate = asyncCommandRegion(call, state.owner);
        if (candidate === region) return false;
        return (
          (!ts.isArrowFunction(candidate) &&
            !ts.isFunctionDeclaration(candidate) &&
            !ts.isFunctionExpression(candidate)) ||
          call.arguments[0]?.kind !== ts.SyntaxKind.FalseKeyword ||
          !asyncCallbackIsEventRooted(candidate, state.owner)
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
        state.owner,
        leaf.requiresUnconditionalAwait
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
      (hasRenderCut ? isolated : cohesive).add(state);
    }
  }
  return { cohesive, isolated };
}

function hasResolvableAsyncLeafReferences(usage: StateUsage): boolean {
  return (
    usage.transportedOccurrences > 0 &&
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1
  ) || (
    usage.transportedOccurrences === 0 &&
    usage.valueTransportSites.size === 0 &&
    usage.valueTargets.size === 0
  );
}

function asyncCallbackIsEventRooted(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: RuntimeFunctionLike
): boolean {
  return callbackIsEventRooted(
    callback,
    owner,
    "",
    new Set(),
    callbackIsDirectEventAdapter
  );
}

function callbackIsDirectEventAdapter(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: RuntimeFunctionLike
): boolean {
  const name = ts.isFunctionDeclaration(callback)
    ? callback.name?.text
    : ts.isVariableDeclaration(callback.parent) && ts.isIdentifier(callback.parent.name)
      ? callback.parent.name.text
      : undefined;
  if (!name || !owner.body || bindingDeclarationCount(owner, name) !== 1) return false;

  let referenced = false;
  let safe = true;
  visit(owner.body, node => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      isHookDependencyReference(node, new Set(["useCallback"]))
    ) {
      return;
    }
    referenced = true;
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    const expression = attribute?.initializer && ts.isJsxExpression(attribute.initializer)
      ? attribute.initializer.expression
      : null;
    if (!attribute || !/^on[A-Z]/.test(attribute.name.getText()) || !expression) {
      safe = false;
      return;
    }
    const eventHandler = unwrapTransparentExpression(expression);
    const adapter = directEventAdapterCall(node, eventHandler);
    if (adapter && isReactHookFormSubmitAdapter(adapter, owner)) {
      return;
    }
    safe = false;
  });
  return referenced && safe;
}

function directEventAdapterCall(
  reference: ts.Identifier,
  eventHandler: ts.Expression
): ts.CallExpression | null {
  let adapter: ts.CallExpression | null = null;
  for (
    let current: ts.Node | undefined = reference.parent;
    current && current !== eventHandler;
    current = current.parent
  ) {
    if (isRuntimeFunctionLike(current)) return null;
    if (
      !adapter &&
      ts.isCallExpression(current) &&
      current.arguments.some(argument => nodeWithin(reference, argument))
    ) {
      adapter = current;
    }
  }
  return adapter ?? (ts.isCallExpression(eventHandler) &&
    eventHandler.arguments.some(argument => nodeWithin(reference, argument))
    ? eventHandler
    : null);
}

function isReactHookFormSubmitAdapter(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike
): boolean {
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    return bindingDeclarationCount(owner, callee.text) === 1 &&
      ownerHasReactHookFormBinding(owner, callee.text, true);
  }
  return ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "handleSubmit" &&
    ts.isIdentifier(callee.expression) &&
    bindingDeclarationCount(owner, callee.expression.text) === 1 &&
    ownerHasReactHookFormBinding(owner, callee.expression.text, false);
}

function ownerHasReactHookFormBinding(
  owner: RuntimeFunctionLike,
  localName: string,
  destructuredHandleSubmit: boolean
): boolean {
  if (!owner.body) return false;
  let matched = false;
  visitSkippingNestedRuntimeFunctions(owner.body, node => {
    if (matched || !ts.isVariableDeclaration(node) || !node.initializer) return;
    if (destructuredHandleSubmit) {
      if (!ts.isObjectBindingPattern(node.name)) return;
      const element = node.name.elements.find(candidate =>
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === localName &&
        (candidate.propertyName
          ? ts.isIdentifier(candidate.propertyName) && candidate.propertyName.text === "handleSubmit"
          : candidate.name.text === "handleSubmit")
      );
      if (!element) return;
    } else if (!ts.isIdentifier(node.name) || node.name.text !== localName) {
      return;
    }
    const initializer = unwrapTransparentExpression(node.initializer);
    matched = isReactHookFormFactoryCall(initializer, owner) ||
      (destructuredHandleSubmit &&
        ts.isIdentifier(initializer) &&
        bindingDeclarationCount(owner, initializer.text) === 1 &&
        ownerHasReactHookFormBinding(owner, initializer.text, false));
  });
  return matched;
}

function isReactHookFormFactoryCall(
  expression: ts.Expression,
  owner: RuntimeFunctionLike
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (!ts.isCallExpression(value)) return false;
  const callee = unwrapTransparentExpression(value.expression);
  if (!ts.isIdentifier(callee) || bindingDeclarationCount(owner, callee.text) !== 0) return false;
  return expression.getSourceFile().statements.some(statement =>
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === "react-hook-form" &&
    !!statement.importClause?.namedBindings &&
    ts.isNamedImports(statement.importClause.namedBindings) &&
    statement.importClause.namedBindings.elements.some(specifier =>
      specifier.name.text === callee.text &&
      ["useForm", "useFormContext"].includes(specifier.propertyName?.text ?? specifier.name.text)
    )
  );
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
  owner: RuntimeFunctionLike,
  requiresUnconditionalAwait: boolean
): boolean {
  const statement = call.parent;
  const block = statement.parent;
  if (!ts.isExpressionStatement(statement) || !ts.isBlock(block)) return false;
  const index = block.statements.indexOf(statement);
  if (index < 0) return false;

  const following = block.statements.slice(index + 1);
  for (let offset = 0; offset < following.length; offset += 1) {
    const candidate = following[offset]!;
    const awaitExpression = firstAwaitExpression(candidate);
    const awaitPosition = awaitExpression?.getStart() ?? null;
    const promiseBoundary = containsPromiseCompletionReset(candidate, setterCalls);
    const boundary = awaitPosition ?? (promiseBoundary ? candidate.end : null);
    if (boundary !== null) {
      return (!requiresUnconditionalAwait || awaitExpression === null ||
        awaitIsUnconditionallyReached(awaitExpression, candidate)) &&
        !containsOwnerStateWrite(
        candidate,
        boundary,
        ownerSetters,
        owner,
        new Set(),
        awaitPosition === null
      ) &&
        !containsEarlyExit(candidate, boundary) &&
        (!promiseBoundary ||
          !hasFollowingSynchronousOwnerWrite(
            nearestMutationFunction(call, owner).body,
            candidate.end,
            ownerSetters,
            owner
          ));
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

function hasFollowingSynchronousOwnerWrite(
  root: ts.ConciseBody | undefined,
  after: number,
  ownerSetters: ReadonlySet<string>,
  owner: RuntimeFunctionLike
): boolean {
  if (!root) return true;
  let found = false;
  const scan = (node: ts.Node): void => {
    if (found || node.end <= after) return;
    if (isRuntimeFunctionLike(node) && node !== root) return;
    if (
      ts.isCallExpression(node) &&
      node.getStart() > after &&
      ts.isIdentifier(node.expression)
    ) {
      if (ownerSetters.has(node.expression.text)) {
        found = true;
        return;
      }
      const helper = localFunctionBinding(owner, node.expression.text);
      if (
        helper?.body &&
        containsOwnerStateWrite(
          helper.body,
          helper.body.end,
          ownerSetters,
          owner,
          new Set()
        )
      ) {
        found = true;
        return;
      }
    }
    node.forEachChild(scan);
  };
  scan(root);
  return found;
}

function firstAwaitExpression(statement: ts.Statement): ts.AwaitExpression | null {
  let first: ts.AwaitExpression | null = null;
  visitSkippingNestedRuntimeFunctions(statement, node => {
    if (ts.isAwaitExpression(node) && (first === null || node.getStart() < first.getStart())) {
      first = node;
    }
  });
  return first;
}

function awaitIsUnconditionallyReached(
  awaitExpression: ts.AwaitExpression,
  boundary: ts.Statement
): boolean {
  for (
    let current: ts.Node = awaitExpression;
    current !== boundary;
    current = current.parent
  ) {
    const parent = current.parent;
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
  return kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken;
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

function asyncLeafCallSite(
  usage: StateUsage,
  owner: RuntimeFunctionLike
): {
  boundary: ts.Node;
  requiresUnconditionalAwait: boolean;
  returned: ts.Expression;
} | null {
  if (!owner.body) return null;
  const opening = asyncLeafOpening(usage, owner);
  if (
    opening === null ||
    nearestRepeatedRenderCall(opening.opening, owner) ||
    !nestedFunctionsAreJsxChildren(opening.opening, owner)
  ) {
    return null;
  }
  const callSite = jsxCallSite(opening.opening);
  if (
    usage.directRenderNodes.some(node =>
      !nodeWithin(node, callSite) ||
      findAncestorUntil(node, isRuntimeFunctionLike, callSite) !== null ||
      !isSafeLeafProjectionReference(node, owner)
    )
  ) {
    return null;
  }
  const returned = returnedExpressions(owner);
  const directReturn = returned.find(expression => nodeWithin(opening.opening, expression));
  if (directReturn) {
    return {
      boundary: callSite,
      requiresUnconditionalAwait: opening.requiresUnconditionalAwait,
      returned: directReturn,
    };
  }

  const declaration = findAncestorUntil(opening.opening, ts.isVariableDeclaration, owner);
  if (
    !declaration?.initializer ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, declaration.name.text) !== 1
  ) {
    return null;
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
  if (references.length !== 1) return null;
  const aliasReturn = returned.find(expression => nodeWithin(references[0]!, expression));
  return aliasReturn
    ? {
      boundary: references[0]!,
      requiresUnconditionalAwait: opening.requiresUnconditionalAwait,
      returned: aliasReturn,
    }
    : null;
}

function asyncLeafOpening(
  usage: StateUsage,
  owner: RuntimeFunctionLike
): {
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  requiresUnconditionalAwait: boolean;
} | null {
  const valueSite = [...usage.valueTransportSites][0];
  if (valueSite !== undefined) {
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
    return opening
      ? { opening, requiresUnconditionalAwait: false }
      : null;
  }

  const common = lowestCommonJsxSubtree(usage.directRenderNodes, owner);
  const gates = usage.directRenderNodes.map(node => commonRenderGateSubtree([node], owner));
  if (
    !common ||
    ts.isJsxFragment(common) ||
    gates.some(gate => gate !== null && gate !== common)
  ) {
    return null;
  }
  return {
    opening: ts.isJsxElement(common) ? common.openingElement : common,
    requiresUnconditionalAwait: gates.some(gate => gate === common),
  };
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
