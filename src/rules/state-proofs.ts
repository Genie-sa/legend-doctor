import {
  bindingDeclarationCount,
  hookCallName,
  isDeclarationName,
  isInsideJsxAttribute,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import {
  findAncestor,
  findAncestorUntil,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import { isSafeProjectionExpression, jsxSubtreeAncestors } from "./deferred-reveal.js";
import type { JsxSubtreeNode } from "./deferred-reveal.js";
import type { RuntimeFunctionLike } from "../ast.js";
import type { StateCandidate } from "../analyze-source.js";
import ts from "typescript";

const uniqueVariableDeclarationsByBoundary = new WeakMap<
  ts.Node,
  ReadonlyMap<string, ts.VariableDeclaration | null>
>();

const localFunctionBindingsByOwner = new WeakMap<
  RuntimeFunctionLike,
  ReadonlyMap<string, ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression>
>();

/** Two independent elements are the smallest render cut worth reporting on its own. */
const MIN_INDEPENDENT_JSX_ELEMENTS = 2;

/** A projection trail that stops on its own is only trusted once it has settled for two hops. */
const MIN_SETTLED_PROJECTION_HOPS = 2;

const EVENT_HANDLER_PROP = /^on[A-Z]/u;
const USE_CALLBACK_HOOK: ReadonlySet<string> = new Set(["useCallback"]);
const EMPTY_BINDINGS: ReadonlySet<string> = new Set();
const EMPTY_NODES: ReadonlySet<ts.Node> = new Set();
const EMPTY_RUNTIME_FUNCTIONS: ReadonlySet<RuntimeFunctionLike> = new Set();
const PURE_MATH_PROJECTION_CALLS: ReadonlySet<string> = new Set(["Math.max", "Math.min"]);
const jsxElementCounts = new WeakMap<ts.Node, number>();

export { stateMayHoldCallable, stateTypeMayBeCallable } from "./callable-state.js";

export function hasIndependentRenderCutWitness(
  returned: ts.Expression,
  excluded: readonly ts.Node[],
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>,
): boolean {
  let hasIndependentComponent = false;
  let independentElements = 0;
  visitSkippingNestedRuntimeFunctions(returned, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) {
      return;
    }
    const subtree: ts.Node = ts.isJsxOpeningElement(node) ? node.parent : node;
    if (
      !isIndependentOfAll(subtree, excluded) ||
      hasIndependentJsxAncestor(subtree, returned, excluded)
    ) {
      return;
    }
    independentElements += 1;
    hasIndependentComponent ||= containsComponentBoundary(
      subtree,
      localComponents,
      sourceComponents,
    );
  });
  return hasIndependentComponent || independentElements >= MIN_INDEPENDENT_JSX_ELEMENTS;
}

/** The candidate neither is, nor contains, nor sits inside any already-excluded subtree. */
function isIndependentOfAll(candidate: ts.Node, excluded: readonly ts.Node[]): boolean {
  return excluded.every(
    (subtree) =>
      candidate !== subtree && !nodeWithin(candidate, subtree) && !nodeWithin(subtree, candidate),
  );
}

/** A nearer independent JSX ancestor already counts this subtree, so it must not count again. */
function hasIndependentJsxAncestor(
  subtree: ts.Node,
  returned: ts.Node,
  excluded: readonly ts.Node[],
): boolean {
  for (
    let current: ts.Node | undefined = subtree.parent;
    current && current !== returned;
    current = current.parent
  ) {
    if (
      (ts.isJsxElement(current) ||
        ts.isJsxFragment(current) ||
        ts.isJsxSelfClosingElement(current)) &&
      isIndependentOfAll(current, excluded)
    ) {
      return true;
    }
  }
  return false;
}

function containsComponentBoundary(
  subtree: ts.Node,
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>,
): boolean {
  let found = false;
  visit(subtree, (descendant) => {
    if (found || (!ts.isJsxOpeningElement(descendant) && !ts.isJsxSelfClosingElement(descendant))) {
      return;
    }
    const name = descendant.tagName.getText();
    found =
      isComponentBoundaryName(name) || localComponents.has(name) || sourceComponents.has(name);
  });
  return found;
}

function isComponentBoundaryName(name: string): boolean {
  const member = name.slice(name.lastIndexOf(".") + 1);
  return member !== "Fragment" && (name.includes(".") || /^[A-Z]/u.test(name));
}

export function oneHopRenderProjectionReferences(
  owner: RuntimeFunctionLike,
  renderNodes: readonly ts.Node[],
  isAllowedProjection: (
    expression: ts.Expression,
    reference: ts.Node,
  ) => boolean = isSafeProjectionExpression,
): readonly ts.Identifier[] | null {
  if (renderNodes.length === 0 || renderNodes.some((node) => !ts.isIdentifier(node))) {
    return null;
  }
  const declaration = soleVariableDeclaration(renderNodes, owner);
  if (!declaration) {
    // SAFETY: The entry guard proves every render node is an Identifier.
    return renderNodes as readonly ts.Identifier[];
  }
  const projection = constProjectionDeclaration(declaration, owner, renderNodes);
  if (
    !projection ||
    !renderNodes.every((node) => isAllowedProjection(projection.initializer, node))
  ) {
    return null;
  }
  const references = bindingReferences(owner, projection.name);
  return references.length > 0 ? references : null;
}

