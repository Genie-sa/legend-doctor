import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import { findAncestorUntil, nearestNestedFunction, nodeWithin, visit } from "../../core/ast.js";
import {
  isSafeJsxProjectionReference,
  nearestRepeatedRenderCall,
} from "../state-proofs/jsx-subtrees.js";
import type { MultiSurfaceBooleanOptions } from "./literal-boolean-leaf.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { expressionContainsJsx } from "../deferred-reveal/jsx-subtrees.js";
import { isRenderGateReference } from "../deferred-reveal/render-gates.js";
import { isSafeProjectionExpression } from "../deferred-reveal/safe-projections.js";
import { oneHopRenderProjectionReferences } from "../state-proofs/projection-hops.js";
import ts from "typescript";

export const MIN_CONDITIONAL_SURFACES = 2;

export const MAX_CONDITIONAL_SURFACES = 6;

const MAX_SURFACE_ELEMENTS = 4;

export const MAX_SURFACE_ELEMENT_SHARE = 0.4;

const PRESENTATION_ATTRIBUTES: ReadonlySet<string> = new Set(["className", "style"]);

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

export function isProportionateSurfaceSet(
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

export function surfacesAreAdjacentSiblings(expressions: readonly ts.JsxExpression[]): boolean {
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

export function multiSurfaceTally(
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

export function conditionalPresentationSurfaces(
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
