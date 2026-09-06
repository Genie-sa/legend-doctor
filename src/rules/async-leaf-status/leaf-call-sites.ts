import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import {
  findAncestorUntil,
  isRuntimeFunctionLike,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import {
  isSafeJsxProjectionReference,
  lowestCommonJsxSubtree,
  nearestRepeatedRenderCall,
} from "../state-proofs/jsx-subtrees.js";
import type { AsyncLeafCallSites } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateUsage } from "../../analysis/model.js";
import { commonRenderGateSubtree } from "../deferred-reveal/render-gates.js";
import { isSafeProjectionExpression } from "../deferred-reveal/safe-projections.js";
import ts from "typescript";

const MAX_TRANSPORT_SITES = 3;

interface AsyncLeafSite {
  boundary: ts.Node;
  requiresUnconditionalAwait: boolean;
  returned: ts.Expression;
}

interface AsyncLeafOpening {
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  requiresUnconditionalAwait: boolean;
}

export function asyncLeafCallSites(
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