export function boundedRenderProjectionReferences(
  owner: RuntimeFunctionLike,
  renderNodes: readonly ts.Node[],
  maxHops = 3,
): readonly ts.Identifier[] | null {
  if (renderNodes.length === 0 || renderNodes.some((node) => !ts.isIdentifier(node))) {
    return null;
  }
  // SAFETY: The entry guard proves every render node is an Identifier.
  return followProjectionHops(renderNodes as readonly ts.Identifier[], owner, maxHops);
}

/**
 * Walks up to `maxHops` single-declaration projection hops. The trail settles when a hop has no
 * enclosing declaration left; running out of hops instead requires the references to be free.
 */
function followProjectionHops(
  renderNodes: readonly ts.Identifier[],
  owner: RuntimeFunctionLike,
  maxHops: number,
): readonly ts.Identifier[] | null {
  let references = renderNodes;
  for (let hops = 0; hops < maxHops; hops += 1) {
    const declaration = soleVariableDeclaration(references, owner);
    if (!declaration) {
      return hops >= MIN_SETTLED_PROJECTION_HOPS ? references : null;
    }
    const next = nextProjectionHop(declaration, owner, references);
    if (!next) {
      return null;
    }
    references = next;
  }
  return references.some((node) => findAncestorUntil(node, ts.isVariableDeclaration, owner))
    ? null
    : references;
}

/** The references to the declared binding, or null when this hop is not a safe pure projection. */
function nextProjectionHop(
  declaration: ts.VariableDeclaration,
  owner: RuntimeFunctionLike,
  references: readonly ts.Identifier[],
): ts.Identifier[] | null {
  const projection = constProjectionDeclaration(declaration, owner, references);
  if (
    !projection ||
    !references.every((node) =>
      isSafeProjectionExpression(
        projection.initializer,
        node,
        EMPTY_BINDINGS,
        sourceHasRuntimeBinding(owner.getSourceFile(), "Math")
          ? EMPTY_BINDINGS
          : PURE_MATH_PROJECTION_CALLS,
      ),
    )
  ) {
    return null;
  }
  const next = bindingReferences(owner, projection.name);
  return next.length > 0 ? next : null;
}

/** The one variable declaration that encloses every node, or null when they disagree. */
function soleVariableDeclaration(
  nodes: readonly ts.Node[],
  owner: RuntimeFunctionLike,
): ts.VariableDeclaration | null {
  const declarations = new Set(
    nodes.map((node) => findAncestorUntil(node, ts.isVariableDeclaration, owner)),
  );
  if (declarations.size !== 1) {
    return null;
  }
  const [declaration] = declarations;
  return declaration ?? null;
}

/** A uniquely bound `const x = <initializer>` whose initializer contains every reference. */
function constProjectionDeclaration(
  declaration: ts.VariableDeclaration,
  owner: RuntimeFunctionLike,
  references: readonly ts.Node[],
): { readonly initializer: ts.Expression; readonly name: ts.Identifier } | null {
  const { initializer, name } = declaration;
  if (
    !initializer ||
    !ts.isIdentifier(name) ||
    !references.every((node) => nodeWithin(node, initializer)) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, name.text) !== 1
  ) {
    return null;
  }
  return { initializer, name };
}

/** Every value reference to the binding inside the owner, excluding its own declaration name. */
function bindingReferences(owner: RuntimeFunctionLike, name: ts.Identifier): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === name.text &&
      node !== name &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references;
}

export function sourceHasRuntimeBinding(sourceFile: ts.SourceFile, name: string): boolean {
  let found = false;
  visit(sourceFile, (node) => {
    if (!found && nodeBindsRuntimeName(node, name)) {
      found = true;
    }
  });
  return found;
}

/** The node introduces a runtime binding for the name, shadowing any global of that name. */
function nodeBindsRuntimeName(node: ts.Node, name: string): boolean {
  if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
    return bindingContainsName(node.name, name);
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  ) {
    return node.name?.text === name;
  }
  if (ts.isCatchClause(node)) {
    return (
      node.variableDeclaration !== undefined &&
      bindingContainsName(node.variableDeclaration.name, name)
    );
  }
  return (
    (ts.isImportClause(node) && node.name?.text === name) ||
    (ts.isImportSpecifier(node) && node.name.text === name) ||
    (ts.isNamespaceImport(node) && node.name.text === name)
  );
}

export function isUnshadowedMathCall(
  owner: RuntimeFunctionLike,
  call: ts.CallExpression,
  methods: ReadonlySet<string>,
): boolean {
  const callee = call.expression;
  return (
    !sourceHasRuntimeBinding(owner.getSourceFile(), "Math") &&
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Math" &&
    methods.has(callee.name.text)
  );
}

