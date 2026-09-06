import {
  bindingDeclarationCount,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  findAncestorUntil,
  nearestNestedFunction,
  nodeWithin,
  visit,
  visitSkippingNestedFunctions,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import { isMembershipMountGate, membershipUsesCallbackKey } from "./rendered-list-membership.js";
import {
  isSafeJsxProjectionReference,
  jsxElementCount,
  jsxElementCountIn,
  nearestRepeatedRenderCall,
} from "../state-proofs/jsx-subtrees.js";
import type { JsxSubtreeNode } from "../deferred-reveal/jsx-subtrees.js";
import { MAX_CONSUMER_JSX_SHARE } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import { bindingReferencesIn } from "./array-set-aliases.js";
import { commonRenderGateSubtree } from "../deferred-reveal/render-gates.js";
import { isJsxNode } from "../state-proofs/callback-sites.js";
import { isSafeProjectionExpression } from "../deferred-reveal/safe-projections.js";
import { repeatedRenderHasStableItemKey } from "../state-proofs/unique-repeated-selection.js";
import ts from "typescript";

export function isBoundedFilteredSelectionSummary(
  membership: ts.CallExpression,
  state: StateCandidate,
): boolean {
  const alias = filteredSelectionAlias(membership, state);
  if (!alias) {
    return false;
  }
  const references = bindingReferencesIn(state.owner, alias, alias.text);
  const gate = boundedRenderGate(references, state.owner);
  return (
    gate !== null &&
    references.length > 0 &&
    references.every((reference) => isBoundedSummaryUse(reference, gate, state.owner))
  );
}

function filteredSelectionAlias(
  membership: ts.CallExpression,
  state: StateCandidate,
): ts.Identifier | null {
  const callback = nearestNestedFunction(membership, state.owner);
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    ts.isBlock(callback.body) ||
    unwrapTransparentExpression(callback.body) !== membership ||
    !membershipUsesCallbackKey(membership, callback)
  ) {
    return null;
  }
  const filter = callback.parent;
  if (
    !ts.isCallExpression(filter) ||
    !filter.arguments.includes(callback) ||
    !ts.isPropertyAccessExpression(filter.expression) ||
    filter.expression.name.text !== "filter" ||
    !ts.isIdentifier(unwrapTransparentExpression(filter.expression.expression))
  ) {
    return null;
  }
  const declaration = filter.parent;
  return ts.isVariableDeclaration(declaration) &&
    declaration.initializer === filter &&
    ts.isIdentifier(declaration.name) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    bindingDeclarationCount(state.owner, declaration.name.text) === 1
    ? declaration.name
    : null;
}

function boundedRenderGate(
  references: readonly ts.Identifier[],
  owner: RuntimeFunctionLike,
): JsxSubtreeNode | null {
  const gates = new Set(
    references.flatMap((reference) => {
      const gate = commonRenderGateSubtree([reference], owner);
      return gate ? [gate] : [];
    }),
  );
  const gate = gates.size === 1 ? [...gates][0]! : null;
  return gate && jsxElementCountIn(gate) / jsxElementCount(owner) <= MAX_CONSUMER_JSX_SHARE
    ? gate
    : null;
}

function isBoundedSummaryUse(
  reference: ts.Identifier,
  gate: JsxSubtreeNode,
  owner: RuntimeFunctionLike,
): boolean {
  const property =
    ts.isPropertyAccessExpression(reference.parent) && reference.parent.expression === reference
      ? reference.parent
      : null;
  if (property?.name.text === "length") {
    return commonRenderGateSubtree([reference], owner) === gate;
  }
  if (
    property?.name.text !== "map" ||
    !ts.isCallExpression(property.parent) ||
    property.parent.expression !== property ||
    !nodeWithin(reference, gate)
  ) {
    return false;
  }
  const [row] = property.parent.arguments;
  return (
    row !== undefined &&
    (ts.isArrowFunction(row) || ts.isFunctionExpression(row)) &&
    repeatedRenderHasStableItemKey(row)
  );
}

