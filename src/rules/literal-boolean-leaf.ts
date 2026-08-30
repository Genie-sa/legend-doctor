import type { StateCandidate, StateUsage } from "../analyze-source.js";
import {
  bindingDeclarationCount,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
  isPureExpression,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import {
  expressionContainsJsx,
  hasStateInitializer,
  isRenderGateReference,
  isSafeProjectionExpression,
} from "./deferred-reveal.js";
import {
  findAncestorUntil,
  nearestNestedFunction,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import {
  isInsideJsxEventCallback,
  isSafeJsxProjectionReference,
  jsxElementCount,
  nearestRepeatedRenderCall,
  oneHopRenderProjectionReferences,
} from "./state-proofs.js";
import type { RuntimeFunctionLike } from "../ast.js";
import { mutationRegionOnlyCallsStateSetters } from "./effect-drafts.js";
import ts from "typescript";

const MIN_OWNER_JSX_ELEMENTS = 12;
const MIN_MULTI_SURFACE_RENDER_READS = 2;
const MIN_CONDITIONAL_SURFACES = 2;
const MAX_CONDITIONAL_SURFACES = 6;
const MAX_SURFACE_ELEMENTS = 4;
const MAX_SURFACE_ELEMENT_SHARE = 0.4;
const PRESENTATION_ATTRIBUTES: ReadonlySet<string> = new Set(["className", "style"]);
const BOOLEAN_BINARY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

interface LiteralBooleanLeafOptions {
  branchCallSiteExists: boolean;
  hasCompanionWrites: boolean;
  hasMemoizedOptionCommand: boolean;
  hasReactiveMutationPath: boolean;
  isCustomHookOwner: boolean;
  localComponents: ReadonlySet<string>;
  sourceComponents: ReadonlySet<string>;
}

interface MultiSurfaceBooleanOptions {
  hasCompanionWrites: boolean;
  hasReactiveMutationPath: boolean;
  hasSafeCommands: boolean;
  isCustomHookOwner: boolean;
  pureProjectionImports: ReadonlySet<string>;
}

interface AdjacentEffectBooleanOptions extends MultiSurfaceBooleanOptions {
  effectWritesAreDirect: boolean;
}

interface ConditionalPresentationSurface {
  elements: number;
  expression: ts.JsxExpression;
}

interface PresentationSurface {
  conditional: boolean;
  elements: number;
  start: number;
}

interface MultiSurfaceTally {
  conditionalSurfaces: number;
  surfaceElements: number;
  surfaces: number;
}

export function isLiteralBooleanLeafState(
  state: StateCandidate,
  usage: StateUsage,
  options: LiteralBooleanLeafOptions,
): boolean {
  const target = [...usage.valueTargets][0] ?? "";
  return (
    !options.isCustomHookOwner &&
    hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) &&
    jsxElementCount(state.owner) >= MIN_OWNER_JSX_ELEMENTS &&
    isSingleTargetTransportUsage(usage) &&
    (options.localComponents.has(target) || options.sourceComponents.has(target)) &&
    options.branchCallSiteExists &&
    !options.hasCompanionWrites &&
    !options.hasReactiveMutationPath &&
    usage.setterCallNodes.every(
      (call) =>
        isLiteralBooleanSetter(call) &&
        (isInsideJsxEventCallback(call, state.owner) || options.hasMemoizedOptionCommand),
    )
  );
}

export function isAdjacentEventBooleanLeafState(
  state: StateCandidate,
  usage: StateUsage,
  options: MultiSurfaceBooleanOptions,
): boolean {
  return (
    usage.effectWrites === 0 &&
    usage.setterCallNodes.every((call) => isEventBooleanSetter(call, state)) &&
    isAdjacentBooleanLeafState(state, usage, options)
  );
}

export function isAdjacentEffectBooleanLeafState(
  state: StateCandidate,
  usage: StateUsage,
  options: AdjacentEffectBooleanOptions,
): boolean {
  return (
    options.effectWritesAreDirect &&
    usage.effectWrites > 0 &&
    usage.effectWrites === usage.setterCalls &&
    usage.setterCallNodes.every(isPureBooleanSetter) &&
    isAdjacentBooleanLeafState(state, usage, options)
  );
}

export function isMultiSurfaceLiteralBooleanState(
  state: StateCandidate,
  usage: StateUsage,
  options: MultiSurfaceBooleanOptions,
): boolean {
  const ownerElements = jsxElementCount(state.owner);
  if (
    options.isCustomHookOwner ||
    !hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) ||
    ownerElements < MIN_OWNER_JSX_ELEMENTS ||
    directOwnerReturnCount(state.owner) !== 1 ||
    usage.localRenderReads < MIN_MULTI_SURFACE_RENDER_READS ||
    usage.effectWrites !== 0 ||
    !isLocalRenderOnlyBooleanUsage(usage, options) ||
    !usage.setterCallNodes.every(isLiteralBooleanSetter)
  ) {
    return false;
  }
  const tally = multiSurfaceTally(state, usage, options);
  return (
    tally !== null &&
    tally.surfaces >= MIN_CONDITIONAL_SURFACES &&
    tally.surfaces <= MAX_CONDITIONAL_SURFACES &&
    tally.conditionalSurfaces > 0 &&
    tally.surfaceElements / ownerElements <= MAX_SURFACE_ELEMENT_SHARE
  );
}