export function hasDirectPrimitiveInitializer(state: StateCandidate): boolean {
  const [initializer] = state.call.arguments;
  return initializer !== undefined && isDirectPrimitiveExpression(initializer);
}

export function setterCallUsesPreviousValue(call: ts.CallExpression): boolean {
  const [argument] = call.arguments;
  if (!argument || (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument))) {
    return false;
  }
  const [parameter] = argument.parameters;
  if (!parameter || !ts.isIdentifier(parameter.name)) {
    return false;
  }
  const parameterName = parameter.name.text;
  let referenced = false;
  visit(argument.body, (node) => {
    if (ts.isIdentifier(node) && node.text === parameterName && node !== parameter.name) {
      referenced = true;
    }
  });
  return referenced;
}

export function isDirectPrimitiveExpression(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  if (
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value)
  ) {
    return true;
  }
  return (
    ts.isPrefixUnaryExpression(value) &&
    (value.operator === ts.SyntaxKind.PlusToken || value.operator === ts.SyntaxKind.MinusToken) &&
    (ts.isNumericLiteral(value.operand) || ts.isBigIntLiteral(value.operand))
  );
}

export function hasOnlyEventCommandReads(
  state: StateCandidate,
  ignored: ReadonlySet<ts.Node> = EMPTY_NODES,
  additionalRoots: ReadonlySet<RuntimeFunctionLike> = EMPTY_RUNTIME_FUNCTIONS,
): boolean {
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      node.parent === state.call.parent ||
      ignored.has(node) ||
      findAncestorUntil(node, isJsxNode, state.owner)
    ) {
      return;
    }
    safe = stateReadIsEventCommand(node, state, additionalRoots);
  });
  return safe;
}

/** A read outside JSX is safe only from an event-rooted callback, or as a useCallback dependency. */
function stateReadIsEventCommand(
  reference: ts.Identifier,
  state: StateCandidate,
  additionalRoots: ReadonlySet<RuntimeFunctionLike>,
): boolean {
  const callback = nearestNestedFunction(reference, state.owner);
  if (callback) {
    return callbackOrAncestorIsEventRooted(callback, state, additionalRoots);
  }
  if (!isHookDependencyReference(reference, USE_CALLBACK_HOOK)) {
    return false;
  }
  const call = findAncestorUntil(reference, ts.isCallExpression, state.owner);
  const candidate = call?.arguments[0];
  return (
    candidate !== undefined &&
    (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) &&
    callbackIsEventRooted(candidate, state.owner, state.valueName, new Set(), (root) =>
      additionalRoots.has(root),
    )
  );
}

function callbackOrAncestorIsEventRooted(
  callback: RuntimeFunctionLike,
  state: StateCandidate,
  additionalRoots: ReadonlySet<RuntimeFunctionLike>,
): boolean {
  for (
    let candidate: ts.Node | undefined = callback;
    candidate && candidate !== state.owner;
    candidate =
      additionalRoots.size > 0
        ? (findAncestor(candidate, isRuntimeFunctionLike) ?? undefined)
        : undefined
  ) {
    if (
      isPlainFunction(candidate) &&
      callbackIsEventRooted(candidate, state.owner, state.valueName, new Set(), (root) =>
        additionalRoots.has(root),
      )
    ) {
      return true;
    }
  }
  return false;
}

export function callbackIsEventRooted(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  dependencyName: string,
  seen: ReadonlySet<string>,
  additionalRoot: AdditionalEventRoot = () => false,
): boolean {
  if (additionalRoot(callback, owner)) {
    return true;
  }
  if (callback.body && isInsideJsxEventCallback(callback.body, owner)) {
    return true;
  }
  const name = eventCallbackName(callback);
  if (!name || seen.has(name) || bindingDeclarationCount(owner, name) !== 1) {
    return false;
  }
  if (!useCallbackListsDependency(callback, dependencyName)) {
    return false;
  }
  return everyReferenceIsEventRooted(name, {
    additionalRoot,
    dependencyName,
    owner,
    seen: new Set(seen).add(name),
  });
}

type AdditionalEventRoot = (
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
) => boolean;

/** What a nested `callbackIsEventRooted` recursion needs to carry from its caller. */
interface EventRootTrace {
  readonly additionalRoot: AdditionalEventRoot;
  readonly dependencyName: string;
  readonly owner: RuntimeFunctionLike;
  readonly seen: ReadonlySet<string>;
}

/** The name this callback is bound to, whether by declaration, assignment, or a hook wrapper. */
function eventCallbackName(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
): string | undefined {
  if (ts.isFunctionDeclaration(callback)) {
    return callback.name?.text;
  }
  const { parent } = callback;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return ts.isCallExpression(parent) &&
    ts.isVariableDeclaration(parent.parent) &&
    ts.isIdentifier(parent.parent.name)
    ? parent.parent.name.text
    : undefined;
}

