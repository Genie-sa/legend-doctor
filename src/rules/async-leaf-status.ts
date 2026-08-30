import type { StateCandidate, StateUsage } from "../analyze-source.js";
import {
  bindingDeclarationCount,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import {
  commonRenderGateSubtree,
  hasStateInitializer,
  isSafeProjectionExpression,
} from "./deferred-reveal.js";
import {
  findAncestorUntil,
  isRuntimeFunctionLike,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import {
  hasIndependentRenderCutWitness,
  isHookDependencyReference,
  isSafeJsxProjectionReference,
  jsxElementCount,
  localFunctionBinding,
  lowestCommonJsxSubtree,
  nearestRepeatedRenderCall,
} from "./state-proofs.js";
import type { ChildContractResolver } from "./child-contract.js";
import type { RuntimeFunctionLike } from "../ast.js";
import ts from "typescript";

export interface AsyncLeafStatusAnalysis {
  cohesive: ReadonlySet<StateCandidate>;
  isolated: ReadonlySet<StateCandidate>;
  unproven: ReadonlySet<StateCandidate>;
}

type AsyncLeafStatus = "cohesive" | "isolated" | "unproven";

type CommandRegion = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

interface AsyncLeafStatusInputs {
  childContracts: ChildContractResolver | null;
  eventCallbacksByOwner: ReadonlyMap<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>;
  localComponents: ReadonlySet<string>;
  reactiveMutationAffectedStates: ReadonlySet<StateCandidate>;
  safeCommandStates: ReadonlySet<StateCandidate>;
  sourceComponents: ReadonlySet<string>;
  states: readonly StateCandidate[];
  usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

interface PendingCommand {
  alternateResetRegions: readonly CommandRegion[];
  ownerSetters: ReadonlySet<string>;
  pendingStart: ts.CallExpression;
  region: CommandRegion;
}

interface PendingSegmentProof {
  command: PendingCommand;
  leaves: AsyncLeafCallSites;
  owner: RuntimeFunctionLike;
  usage: StateUsage;
}

interface LeafStatusProof {
  command: PendingCommand;
  inputs: AsyncLeafStatusInputs;
  leaves: AsyncLeafCallSites;
  state: StateCandidate;
}

interface EventRootContext {
  childContracts: ChildContractResolver | null;
  eventCallbacks: ReadonlySet<RuntimeFunctionLike>;
  owner: RuntimeFunctionLike;
}

interface EventRootScan {
  context: EventRootContext;
  seen: ReadonlySet<string>;
}

interface AsyncSegmentScan {
  owner: RuntimeFunctionLike;
  ownerSetters: ReadonlySet<string>;
  requiresUnconditionalAwait: boolean;
  setterCalls: readonly ts.CallExpression[];
}

interface OwnerStateWriteScan {
  before: number;
  owner: RuntimeFunctionLike;
  ownerSetters: ReadonlySet<string>;
  seen: ReadonlySet<string>;
  skipPromiseContinuations?: boolean;
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

const EMPTY_EVENT_CALLBACKS: ReadonlySet<RuntimeFunctionLike> = new Set();

const EMPTY_SEEN: ReadonlySet<string> = new Set();

const USE_CALLBACK_ONLY: ReadonlySet<string> = new Set(["useCallback"]);

const MIN_SETTER_CALLS = 2;

const DENSE_JSX_ELEMENT_COUNT = 12;

const MAX_TRANSPORT_SITES = 3;

export function directReactHookFormEventCallbacks(
  owner: RuntimeFunctionLike,
): ReadonlySet<RuntimeFunctionLike> {
  const callbacks = new Set<RuntimeFunctionLike>();
  if (!owner.body) {
    return callbacks;
  }
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (
      !ts.isJsxAttribute(node) ||
      !/^on[A-Z]/u.test(node.name.getText()) ||
      !node.initializer ||
      !ts.isJsxExpression(node.initializer) ||
      !node.initializer.expression ||
      !jsxAttributeIsIntrinsicEvent(node)
    ) {
      return;
    }
    const handler = unwrapTransparentExpression(node.initializer.expression);
    const collectAdapter = (adapter: ts.CallExpression): void => {
      if (!isReactHookFormSubmitAdapter(adapter, owner)) {
        return;
      }
      for (const argument of adapter.arguments) {
        const candidate = unwrapTransparentExpression(argument);
        if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) {
          callbacks.add(candidate);
        } else if (ts.isIdentifier(candidate)) {
          const callback = localFunctionBinding(owner, candidate.text);
          if (callback) {
            callbacks.add(callback);
          }
        }
      }
    };
    if (ts.isCallExpression(handler)) {
      collectAdapter(handler);
    } else if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
      visitSkippingNestedRuntimeFunctions(handler.body, (candidate) => {
        if (ts.isCallExpression(candidate)) {
          collectAdapter(candidate);
        }
      });
    }
  });
  return callbacks;
}

