import ts from "typescript";

import {
  bindingDeclarationCount,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
  isPureExpression,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import {
  findAncestorUntil,
  nearestNestedFunction,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import type { StateCandidate, StateUsage } from "../analyze-source.js";
import {
  expressionContainsJsx,
  hasStateInitializer,
  isRenderGateReference,
  isSafeProjectionExpression,
} from "./deferred-reveal.js";
import { mutationRegionOnlyCallsStateSetters } from "./effect-drafts.js";
import {
  isInsideJsxEventCallback,
  isSafeJsxProjectionReference,
  jsxElementCount,
  nearestRepeatedRenderCall,
  oneHopRenderProjectionReferences,
} from "./state-proofs.js";
import type { RuntimeFunctionLike } from "../ast.js";

interface LiteralBooleanLeafOptions {
  branchCallSiteExists: boolean;
  hasCompanionWrites: boolean;
  hasMemoizedOptionCommand: boolean;
  hasReactiveMutationPath: boolean;
  isCustomHookOwner: boolean;
  localComponents: ReadonlySet<string>;
  sourceComponents: ReadonlySet<string>;
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
    jsxElementCount(state.owner) >= 12 &&
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences > 0 &&
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1 &&
    (options.localComponents.has(target) || options.sourceComponents.has(target)) &&
    options.branchCallSiteExists &&
    !usage.repeatedValueTransport &&
    !options.hasCompanionWrites &&
    !options.hasReactiveMutationPath &&
    usage.setterCallNodes.length > 0 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped &&
    usage.setterCallNodes.every((call) => {
      const value = call.arguments[0];
      return (
        call.arguments.length === 1 &&
        value !== undefined &&
        (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) &&
        (isEventRootedLiteralSetterCall(call, state.owner) || options.hasMemoizedOptionCommand)
      );
    })
  );
}

interface MultiSurfaceBooleanOptions {
  hasCompanionWrites: boolean;
  hasReactiveMutationPath: boolean;
  hasSafeCommands: boolean;
  isCustomHookOwner: boolean;
  pureProjectionImports: ReadonlySet<string>;
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

interface AdjacentEffectBooleanOptions extends MultiSurfaceBooleanOptions {
  effectWritesAreDirect: boolean;
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
    ownerElements < 12 ||
    directOwnerReturnCount(state.owner) !== 1 ||
    usage.localRenderReads === 0 ||
    usage.localRenderReads !== usage.directRenderNodes.length ||
    usage.effectReads !== 0 ||
    usage.deferredReads !== 0 ||
    usage.transportedOccurrences !== 0 ||
    options.hasCompanionWrites ||
    options.hasReactiveMutationPath ||
    !options.hasSafeCommands ||
    usage.setterCallNodes.length === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.setterUsesPreviousValue ||
    usage.shadowed ||
    usage.escaped
  ) {
    return false;
  }

  const surfaces = conditionalPresentationSurfaces(state, usage, options.pureProjectionImports);
  if (surfaces === null || surfaces.size < 2 || surfaces.size > 6) {
    return false;
  }
  const surfaceElements = [...surfaces.values()].reduce(
    (sum, surface) => sum + surface.elements,
    0,
  );
  if (surfaceElements / ownerElements > 0.4) {
    return false;
  }

  const expressions = [...surfaces.values()].map((surface) => surface.expression),
    parent = expressions[0]?.parent;
  if (
    !parent ||
    (!ts.isJsxElement(parent) && !ts.isJsxFragment(parent)) ||
    expressions.some((expression) => expression.parent !== parent)
  ) {
    return false;
  }
  const children = parent.children.filter(
      (child) => !ts.isJsxText(child) || child.text.trim().length > 0,
    ),
    indexes = expressions
      .map((expression) => children.indexOf(expression))
      .toSorted((left, right) => left - right);
  return (
    children.length > expressions.length &&
    indexes[0] !== -1 &&
    indexes.every((index, position) => index === indexes[0]! + position)
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
    ownerElements < 12 ||
    directOwnerReturnCount(state.owner) !== 1 ||
    usage.localRenderReads < 2 ||
    usage.localRenderReads !== usage.directRenderNodes.length ||
    usage.effectReads !== 0 ||
    usage.effectWrites !== 0 ||
    usage.deferredReads !== 0 ||
    usage.transportedOccurrences !== 0 ||
    options.hasCompanionWrites ||
    options.hasReactiveMutationPath ||
    !options.hasSafeCommands ||
    usage.setterCallNodes.length === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.setterUsesPreviousValue ||
    usage.shadowed ||
    usage.escaped ||
    !usage.setterCallNodes.every(isLiteralBooleanSetter)
  ) {
    return false;
  }

  const projections = presentationProjections(state, usage, options.pureProjectionImports),
    surfaces = new Map<number, number>();
  let conditionalSurfaces = 0;
  for (const projection of projections.values()) {
    if (
      nearestNestedFunction(projection, state.owner) ||
      nearestRepeatedRenderCall(projection, state.owner) ||
      !isSafeJsxProjectionReference(projection, state.owner, options.pureProjectionImports)
    ) {
      return false;
    }
    const attribute = findAncestorUntil(projection, ts.isJsxAttribute, state.owner);
    if (attribute) {
      if (!["className", "style"].includes(attribute.name.getText())) {
        return false;
      }
      surfaces.set(attribute.getStart(), 1);
      continue;
    }
    const expression = findAncestorUntil(projection, ts.isJsxExpression, state.owner);
    if (!expression?.expression || !isRenderGateReference(projection, state.owner)) {
      return false;
    }
    let elements = 0;
    visit(expression.expression, (node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        elements += 1;
      }
    });
    if (elements === 0 || elements > 4) {
      return false;
    }
    surfaces.set(expression.getStart(), elements);
    conditionalSurfaces += 1;
  }

  const surfaceElements = [...surfaces.values()].reduce((sum, elements) => sum + elements, 0);
  return (
    surfaces.size >= 2 &&
    surfaces.size <= 6 &&
    conditionalSurfaces > 0 &&
    surfaceElements / ownerElements <= 0.4
  );
}