/** A useCallback wrapper stays event-rooted only while it lists the state value as a dependency. */
function useCallbackListsDependency(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  dependencyName: string,
): boolean {
  const { parent } = callback;
  if (!dependencyName || !ts.isCallExpression(parent) || hookCallName(parent) !== "useCallback") {
    return true;
  }
  const [, dependencies] = parent.arguments;
  return (
    dependencies !== undefined &&
    ts.isArrayLiteralExpression(dependencies) &&
    dependencies.elements.some(
      (element) => ts.isIdentifier(element) && element.text === dependencyName,
    )
  );
}

/** The named callback is referenced at least once, and every reference stays event-rooted. */
function everyReferenceIsEventRooted(name: string, trace: EventRootTrace): boolean {
  let referenced = false;
  let safe = true;
  visit(trace.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      isHookDependencyReference(node, USE_CALLBACK_HOOK)
    ) {
      return;
    }
    referenced = true;
    if (!eventReferenceIsRooted(node, trace)) {
      safe = false;
    }
  });
  return referenced && safe;
}

/** The reference is a JSX event handler, or a call made from another event-rooted callback. */
function eventReferenceIsRooted(reference: ts.Identifier, trace: EventRootTrace): boolean {
  const attribute = findAncestorUntil(reference, ts.isJsxAttribute, trace.owner);
  if (
    attribute &&
    EVENT_HANDLER_PROP.test(attribute.name.getText()) &&
    isJsxEventHandlerReference(attribute, reference)
  ) {
    return true;
  }
  if (!ts.isCallExpression(reference.parent) || reference.parent.expression !== reference) {
    return false;
  }
  const caller = nearestNestedFunction(reference, trace.owner);
  return (
    caller !== null &&
    isPlainFunction(caller) &&
    callbackIsEventRooted(
      caller,
      trace.owner,
      trace.dependencyName,
      trace.seen,
      trace.additionalRoot,
    )
  );
}

function isPlainFunction(
  node: ts.Node,
): node is ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression {
  return (
    ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
  );
}

export function isJsxEventHandlerReference(
  attribute: ts.JsxAttribute,
  reference: ts.Identifier,
): boolean {
  const { initializer } = attribute;
  if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) {
    return false;
  }
  return isConditionalHandlerBranch(initializer.expression, reference);
}

function isConditionalHandlerBranch(expression: ts.Expression, reference: ts.Identifier): boolean {
  const value = unwrapTransparentExpression(expression);
  if (value === reference) {
    return true;
  }
  return (
    ts.isConditionalExpression(value) &&
    (isConditionalHandlerBranch(value.whenTrue, reference) ||
      isConditionalHandlerBranch(value.whenFalse, reference))
  );
}

export function isSafeJsxProjectionReference(
  node: ts.Node,
  boundary: ts.Node,
  allowedIdentifierCalls: ReadonlySet<string> = EMPTY_BINDINGS,
): boolean {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, boundary);
  if (attribute) {
    if (attribute.name.getText() === "key") {
      return false;
    }
    const { initializer } = attribute;
    return (
      initializer !== undefined &&
      ts.isJsxExpression(initializer) &&
      initializer.expression !== undefined &&
      isSafeProjectionExpression(initializer.expression, node, allowedIdentifierCalls)
    );
  }
  const expression = findAncestorUntil(node, ts.isJsxExpression, boundary);
  return (
    expression !== null &&
    expression.expression !== undefined &&
    isSafeProjectionExpression(expression.expression, node, allowedIdentifierCalls)
  );
}

export function nearestRepeatedRenderCall(
  node: ts.Node,
  boundary: ts.Node,
): ts.CallExpression | null {
  for (
    let current: ts.Node | undefined = node;
    current && current !== boundary;
    current = current.parent
  ) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ["map", "flatMap"].includes(current.expression.name.text)
    ) {
      return current;
    }
  }
  return null;
}

export function lowestCommonJsxSubtree(
  nodes: readonly ts.Node[],
  boundary: ts.Node,
): JsxSubtreeNode | null {
  const ancestorLists = nodes.map((node) => jsxSubtreeAncestors(node, boundary));
  const [first] = ancestorLists;
  if (!first || ancestorLists.some((ancestors) => ancestors.length === 0)) {
    return null;
  }
  return (
    first.find((candidate) => ancestorLists.every((ancestors) => ancestors.includes(candidate))) ??
    null
  );
}

export function jsxElementCountIn(node: ts.Node): number {
  const cached = jsxElementCounts.get(node);
  if (cached !== undefined) {
    return cached;
  }
  let count = 0;
  visit(node, (current) => {
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) {
      count += 1;
    }
  });
  jsxElementCounts.set(node, count);
  return count;
}

export function jsxElementCount(owner: RuntimeFunctionLike): number {
  return owner.body ? jsxElementCountIn(owner.body) : 0;
}