export function findAsyncLeafStatuses(inputs: AsyncLeafStatusInputs): AsyncLeafStatusAnalysis {
  const { states } = inputs;
  const buckets = {
    cohesive: new Set<StateCandidate>(),
    isolated: new Set<StateCandidate>(),
    unproven: new Set<StateCandidate>(),
  };
  for (const state of states) {
    const status = asyncLeafStatus(state, inputs);
    if (status) {
      buckets[status].add(state);
    }
  }
  return buckets;
}

function asyncLeafStatus(
  state: StateCandidate,
  inputs: AsyncLeafStatusInputs,
): AsyncLeafStatus | null {
  const usage = inputs.usageByState.get(state);
  if (!usage || !isAsyncCommandFlagUsage(state, usage, inputs)) {
    return null;
  }
  const leaves = asyncLeafCallSites(usage, state.owner);
  if (!leaves) {
    return null;
  }
  const command = pendingCommand(state, usage, inputs.states);
  if (!command || !isProvenPendingSegment({ command, leaves, owner: state.owner, usage })) {
    return null;
  }
  return leafStatusFor({ command, inputs, leaves, state });
}

function isAsyncCommandFlagUsage(
  state: StateCandidate,
  usage: StateUsage,
  inputs: AsyncLeafStatusInputs,
): boolean {
  return (
    Boolean(state.setterName) &&
    hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) &&
    inputs.safeCommandStates.has(state) &&
    !inputs.reactiveMutationAffectedStates.has(state) &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    !usage.repeatedValueTransport &&
    usage.setterCallNodes.length >= MIN_SETTER_CALLS &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped &&
    usage.setterCallNodes.every((call) => isBooleanLiteralSetterCall(call))
  );
}

function isBooleanLiteralSetterCall(call: ts.CallExpression): boolean {
  return (
    call.arguments.length === 1 &&
    (call.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword ||
      call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword)
  );
}

function pendingCommand(
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

function isCommandRegion(region: ts.Node): region is CommandRegion {
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

function isProvenPendingSegment(proof: PendingSegmentProof): boolean {
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

function leafStatusFor(proof: LeafStatusProof): AsyncLeafStatus | null {
  const { command, inputs, leaves, state } = proof;
  if (!hasRenderCut(leaves, state.owner, inputs)) {
    return leaves.boundaries.length === 1 ? "cohesive" : null;
  }
  return isEventRootedCommand(command, state.owner, inputs) ? "isolated" : "unproven";
}

function hasRenderCut(
  leaves: AsyncLeafCallSites,
  owner: RuntimeFunctionLike,
  inputs: AsyncLeafStatusInputs,
): boolean {
  return (
    jsxElementCount(owner) >= DENSE_JSX_ELEMENT_COUNT ||
    hasIndependentRenderCutWitness({
      returned: leaves.returned,
      excluded: leaves.boundaries,
      localComponents: inputs.localComponents,
      sourceComponents: inputs.sourceComponents,
    })
  );
}

function isEventRootedCommand(
  command: PendingCommand,
  owner: RuntimeFunctionLike,
  inputs: AsyncLeafStatusInputs,
): boolean {
  const context: EventRootContext = {
    childContracts: inputs.childContracts,
    eventCallbacks: inputs.eventCallbacksByOwner.get(owner) ?? EMPTY_EVENT_CALLBACKS,
    owner,
  };
  return (
    asyncCallbackIsEventRooted(command.region, context) &&
    command.alternateResetRegions.every((candidate) =>
      asyncCallbackIsEventRooted(candidate, context),
    )
  );
}

function asyncCallbackIsEventRooted(
  callback: CommandRegion,
  context: EventRootContext,
  seen: ReadonlySet<string> = EMPTY_SEEN,
): boolean {
  if (context.eventCallbacks.has(callback) || isInlineDeferredEventHandler(callback, context)) {
    return true;
  }
  const name = commandRegionName(callback);
  if (!name || seen.has(name) || bindingDeclarationCount(context.owner, name) !== 1) {
    return false;
  }
  return referencesAreEventRooted(callback, name, {
    context,
    seen: new Set(seen).add(name),
  });
}

function isInlineDeferredEventHandler(callback: CommandRegion, context: EventRootContext): boolean {
  const attribute = findAncestorUntil(callback, ts.isJsxAttribute, context.owner);
  return (
    attribute?.initializer !== undefined &&
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression !== undefined &&
    unwrapTransparentExpression(attribute.initializer.expression) === callback &&
    jsxAttributeIsDeferredEvent(attribute, context.childContracts)
  );
}

function commandRegionName(callback: CommandRegion): string | undefined {
  if (ts.isFunctionDeclaration(callback)) {
    return callback.name?.text;
  }
  return ts.isVariableDeclaration(callback.parent) && ts.isIdentifier(callback.parent.name)
    ? callback.parent.name.text
    : undefined;
}

function referencesAreEventRooted(
  callback: CommandRegion,
  name: string,
  scan: EventRootScan,
): boolean {
  const { owner } = scan.context;
  let referenced = false;
  let safe = true;
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      isHookDependencyReference(node, USE_CALLBACK_ONLY)
    ) {
      return;
    }
    referenced = true;
    if (!referenceIsEventRooted(node, callback, scan)) {
      safe = false;
    }
  });
  return referenced && safe;
}