function isAdjacentBooleanLeafState(
  state: StateCandidate,
  usage: StateUsage,
  options: MultiSurfaceBooleanOptions,
): boolean {
  const ownerElements = jsxElementCount(state.owner);
  if (
    options.isCustomHookOwner ||
    !state.setterName ||
    !hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) ||
    ownerElements < MIN_OWNER_JSX_ELEMENTS ||
    directOwnerReturnCount(state.owner) !== 1 ||
    usage.localRenderReads === 0 ||
    !isLocalRenderOnlyBooleanUsage(usage, options)
  ) {
    return false;
  }
  const surfaces = conditionalPresentationSurfaces(state, usage, options.pureProjectionImports);
  if (!isProportionateSurfaceSet(surfaces, ownerElements)) {
    return false;
  }
  return surfacesAreAdjacentSiblings([...surfaces.values()].map((surface) => surface.expression));
}

function isSingleTargetTransportUsage(usage: StateUsage): boolean {
  return (
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences > 0 &&
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1 &&
    !usage.repeatedValueTransport &&
    usage.setterCallNodes.length > 0 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped
  );
}

function isLocalRenderOnlyBooleanUsage(
  usage: StateUsage,
  options: MultiSurfaceBooleanOptions,
): boolean {
  return (
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences === 0 &&
    !options.hasCompanionWrites &&
    !options.hasReactiveMutationPath &&
    options.hasSafeCommands &&
    usage.setterCallNodes.length > 0 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped
  );
}

function isProportionateSurfaceSet(
  surfaces: ReadonlyMap<number, ConditionalPresentationSurface> | null,
  ownerElements: number,
): surfaces is ReadonlyMap<number, ConditionalPresentationSurface> {
  if (
    surfaces === null ||
    surfaces.size < MIN_CONDITIONAL_SURFACES ||
    surfaces.size > MAX_CONDITIONAL_SURFACES
  ) {
    return false;
  }
  const surfaceElements = [...surfaces.values()].reduce(
    (sum, surface) => sum + surface.elements,
    0,
  );
  return surfaceElements / ownerElements <= MAX_SURFACE_ELEMENT_SHARE;
}

function surfacesAreAdjacentSiblings(expressions: readonly ts.JsxExpression[]): boolean {
  const [first] = expressions;
  const parent = first?.parent;
  if (
    !parent ||
    (!ts.isJsxElement(parent) && !ts.isJsxFragment(parent)) ||
    expressions.some((expression) => expression.parent !== parent)
  ) {
    return false;
  }
  const children = parent.children.filter(
    (child) => !ts.isJsxText(child) || child.text.trim().length > 0,
  );
  const indexes = expressions
    .map((expression) => children.indexOf(expression))
    .toSorted((left, right) => left - right);
  const [firstIndex] = indexes;
  return (
    children.length > expressions.length &&
    firstIndex !== undefined &&
    firstIndex !== -1 &&
    indexes.every((index, position) => index === firstIndex + position)
  );
}

function multiSurfaceTally(
  state: StateCandidate,
  usage: StateUsage,
  options: MultiSurfaceBooleanOptions,
): MultiSurfaceTally | null {
  const projections = presentationProjections(state, usage, options.pureProjectionImports);
  const surfaces = new Map<number, PresentationSurface>();
  for (const projection of projections.values()) {
    const surface = presentationSurface(projection, state.owner, options.pureProjectionImports);
    if (surface === null) {
      return null;
    }
    surfaces.set(surface.start, surface);
  }
  return tallySurfaces([...surfaces.values()]);
}