export function hasRepeatedJsxRenderWorkOutside(
  owner: RuntimeFunctionLike,
  excludedSubtree: ts.Node,
): boolean {
  if (!owner.body) {
    return false;
  }
  let repeated = false;
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (
      repeated ||
      !ts.isCallExpression(node) ||
      nodeWithin(node, excludedSubtree) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      !["map", "flatMap"].includes(node.expression.name.text) ||
      node.questionDotToken !== undefined ||
      node.expression.questionDotToken !== undefined ||
      isConditionallyEvaluated(node, owner)
    ) {
      return;
    }
    const [callback] = node.arguments;
    if (
      callback &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      jsxElementCountIn(callback.body) > 0
    ) {
      repeated = true;
    }
  });
  return repeated;
}

function isConditionallyEvaluated(node: ts.Node, boundary: ts.Node): boolean {
  for (let current = node.parent; current && current !== boundary; current = current.parent) {
    if (
      ts.isConditionalExpression(current) ||
      ts.isIfStatement(current) ||
      ts.isSwitchStatement(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current) ||
      ts.isTryStatement(current) ||
      ts.isCatchClause(current) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
    ) {
      return true;
    }
  }
  return false;
}

export function hasUnstableSubtreeLifetime(node: JsxSubtreeNode, boundary: ts.Node): boolean {
  let renderReturns = 0;
  visitSkippingNestedRuntimeFunctions(boundary, (current) => {
    if (ts.isReturnStatement(current) && current.expression) {
      renderReturns += 1;
    }
  });
  if (renderReturns > 1) {
    return true;
  }
  for (
    let current: ts.Node | undefined = node;
    current && current !== boundary;
    current = current.parent
  ) {
    if (
      (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) &&
      (ts.isJsxElement(current) ? current.openingElement : current).attributes.properties.some(
        (property) => ts.isJsxAttribute(property) && property.name.getText() === "key",
      )
    ) {
      return true;
    }
    if (
      ts.isConditionalExpression(current) ||
      ts.isIfStatement(current) ||
      ts.isSwitchStatement(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) ||
      (ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        ["map", "flatMap"].includes(current.expression.name.text))
    ) {
      return true;
    }
  }
  return false;
}

export function isInsideJsxEventCallback(node: ts.Node, boundary: RuntimeFunctionLike): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (!isRuntimeFunctionLike(current)) {
      continue;
    }
    const attribute = findAncestorUntil(current, ts.isJsxAttribute, boundary);
    if (
      attribute &&
      isInsideJsxAttribute(current, attribute) &&
      EVENT_HANDLER_PROP.test(attribute.name.getText())
    ) {
      return true;
    }
  }
  return false;
}

export function isSynchronousRenderCallback(node: ts.FunctionLikeDeclaration): boolean {
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && isImmediatelyInvoked(node)) {
    return true;
  }
  const { parent } = node;
  if (!ts.isCallExpression(parent)) {
    return false;
  }
  if (ts.isIdentifier(parent.expression) && parent.expression.text === "useMemo") {
    return true;
  }
  return (
    ts.isPropertyAccessExpression(parent.expression) &&
    [
      "every",
      "filter",
      "find",
      "findIndex",
      "flatMap",
      "map",
      "reduce",
      "reduceRight",
      "some",
    ].includes(parent.expression.name.text)
  );
}

/** The function is the callee of its own call, seen through transparent wrapper expressions. */
function isImmediatelyInvoked(node: ts.ArrowFunction | ts.FunctionExpression): boolean {
  let expression: ts.Expression = node;
  while (
    (ts.isParenthesizedExpression(expression.parent) ||
      ts.isAsExpression(expression.parent) ||
      ts.isTypeAssertionExpression(expression.parent) ||
      ts.isSatisfiesExpression(expression.parent) ||
      ts.isNonNullExpression(expression.parent)) &&
    expression.parent.expression === expression
  ) {
    expression = expression.parent;
  }
  return ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
}

export function isJsxNode(
  node: ts.Node,
): node is
  | ts.JsxElement
  | ts.JsxSelfClosingElement
  | ts.JsxExpression
  | ts.JsxAttribute
  | ts.JsxFragment {
  return (
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxExpression(node) ||
    ts.isJsxAttribute(node) ||
    ts.isJsxFragment(node)
  );
}

export function isHookDependencyReference(
  node: ts.Identifier,
  hookNames: ReadonlySet<string>,
  namespaces?: ReadonlySet<string>,
): boolean {
  const array = node.parent;
  if (!ts.isArrayLiteralExpression(array) || !array.elements.includes(node)) {
    return false;
  }
  const call = array.parent;
  if (!ts.isCallExpression(call) || call.arguments[1] !== array) {
    return false;
  }
  if (ts.isIdentifier(call.expression)) {
    return hookNames.has(call.expression.text);
  }
  return (
    namespaces !== undefined &&
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    namespaces.has(call.expression.expression.text) &&
    hookNames.has(call.expression.name.text)
  );
}

export function repeatedRenderHasStableItemKey(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  const parameter = callback.parameters[0]?.name;
  if (!parameter) {
    return false;
  }
  let stable = false;
  visitSkippingNestedRuntimeFunctions(callback.body, (node) => {
    if (!ts.isJsxAttribute(node) || node.name.getText() !== "key" || !node.initializer) {
      return;
    }
    const expression = ts.isJsxExpression(node.initializer) ? node.initializer.expression : null;
    if (!expression) {
      return;
    }
    if (expressionDependsOnBinding(expression, parameter, callback)) {
      stable = true;
    }
  });
  return stable;
}