function referenceIsEventRooted(
  node: ts.Identifier,
  callback: CommandRegion,
  scan: EventRootScan,
): boolean {
  const { context, seen } = scan;
  const { owner } = context;
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
  if (
    attribute &&
    isDirectJsxAttributeExpression(attribute, node) &&
    jsxAttributeIsDeferredEvent(attribute, context.childContracts)
  ) {
    return true;
  }
  if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) {
    return false;
  }
  const caller = findAncestorUntil(node, isRuntimeFunctionLike, owner);
  return (
    caller !== null &&
    caller !== callback &&
    isCommandRegion(caller) &&
    asyncCallbackIsEventRooted(caller, context, seen)
  );
}

function jsxAttributeIsDeferredEvent(
  attribute: ts.JsxAttribute,
  childContracts: ChildContractResolver | null,
): boolean {
  if (jsxAttributeIsIntrinsicEvent(attribute)) {
    return true;
  }
  if (!/^on[A-Z]/u.test(attribute.name.getText()) || !childContracts) {
    return false;
  }
  const opening = attribute.parent.parent;
  const tag =
    ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening) ? opening.tagName : null;
  const target =
    tag && (ts.isIdentifier(tag) || ts.isPropertyAccessExpression(tag)) ? tag.getText() : null;
  return (
    target !== null &&
    (childContracts.frameworkEventComponent(target) ||
      childContracts.componentCallbackPropIsDeferredAtInvocation(
        target,
        attribute.name.getText(),
        opening,
      ))
  );
}

function jsxAttributeIsIntrinsicEvent(attribute: ts.JsxAttribute): boolean {
  if (!/^on[A-Z]/u.test(attribute.name.getText())) {
    return false;
  }
  const opening = attribute.parent.parent;
  const tag =
    ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening) ? opening.tagName : null;
  return tag !== null && ts.isIdentifier(tag) && /^[a-z]/u.test(tag.text);
}

function isReactHookFormSubmitAdapter(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): boolean {
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    return (
      bindingDeclarationCount(owner, callee.text) === 1 &&
      ownerHasReactHookFormBinding(owner, callee.text, true)
    );
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "handleSubmit" &&
    ts.isIdentifier(callee.expression) &&
    bindingDeclarationCount(owner, callee.expression.text) === 1 &&
    ownerHasReactHookFormBinding(owner, callee.expression.text, false)
  );
}

function ownerHasReactHookFormBinding(
  owner: RuntimeFunctionLike,
  localName: string,
  destructuredHandleSubmit: boolean,
): boolean {
  if (!owner.body) {
    return false;
  }
  let matched = false;
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (
      matched ||
      !ts.isVariableDeclaration(node) ||
      !node.initializer ||
      !declarationBindsName(node, localName, destructuredHandleSubmit)
    ) {
      return;
    }
    const initializer = unwrapTransparentExpression(node.initializer);
    matched =
      isReactHookFormFactoryCall(initializer, owner) ||
      (destructuredHandleSubmit &&
        ts.isIdentifier(initializer) &&
        bindingDeclarationCount(owner, initializer.text) === 1 &&
        ownerHasReactHookFormBinding(owner, initializer.text, false));
  });
  return matched;
}