export function collectionMembershipSummaryCall(
  membership: ts.CallExpression,
  owner: RuntimeFunctionLike,
): ts.CallExpression | null {
  const callback = nearestNestedFunction(membership, owner);
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    ts.isBlock(callback.body) ||
    unwrapTransparentExpression(callback.body) !== membership ||
    !membershipUsesCallbackKey(membership, callback)
  ) {
    return null;
  }
  const summary = callback.parent;
  if (
    !ts.isCallExpression(summary) ||
    !summary.arguments.includes(callback) ||
    !ts.isPropertyAccessExpression(summary.expression) ||
    !["every", "some"].includes(summary.expression.name.text) ||
    !ts.isIdentifier(unwrapTransparentExpression(summary.expression.expression))
  ) {
    return null;
  }
  return summary;
}

export function collectionSummaryControlsRepeatedRendering(
  summary: ts.Expression,
  owner: RuntimeFunctionLike,
): boolean {
  if (!owner.body || nearestRepeatedRenderCall(summary, owner)) {
    return true;
  }
  const declaration = findAncestorUntil(summary, ts.isVariableDeclaration, owner);
  if (
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    !nodeWithin(summary, declaration.initializer)
  ) {
    return referenceControlsRepeatedRendering(summary, owner);
  }
  if (bindingDeclarationCount(owner, declaration.name.text) !== 1) {
    return true;
  }
  const references = summaryAliasReferences(owner, declaration.name);
  return references.some((reference) => referenceControlsRepeatedRendering(reference, owner));
}

function summaryAliasReferences(
  owner: RuntimeFunctionLike,
  declarationName: ts.Identifier,
): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  const name = declarationName.getText();
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      node !== declarationName &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references;
}

function referenceControlsRepeatedRendering(node: ts.Node, owner: RuntimeFunctionLike): boolean {
  const repeated = nearestRepeatedRenderCall(node, owner);
  if (repeated) {
    const [callback] = repeated.arguments;
    if (
      callback &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      summaryFeedsStableRowProjection(node, callback)
    ) {
      return false;
    }
    return true;
  }
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (
      (ts.isBinaryExpression(current) &&
        nodeWithin(node, current.left) &&
        containsRepeatedRender(current.right)) ||
      (ts.isConditionalExpression(current) &&
        nodeWithin(node, current.condition) &&
        (containsRepeatedRender(current.whenTrue) || containsRepeatedRender(current.whenFalse))) ||
      (ts.isIfStatement(current) &&
        nodeWithin(node, current.expression) &&
        (containsRepeatedRender(current.thenStatement) ||
          (current.elseStatement !== undefined && containsRepeatedRender(current.elseStatement))))
    ) {
      return true;
    }
  }
  return false;
}

function summaryFeedsStableRowProjection(
  summaryReference: ts.Node,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  const declaration = findAncestorUntil(summaryReference, ts.isVariableDeclaration, callback);
  if (
    !declaration?.initializer ||
    !ts.isIdentifier(declaration.name) ||
    !nodeWithin(summaryReference, declaration.initializer) ||
    !isSafeProjectionExpression({
      expression: declaration.initializer,
      reference: summaryReference,
    })
  ) {
    return false;
  }
  const projectionName = declaration.name.text;
  const references: ts.Identifier[] = [];
  visitSkippingNestedFunctions(callback.body, callback, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === projectionName &&
      node !== declaration.name &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return (
    references.length > 0 &&
    references.every(
      (reference) =>
        !isMembershipMountGate(reference, callback) &&
        findAncestorUntil(reference, isJsxNode, callback) !== null &&
        isSafeJsxProjectionReference(reference, callback, new Set(["cn"])),
    )
  );
}

function containsRepeatedRender(root: ts.Node): boolean {
  let found = false;
  visitSkippingNestedRuntimeFunctions(root, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["map", "flatMap"].includes(node.expression.name.text)
    ) {
      found = true;
    }
  });
  return found;
}