export function isUniquelySelectedRepeatedProjection(
  nodes: readonly ts.Node[],
  boundary: RuntimeFunctionLike,
): boolean {
  const selection = uniqueMapSelection(nodes, boundary);
  if (!selection) {
    return false;
  }
  const clause = soleCaseClause(nodes, selection.callback);
  if (!clause || !isPrimitiveLiteral(clause.expression)) {
    return false;
  }
  return (
    clauseSwitchesOnItem(clause, selection) &&
    clauseReturnsEvery(clause, nodes) &&
    nodesShareOneKeyedLeaf(nodes, clause)
  );
}

/** The inline `.map` callback every render node lives in, together with its item parameter. */
interface RepeatedMapSelection {
  readonly callback: ts.Expression;
  readonly item: ts.Identifier;
}

/** The nodes all render inside one `.map` over a de-duplicated array the callback cannot re-read. */
function uniqueMapSelection(
  nodes: readonly ts.Node[],
  boundary: RuntimeFunctionLike,
): RepeatedMapSelection | null {
  const repeated = soleRepeatedMapCall(nodes, boundary);
  if (!repeated || !ts.isPropertyAccessExpression(repeated.expression)) {
    return null;
  }
  const selection = mapCallbackItem(repeated);
  const receiver = unwrapTransparentExpression(repeated.expression.expression);
  if (
    !selection ||
    (ts.isIdentifier(receiver) && bindingIsReferenced(selection.callback, receiver.text))
  ) {
    return null;
  }
  return expressionIsUniquelyFiltered(repeated.expression.expression, boundary) ? selection : null;
}

/** The single `.map(...)` call that every node renders inside, or null when they differ. */
function soleRepeatedMapCall(
  nodes: readonly ts.Node[],
  boundary: RuntimeFunctionLike,
): ts.CallExpression | null {
  const repeatedCalls = nodes.map((node) => nearestRepeatedRenderCall(node, boundary));
  const [repeated] = repeatedCalls;
  return repeated &&
    repeatedCalls.every((call) => call === repeated) &&
    ts.isPropertyAccessExpression(repeated.expression) &&
    repeated.expression.name.text === "map"
    ? repeated
    : null;
}

/** The lone item parameter of an inline `.map(item => ...)` callback. */
function mapCallbackItem(call: ts.CallExpression): RepeatedMapSelection | null {
  const [callback] = call.arguments;
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return null;
  }
  const item = callback.parameters[0]?.name;
  return item && ts.isIdentifier(item) ? { callback, item } : null;
}

/** The one `case` clause that every render node sits in, or null when they disagree. */
function soleCaseClause(nodes: readonly ts.Node[], boundary: ts.Node): ts.CaseClause | null {
  const clauses = new Set(nodes.map((node) => findAncestorUntil(node, ts.isCaseClause, boundary)));
  if (clauses.size !== 1) {
    return null;
  }
  const [clause] = clauses;
  return clause ?? null;
}

/** The clause belongs to a `switch` on the map callback's own item parameter. */
function clauseSwitchesOnItem(clause: ts.CaseClause, selection: RepeatedMapSelection): boolean {
  const switchStatement = findAncestorUntil(clause, ts.isSwitchStatement, selection.callback);
  if (!switchStatement) {
    return false;
  }
  const switchExpression = unwrapTransparentExpression(switchStatement.expression);
  return ts.isIdentifier(switchExpression) && switchExpression.text === selection.item.text;
}

/** The clause body is exactly one `return` whose expression contains every render node. */
function clauseReturnsEvery(clause: ts.CaseClause, nodes: readonly ts.Node[]): boolean {
  const [returnStatement] = clause.statements;
  if (
    clause.statements.length !== 1 ||
    !returnStatement ||
    !ts.isReturnStatement(returnStatement) ||
    !returnStatement.expression
  ) {
    return false;
  }
  const returned = returnStatement.expression;
  return nodes.every((node) => nodeWithin(node, returned));
}

/** All render nodes sit under one JSX leaf whose `key` is the clause literal. */
function nodesShareOneKeyedLeaf(nodes: readonly ts.Node[], clause: ts.CaseClause): boolean {
  const leaf = nearestJsxElement(nodes[0]!, clause);
  return (
    leaf !== null &&
    nodes.every((node) => nearestJsxElement(node, clause) === leaf) &&
    jsxKeyMatchesLiteral(leaf, clause.expression)
  );
}

function expressionIsUniquelyFiltered(expression: ts.Expression, boundary: ts.Node): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return constInitializerIsUniquelyFiltered(value, boundary);
  }
  if (
    !ts.isCallExpression(value) ||
    !ts.isPropertyAccessExpression(value.expression) ||
    value.expression.name.text !== "filter"
  ) {
    return false;
  }
  return (
    isExactUniquenessFilter(value, boundary) ||
    (isPureSubsetFilter(value, boundary) &&
      expressionIsUniquelyFiltered(value.expression.expression, boundary))
  );
}