function declarationBindsName(
  node: ts.VariableDeclaration,
  localName: string,
  destructuredHandleSubmit: boolean,
): boolean {
  if (!destructuredHandleSubmit) {
    return ts.isIdentifier(node.name) && node.name.text === localName;
  }
  return (
    ts.isObjectBindingPattern(node.name) &&
    node.name.elements.some(
      (candidate) =>
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === localName &&
        (candidate.propertyName
          ? ts.isIdentifier(candidate.propertyName) &&
            candidate.propertyName.text === "handleSubmit"
          : candidate.name.text === "handleSubmit"),
    )
  );
}

function isReactHookFormFactoryCall(
  expression: ts.Expression,
  owner: RuntimeFunctionLike,
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (!ts.isCallExpression(value)) {
    return false;
  }
  const callee = unwrapTransparentExpression(value.expression);
  if (!ts.isIdentifier(callee) || bindingDeclarationCount(owner, callee.text) !== 0) {
    return false;
  }
  return expression
    .getSourceFile()
    .statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "react-hook-form" &&
        statement.importClause !== undefined &&
        statement.importClause.namedBindings !== undefined &&
        ts.isNamedImports(statement.importClause.namedBindings) &&
        statement.importClause.namedBindings.elements.some(
          (specifier) =>
            specifier.name.text === callee.text &&
            ["useForm", "useFormContext"].includes(
              specifier.propertyName?.text ?? specifier.name.text,
            ),
        ),
    );
}

function asyncCommandRegion(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): RuntimeFunctionLike {
  let region = nearestMutationFunction(call, owner);
  while (region !== owner && isPromiseContinuationCallback(region)) {
    region = nearestMutationFunction(region, owner);
  }
  return region;
}

function nearestMutationFunction(node: ts.Node, owner: RuntimeFunctionLike): RuntimeFunctionLike {
  return findAncestorUntil(node, isRuntimeFunctionLike, owner) ?? owner;
}