interface ConditionalPresentationSurface {
  elements: number;
  expression: ts.JsxExpression;
}

function conditionalPresentationSurfaces(
  state: StateCandidate,
  usage: StateUsage,
  pureProjectionImports: ReadonlySet<string>,
): ReadonlyMap<number, ConditionalPresentationSurface> | null {
  const projections = presentationProjections(state, usage, pureProjectionImports),
    surfaces = new Map<number, ConditionalPresentationSurface>();
  for (const projection of projections.values()) {
    const condition = renderGateCondition(projection, state.owner);
    if (
      nearestNestedFunction(projection, state.owner) ||
      nearestRepeatedRenderCall(projection, state.owner) ||
      !condition ||
      !isSafeProjectionExpression(condition, projection, pureProjectionImports) ||
      findAncestorUntil(projection, ts.isJsxAttribute, state.owner)
    ) {
      return null;
    }
    const expression = findAncestorUntil(projection, ts.isJsxExpression, state.owner);
    if (!expression?.expression || !isRenderGateReference(projection, state.owner)) {
      return null;
    }
    let elements = 0;
    visit(expression.expression, (node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        elements += 1;
      }
    });
    if (elements === 0 || elements > 4) {
      return null;
    }
    surfaces.set(expression.getStart(), { elements, expression });
  }
  return surfaces;
}

function presentationProjections(
  state: StateCandidate,
  usage: StateUsage,
  pureProjectionImports: ReadonlySet<string>,
): ReadonlyMap<number, ts.Node> {
  const projections = new Map<number, ts.Node>();
  for (const renderNode of usage.directRenderNodes) {
    const declaration = findAncestorUntil(renderNode, ts.isVariableDeclaration, state.owner),
      aliases =
        declaration?.initializer && containsJsx(declaration.initializer)
          ? null
          : oneHopRenderProjectionReferences(state.owner, [renderNode], (expression, reference) =>
              isSafeProjectionExpression(expression, reference, pureProjectionImports),
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

function isEventBooleanSetter(call: ts.CallExpression, state: StateCandidate): boolean {
  const argument = call.arguments[0];
  if (
    call.arguments.length !== 1 ||
    !argument ||
    (!isLiteralBooleanSetter(call) &&
      (!isPureExpression(argument) || !isBooleanExpression(argument)))
  ) {
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
  const argument = call.arguments[0];
  return (
    call.arguments.length === 1 &&
    argument !== undefined &&
    (isLiteralBooleanSetter(call) || (isPureExpression(argument) && isBooleanExpression(argument)))
  );
}

function callbackIsIntrinsicEventRooted(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
): boolean {
  const inlineAttribute = findAncestorUntil(callback, ts.isJsxAttribute, owner),
    inlineInitializer = inlineAttribute?.initializer;
  if (
    inlineAttribute &&
    inlineInitializer &&
    ts.isJsxExpression(inlineInitializer) &&
    inlineInitializer.expression &&
    unwrapTransparentExpression(inlineInitializer.expression) === callback &&
    attributeIsIntrinsicEvent(inlineAttribute)
  ) {
    return true;
  }
  const name = ts.isFunctionDeclaration(callback)
    ? callback.name?.text
    : ts.isVariableDeclaration(callback.parent) && ts.isIdentifier(callback.parent.name)
      ? callback.parent.name.text
      : undefined;
  if (!name || bindingDeclarationCount(owner, name) !== 1) {
    return false;
  }

  let referenced = false,
    safe = true;
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    referenced = true;
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    if (!attribute || !isDirectJsxAttributeExpression(attribute, node)) {
      safe = false;
      return;
    }
    if (!attributeIsIntrinsicEvent(attribute)) {
      safe = false;
    }
  });
  return referenced && safe;
}

function attributeIsIntrinsicEvent(attribute: ts.JsxAttribute): boolean {
  if (!/^on[A-Z]/u.test(attribute.name.getText())) {
    return false;
  }
  const opening = attribute.parent.parent,
    tag =
      ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)
        ? opening.tagName
        : null;
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

function isLiteralBooleanSetter(call: ts.CallExpression): boolean {
  const value = call.arguments[0];
  return (
    call.arguments.length === 1 &&
    value !== undefined &&
    (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword)
  );
}

function isEventRootedLiteralSetterCall(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): boolean {
  return isInsideJsxEventCallback(call, owner);
}