/** The name resolves to a unique `const` whose initializer is itself uniquely filtered. */
function constInitializerIsUniquelyFiltered(name: ts.Identifier, boundary: ts.Node): boolean {
  const declaration = uniqueVariableDeclaration(boundary, name.text);
  return (
    declaration !== null &&
    declaration.initializer !== undefined &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    expressionIsUniquelyFiltered(declaration.initializer, boundary)
  );
}

function bindingIsReferenced(node: ts.Node, name: string): boolean {
  let found = false;
  visit(node, (current) => {
    if (
      ts.isIdentifier(current) &&
      current.text === name &&
      !isDeclarationName(current) &&
      !isNonValueIdentifier(current)
    ) {
      found = true;
    }
  });
  return found;
}

function isPureSubsetFilter(call: ts.CallExpression, boundary: ts.Node): boolean {
  const [callback] = call.arguments;
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    ts.isBlock(callback.body)
  ) {
    return false;
  }
  const allowedCalls = new Set<string>();
  let callsAreReadOnly = true;
  visit(callback.body, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "includes" &&
      ts.isIdentifier(node.expression.expression) &&
      expressionHasArrayType(node.expression.expression, boundary)
    ) {
      allowedCalls.add(`${node.expression.expression.text}.includes`);
    } else {
      callsAreReadOnly = false;
    }
  });
  return (
    callsAreReadOnly &&
    isSafeProjectionExpression(callback.body, callback.body, EMPTY_BINDINGS, allowedCalls)
  );
}

function isExactUniquenessFilter(call: ts.CallExpression, boundary: ts.Node): boolean {
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    !expressionHasArrayType(call.expression.expression, boundary)
  ) {
    return false;
  }
  const [callback] = call.arguments;
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return false;
  }
  const [item, index, array] = callback.parameters.map((parameter) => parameter.name);
  if (
    !item ||
    !index ||
    !array ||
    !ts.isIdentifier(item) ||
    !ts.isIdentifier(index) ||
    !ts.isIdentifier(array)
  ) {
    return false;
  }
  const body = concisePredicateBody(callback);
  return body !== null && isIndexOfIdentityComparison(body, { array, index, item });
}

/** The single returned expression of a predicate, written concisely or as a one-statement block. */
function concisePredicateBody(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | null {
  const { body } = callback;
  if (!ts.isBlock(body)) {
    return body;
  }
  const [onlyStatement] = body.statements;
  return body.statements.length === 1 && onlyStatement && ts.isReturnStatement(onlyStatement)
    ? (onlyStatement.expression ?? null)
    : null;
}

/** The three parameters of the canonical de-duplication predicate. */
interface UniquenessFilterParameters {
  readonly array: ts.Identifier;
  readonly index: ts.Identifier;
  readonly item: ts.Identifier;
}

/** `array.indexOf(item) === index`, which keeps only the first occurrence of each element. */
function isIndexOfIdentityComparison(
  body: ts.Expression,
  parameters: UniquenessFilterParameters,
): boolean {
  const comparison = unwrapTransparentExpression(body);
  if (
    !ts.isBinaryExpression(comparison) ||
    comparison.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return false;
  }
  return (
    isIndexOfItem(comparison.left, parameters.array.text, parameters.item.text) &&
    ts.isIdentifier(comparison.right) &&
    comparison.right.text === parameters.index.text
  );
}

function expressionHasArrayType(expression: ts.Expression, boundary: ts.Node): boolean {
  const value = unwrapParentheses(expression);
  if (ts.isArrayLiteralExpression(value)) {
    return true;
  }
  if (ts.isAsExpression(value) || ts.isTypeAssertionExpression(value)) {
    return ts.isArrayTypeNode(value.type);
  }
  if (!ts.isIdentifier(value)) {
    return false;
  }
  const types = declaredTypesOfName(boundary.getSourceFile(), value.text);
  return types.length === 1 && ts.isArrayTypeNode(types[0]!);
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let value = expression;
  while (ts.isParenthesizedExpression(value)) {
    value = value.expression;
  }
  return value;
}

/** Every written type annotation that binds the given name anywhere in the file. */
function declaredTypesOfName(sourceFile: ts.SourceFile, name: string): ts.TypeNode[] {
  const types: ts.TypeNode[] = [];
  visit(sourceFile, (node) => {
    const type = boundNameType(node, name);
    if (type) {
      types.push(type);
    }
  });
  return types;
}

function boundNameType(node: ts.Node, name: string): ts.TypeNode | undefined {
  if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.name.text === name) {
    return destructuredBindingType(node);
  }
  if (
    (!ts.isParameter(node) && !ts.isVariableDeclaration(node)) ||
    !ts.isIdentifier(node.name) ||
    node.name.text !== name
  ) {
    return undefined;
  }
  return node.type;
}