function tallySurfaces(surfaces: readonly PresentationSurface[]): MultiSurfaceTally {
  return {
    conditionalSurfaces: surfaces.filter((surface) => surface.conditional).length,
    surfaceElements: surfaces.reduce((sum, surface) => sum + surface.elements, 0),
    surfaces: surfaces.length,
  };
}

function presentationSurface(
  projection: ts.Node,
  owner: RuntimeFunctionLike,
  pureProjectionImports: ReadonlySet<string>,
): PresentationSurface | null {
  if (
    nearestNestedFunction(projection, owner) ||
    nearestRepeatedRenderCall(projection, owner) ||
    !isSafeJsxProjectionReference(projection, owner, pureProjectionImports)
  ) {
    return null;
  }
  const attribute = findAncestorUntil(projection, ts.isJsxAttribute, owner);
  if (attribute) {
    return PRESENTATION_ATTRIBUTES.has(attribute.name.getText())
      ? { conditional: false, elements: 1, start: attribute.getStart() }
      : null;
  }
  const expression = findAncestorUntil(projection, ts.isJsxExpression, owner);
  if (!expression?.expression || !isRenderGateReference(projection, owner)) {
    return null;
  }
  const elements = jsxElementsWithin(expression.expression);
  return elements === 0 || elements > MAX_SURFACE_ELEMENTS
    ? null
    : { conditional: true, elements, start: expression.getStart() };
}

function conditionalPresentationSurfaces(
  state: StateCandidate,
  usage: StateUsage,
  pureProjectionImports: ReadonlySet<string>,
): ReadonlyMap<number, ConditionalPresentationSurface> | null {
  const projections = presentationProjections(state, usage, pureProjectionImports);
  const surfaces = new Map<number, ConditionalPresentationSurface>();
  for (const projection of projections.values()) {
    const surface = conditionalPresentationSurface(projection, state.owner, pureProjectionImports);
    if (surface === null) {
      return null;
    }
    surfaces.set(surface.expression.getStart(), surface);
  }
  return surfaces;
}

function conditionalPresentationSurface(
  projection: ts.Node,
  owner: RuntimeFunctionLike,
  pureProjectionImports: ReadonlySet<string>,
): ConditionalPresentationSurface | null {
  const condition = renderGateCondition(projection, owner);
  if (
    nearestNestedFunction(projection, owner) ||
    nearestRepeatedRenderCall(projection, owner) ||
    !condition ||
    !isSafeProjectionExpression({
      expression: condition,
      reference: projection,
      allowedIdentifierCalls: pureProjectionImports,
    }) ||
    findAncestorUntil(projection, ts.isJsxAttribute, owner)
  ) {
    return null;
  }
  const expression = findAncestorUntil(projection, ts.isJsxExpression, owner);
  if (!expression?.expression || !isRenderGateReference(projection, owner)) {
    return null;
  }
  const elements = jsxElementsWithin(expression.expression);
  return elements === 0 || elements > MAX_SURFACE_ELEMENTS ? null : { elements, expression };
}

function presentationProjections(
  state: StateCandidate,
  usage: StateUsage,
  pureProjectionImports: ReadonlySet<string>,
): ReadonlyMap<number, ts.Node> {
  const projections = new Map<number, ts.Node>();
  for (const renderNode of usage.directRenderNodes) {
    const declaration = findAncestorUntil(renderNode, ts.isVariableDeclaration, state.owner);
    const aliases =
      declaration?.initializer && containsJsx(declaration.initializer)
        ? null
        : oneHopRenderProjectionReferences(state.owner, [renderNode], (query) =>
            isSafeProjectionExpression({
              ...query,
              allowedIdentifierCalls: pureProjectionImports,
            }),
          );
    for (const projection of aliases ?? [renderNode]) {
      projections.set(projection.getStart(), projection);
    }
  }
  return projections;
}

function renderGateCondition(node: ts.Node, boundary: ts.Node): ts.Expression | null {
  for (
    let current: ts.Node | undefined = node;
    current && current !== boundary;
    current = current.parent
  ) {
    if (ts.isConditionalExpression(current) && nodeWithin(node, current.condition)) {
      return current.condition;
    }
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      nodeWithin(node, current.left) &&
      expressionContainsJsx(current.right)
    ) {
      return current.left;
    }
  }
  return null;
}