function isPromiseContinuationCallback(region: RuntimeFunctionLike): boolean {
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

function containsOwnerStateWrite(root: ts.Node, scan: OwnerStateWriteScan): boolean {
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

interface AsyncLeafCallSites {
  boundaries: readonly ts.Node[];
  requiresUnconditionalAwait: boolean;
  returned: ts.Expression;
}

interface AsyncLeafSite {
  boundary: ts.Node;
  requiresUnconditionalAwait: boolean;
  returned: ts.Expression;
}

interface AsyncLeafOpening {
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  requiresUnconditionalAwait: boolean;
}

function asyncLeafCallSites(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
): AsyncLeafCallSites | null {
  if (usage.valueTransportSites.size <= 1) {
    const leaf = asyncLeafCallSite(usage, owner);
    return leaf
      ? {
          boundaries: [leaf.boundary],
          requiresUnconditionalAwait: leaf.requiresUnconditionalAwait,
          returned: leaf.returned,
        }
      : null;
  }
  if (
    !owner.body ||
    usage.localRenderReads !== 0 ||
    usage.transportedOccurrences !== usage.valueTransportSites.size ||
    usage.valueTransportSites.size > MAX_TRANSPORT_SITES
  ) {
    return null;
  }
  const openings = transportOpenings(owner, usage.valueTransportSites);
  return openings ? commonLeafCallSites(openings, owner) : null;
}

function transportOpenings(
  owner: RuntimeFunctionLike,
  sites: ReadonlySet<number>,
): (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] | null {
  const openings: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  visit(owner.body, (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      sites.has(node.getStart())
    ) {
      openings.push(node);
    }
  });
  const proven =
    openings.length === sites.size &&
    !openings.some(
      (opening) =>
        nearestRepeatedRenderCall(opening, owner) || !nestedFunctionsAreJsxChildren(opening, owner),
    );
  return proven ? openings : null;
}

function commonLeafCallSites(
  openings: readonly (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[],
  owner: RuntimeFunctionLike,
): AsyncLeafCallSites | null {
  const boundaries = openings.map((opening) => jsxCallSite(opening));
  const returned = returnedExpressions(owner).filter((expression) =>
    boundaries.every((boundary) => nodeWithin(boundary, expression)),
  );
  const [only] = returned;
  return returned.length === 1 && only
    ? { boundaries, requiresUnconditionalAwait: false, returned: only }
    : null;
}

function asyncLeafCallSite(usage: StateUsage, owner: RuntimeFunctionLike): AsyncLeafSite | null {
  if (!owner.body) {
    return null;
  }
  const opening = asyncLeafOpening(usage, owner);
  if (!opening || !isProvenLeafOpening(opening.opening, usage, owner)) {
    return null;
  }
  const callSite = jsxCallSite(opening.opening);
  const returned = returnedExpressions(owner);
  const directReturn = returned.find((expression) => nodeWithin(opening.opening, expression));
  return directReturn
    ? {
        boundary: callSite,
        requiresUnconditionalAwait: opening.requiresUnconditionalAwait,
        returned: directReturn,
      }
    : aliasLeafCallSite(opening, returned, owner);
}

function isProvenLeafOpening(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  usage: StateUsage,
  owner: RuntimeFunctionLike,
): boolean {
  if (nearestRepeatedRenderCall(opening, owner) || !nestedFunctionsAreJsxChildren(opening, owner)) {
    return false;
  }
  const callSite = jsxCallSite(opening);
  return !usage.directRenderNodes.some(
    (node) =>
      !nodeWithin(node, callSite) ||
      findAncestorUntil(node, isRuntimeFunctionLike, callSite) !== null ||
      !isSafeLeafProjectionReference(node, owner),
  );
}

function aliasLeafCallSite(
  opening: AsyncLeafOpening,
  returned: readonly ts.Expression[],
  owner: RuntimeFunctionLike,
): AsyncLeafSite | null {
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
  const references = aliasReferences(owner, declaration.name);
  const [reference] = references;
  if (references.length !== 1 || !reference) {
    return null;
  }
  const aliasReturn = returned.find((expression) => nodeWithin(reference, expression));
  return aliasReturn
    ? {
        boundary: reference,
        requiresUnconditionalAwait: opening.requiresUnconditionalAwait,
        returned: aliasReturn,
      }
    : null;
}

function aliasReferences(owner: RuntimeFunctionLike, name: ts.Identifier): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === name.getText() &&
      node !== name &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references;
}

function asyncLeafOpening(usage: StateUsage, owner: RuntimeFunctionLike): AsyncLeafOpening | null {
  const [valueSite] = [...usage.valueTransportSites];
  if (valueSite !== undefined) {
    let opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement | null = null;
    visit(owner.body, (node) => {
      if (
        opening === null &&
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.getStart() === valueSite
      ) {
        opening = node;
      }
    });
    return opening ? { opening, requiresUnconditionalAwait: false } : null;
  }

  const common = lowestCommonJsxSubtree(usage.directRenderNodes, owner);
  const gates = usage.directRenderNodes.map((node) => commonRenderGateSubtree([node], owner));
  if (
    !common ||
    ts.isJsxFragment(common) ||
    gates.some((gate) => gate !== null && gate !== common)
  ) {
    return null;
  }
  return {
    opening: ts.isJsxElement(common) ? common.openingElement : common,
    requiresUnconditionalAwait: gates.some((gate) => gate === common),
  };
}

function jsxCallSite(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): ts.Node {
  return ts.isJsxOpeningElement(opening) ? opening.parent : opening;
}

function isSafeLeafProjectionReference(node: ts.Node, owner: RuntimeFunctionLike): boolean {
  if (isSafeJsxProjectionReference(node, owner)) {
    return true;
  }
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (ts.isConditionalExpression(current) && nodeWithin(node, current.condition)) {
      return isSafeProjectionExpression({ expression: current.condition, reference: node });
    }
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      nodeWithin(node, current.left)
    ) {
      return isSafeProjectionExpression({ expression: current.left, reference: node });
    }
  }
  return false;
}

function nestedFunctionsAreJsxChildren(node: ts.Node, owner: RuntimeFunctionLike): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (!isRuntimeFunctionLike(current)) {
      continue;
    }
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
  if (!owner.body) {
    return [];
  }
  const expressions: ts.Expression[] = [];
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      expressions.push(node.expression);
    }
  });
  return expressions;
}