function destructuredBindingType(binding: ts.BindingElement): ts.TypeNode | undefined {
  const declaration = findAncestor(
    binding,
    (node): node is ts.ParameterDeclaration | ts.VariableDeclaration =>
      ts.isParameter(node) || ts.isVariableDeclaration(node),
  );
  if (!declaration?.type || !ts.isTypeLiteralNode(declaration.type)) {
    return undefined;
  }
  const sourceName = binding.propertyName?.getText() ?? binding.name.getText();
  const property = declaration.type.members.find(
    (member) => ts.isPropertySignature(member) && member.name?.getText() === sourceName,
  );
  return property && ts.isPropertySignature(property) ? property.type : undefined;
}

function isIndexOfItem(expression: ts.Expression, array: string, item: string): boolean {
  const value = unwrapTransparentExpression(expression);
  const argument = ts.isCallExpression(value) ? value.arguments[0] : undefined;
  return (
    ts.isCallExpression(value) &&
    value.arguments.length === 1 &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === "indexOf" &&
    ts.isIdentifier(value.expression.expression) &&
    value.expression.expression.text === array &&
    argument !== undefined &&
    ts.isIdentifier(argument) &&
    argument.text === item
  );
}

function isPrimitiveLiteral(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  return ts.isStringLiteralLike(value) || ts.isNumericLiteral(value);
}

function nearestJsxElement(
  node: ts.Node,
  boundary: ts.Node,
): ts.JsxElement | ts.JsxSelfClosingElement | null {
  return findAncestorUntil(
    node,
    (candidate): candidate is ts.JsxElement | ts.JsxSelfClosingElement =>
      ts.isJsxElement(candidate) || ts.isJsxSelfClosingElement(candidate),
    boundary,
  );
}

function jsxKeyMatchesLiteral(
  element: ts.JsxElement | ts.JsxSelfClosingElement,
  literal: ts.Expression,
): boolean {
  const opening = ts.isJsxElement(element) ? element.openingElement : element;
  const key = opening.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === "key",
  );
  if (!key || !ts.isJsxAttribute(key) || !key.initializer) {
    return false;
  }
  const keyValue = jsxAttributeLiteral(key.initializer);
  const caseValue = unwrapTransparentExpression(literal);
  return (
    keyValue !== null &&
    ((ts.isStringLiteralLike(keyValue) &&
      ts.isStringLiteralLike(caseValue) &&
      keyValue.text === caseValue.text) ||
      (ts.isNumericLiteral(keyValue) &&
        ts.isNumericLiteral(caseValue) &&
        keyValue.text === caseValue.text))
  );
}

/** The literal behind a JSX attribute value, whether written bare or inside braces. */
function jsxAttributeLiteral(initializer: ts.JsxAttributeValue): ts.Expression | null {
  if (ts.isStringLiteral(initializer)) {
    return initializer;
  }
  return ts.isJsxExpression(initializer) && initializer.expression
    ? unwrapTransparentExpression(initializer.expression)
    : null;
}

export function expressionDependsOnBinding(
  expression: ts.Expression,
  binding: ts.BindingName,
  boundary: ts.Node,
): boolean {
  let found = false;
  visit(expression, (node) => {
    if (!ts.isIdentifier(node)) {
      return;
    }
    if (bindingContainsName(binding, node.text)) {
      found = true;
      return;
    }
    const declaration = uniqueVariableDeclaration(boundary, node.text);
    if (
      declaration?.initializer &&
      expressionDependsOnBinding(declaration.initializer, binding, declaration)
    ) {
      found = true;
    }
  });
  return found;
}

export function bindingContainsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) {
    return binding.text === name;
  }
  return binding.elements.some(
    (element) => ts.isBindingElement(element) && bindingContainsName(element.name, name),
  );
}

export function uniqueVariableDeclaration(
  boundary: ts.Node,
  name: string,
): ts.VariableDeclaration | null {
  let declarations = uniqueVariableDeclarationsByBoundary.get(boundary);
  if (!declarations) {
    const collected = new Map<string, ts.VariableDeclaration | null>();
    visitSkippingNestedRuntimeFunctions(boundary, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) {
        return;
      }
      collected.set(node.name.text, collected.has(node.name.text) ? null : node);
    });
    declarations = collected;
    uniqueVariableDeclarationsByBoundary.set(boundary, declarations);
  }
  return declarations.get(name) ?? null;
}

export function localFunctionBinding(
  owner: RuntimeFunctionLike,
  name: string,
): ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null {
  if (!owner.body || bindingDeclarationCount(owner, name) !== 1) {
    return null;
  }
  let bindings = localFunctionBindingsByOwner.get(owner);
  if (!bindings) {
    const collected = new Map<
      string,
      ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression
    >();
    visit(owner.body, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        collected.set(node.name.text, node);
        return;
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        collected.set(node.name.text, node.initializer);
      }
    });
    bindings = collected;
    localFunctionBindingsByOwner.set(owner, bindings);
  }
  return bindings.get(name) ?? null;
}