function isEventBooleanSetter(call: ts.CallExpression, state: StateCandidate): boolean {
  if (!isPureBooleanSetter(call)) {
    return false;
  }
  const callback = nearestNestedFunction(call, state.owner);
  return (
    callback !== null &&
    (ts.isArrowFunction(callback) ||
      ts.isFunctionDeclaration(callback) ||
      ts.isFunctionExpression(callback)) &&
    callbackIsIntrinsicEventRooted(callback, state.owner) &&
    mutationRegionOnlyCallsStateSetters(callback, new Set([state.setterName!]))
  );
}

function isPureBooleanSetter(call: ts.CallExpression): boolean {
  const [argument] = call.arguments;
  return (
    call.arguments.length === 1 &&
    argument !== undefined &&
    (isLiteralBooleanSetter(call) || (isPureExpression(argument) && isBooleanExpression(argument)))
  );
}

function isLiteralBooleanSetter(call: ts.CallExpression): boolean {
  const [value] = call.arguments;
  return (
    call.arguments.length === 1 &&
    value !== undefined &&
    (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword)
  );
}

function callbackIsIntrinsicEventRooted(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
): boolean {
  if (isInlineIntrinsicEventHandler(callback, owner)) {
    return true;
  }
  const name = callbackBindingName(callback);
  if (!name || bindingDeclarationCount(owner, name) !== 1) {
    return false;
  }
  return referencesAreIntrinsicEventAttributes(owner, name);
}

function isInlineIntrinsicEventHandler(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
): boolean {
  const attribute = findAncestorUntil(callback, ts.isJsxAttribute, owner);
  const initializer = attribute?.initializer;
  return (
    attribute !== null &&
    initializer !== undefined &&
    ts.isJsxExpression(initializer) &&
    initializer.expression !== undefined &&
    unwrapTransparentExpression(initializer.expression) === callback &&
    attributeIsIntrinsicEvent(attribute)
  );
}

function callbackBindingName(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
): string | undefined {
  if (ts.isFunctionDeclaration(callback)) {
    return callback.name?.text;
  }
  return ts.isVariableDeclaration(callback.parent) && ts.isIdentifier(callback.parent.name)
    ? callback.parent.name.text
    : undefined;
}

function referencesAreIntrinsicEventAttributes(owner: RuntimeFunctionLike, name: string): boolean {
  let referenced = false;
  let safe = true;
  visit(owner.body, (node) => {
    if (!safe || !isValueReferenceNamed(node, name)) {
      return;
    }
    referenced = true;
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    safe =
      attribute !== null &&
      isDirectJsxAttributeExpression(attribute, node) &&
      attributeIsIntrinsicEvent(attribute);
  });
  return referenced && safe;
}

function isValueReferenceNamed(node: ts.Node, name: string): node is ts.Identifier {
  return (
    ts.isIdentifier(node) &&
    node.text === name &&
    !isDeclarationName(node) &&
    !isNonValueIdentifier(node)
  );
}

function attributeIsIntrinsicEvent(attribute: ts.JsxAttribute): boolean {
  if (!/^on[A-Z]/u.test(attribute.name.getText())) {
    return false;
  }
  const opening = attribute.parent.parent;
  const tag =
    ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening) ? opening.tagName : null;
  return tag !== null && ts.isIdentifier(tag) && /^[a-z]/u.test(tag.text);
}

function isBooleanExpression(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  return (
    (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) ||
    (ts.isBinaryExpression(value) && BOOLEAN_BINARY_OPERATORS.has(value.operatorToken.kind))
  );
}

function directOwnerReturnCount(owner: RuntimeFunctionLike): number {
  if (!owner.body) {
    return 0;
  }
  let returns = 0;
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      returns += 1;
    }
  });
  return returns;
}

function jsxElementsWithin(node: ts.Node): number {
  let elements = 0;
  visit(node, (candidate) => {
    if (ts.isJsxElement(candidate) || ts.isJsxSelfClosingElement(candidate)) {
      elements += 1;
    }
  });
  return elements;
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  visit(node, (candidate) => {
    if (
      ts.isJsxElement(candidate) ||
      ts.isJsxFragment(candidate) ||
      ts.isJsxSelfClosingElement(candidate)
    ) {
      found = true;
    }
  });
  return found;
}
