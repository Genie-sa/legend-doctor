import {
  MAX_LEAF_ELEMENTS,
  MAX_LEAF_SUBTREE_RATIO,
  MAX_TERMINAL_LEAVES,
  MIN_TERMINAL_LEAVES,
} from "../constants.js";
import type { StateCandidate, StateSubtree, StateUsage } from "../model.js";
import { findAncestorUntil, nearestNestedFunction, nodeWithin, visit } from "../../core/ast.js";
import {
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  isSafeJsxProjectionReference,
  jsxElementCountIn,
  lowestCommonJsxSubtree,
  nearestRepeatedRenderCall,
} from "../../rules/state-proofs/jsx-subtrees.js";
import {
  localPureProjectionBindings,
  nearestJsxElement,
  terminalRenderProjectionReferences,
} from "./projection-hops.js";
import type { EffectSplitProjectionScope } from "./materiality.js";
import type { JsxSubtreeNode } from "../../rules/deferred-reveal/jsx-subtrees.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { repeatedRenderHasStableItemKey } from "../../rules/state-proofs/unique-repeated-selection.js";
import { stateSubtreeResult } from "./materiality.js";
import ts from "typescript";

/**
 * Keeps an effect-owned numeric source at owner lifetime while proving that
 * all of its render flow terminates in a small set of stable presentation
 * leaves. Local helper calls qualify only when their implementation is pure
 * and closes over inert module constants.
 */
function terminalPresentationLeaves(
  terminals: readonly ts.Identifier[],
  owner: RuntimeFunctionLike,
  allowedCalls: ReadonlySet<string>,
): JsxSubtreeNode[] | null {
  const leaves: JsxSubtreeNode[] = [];
  for (const terminal of terminals) {
    const leaf = presentationLeafFor(terminal, owner, allowedCalls);
    if (!leaf) {
      return null;
    }
    leaves.push(leaf);
  }
  return leaves;
}

function presentationLeafFor(
  terminal: ts.Identifier,
  owner: RuntimeFunctionLike,
  allowedCalls: ReadonlySet<string>,
): JsxSubtreeNode | null {
  const repeated = nearestRepeatedRenderCall(terminal, owner);
  const leaf = nearestJsxElement(repeated ?? terminal, owner);
  if (!repeated) {
    return isSafeJsxProjectionReference(terminal, owner, allowedCalls) ? leaf : null;
  }
  const [callback] = repeated.arguments;
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !repeatedRenderHasStableItemKey(callback) ||
    !leaf ||
    jsxElementCountIn(leaf) > MAX_LEAF_ELEMENTS ||
    !nodeWithin(terminal, leaf)
  ) {
    return null;
  }
  return leaf;
}

function boundedUniquePresentationLeaves(
  leaves: readonly JsxSubtreeNode[],
  ownerJsx: number,
): readonly JsxSubtreeNode[] | null {
  const uniqueLeaves = [...new Map(leaves.map((leaf) => [leaf.getStart(), leaf])).values()];
  if (uniqueLeaves.length < MIN_TERMINAL_LEAVES || uniqueLeaves.length > MAX_TERMINAL_LEAVES) {
    return null;
  }
  const leafElements = uniqueLeaves.reduce((total, leaf) => total + jsxElementCountIn(leaf), 0);
  return leafElements / ownerJsx > MAX_LEAF_SUBTREE_RATIO ? null : uniqueLeaves;
}

function effectSplitTerminals(
  state: StateCandidate,
  usage: StateUsage,
  allowedCalls: ReadonlySet<string>,
): readonly ts.Identifier[] | null {
  const renderRoots = effectSplitRenderRoots(state, usage, allowedCalls);
  const terminals = renderRoots
    ? terminalRenderProjectionReferences(state.owner, renderRoots, allowedCalls)
    : null;
  return terminals && terminals.length >= MIN_TERMINAL_LEAVES ? terminals : null;
}

export function effectSplitProjectionSubtree(
  state: StateCandidate,
  usage: StateUsage,
  { materiality, ownerJsx, pureProjectionImports }: EffectSplitProjectionScope,
): StateSubtree | null {
  if (
    ownerJsx < materiality.broadOwnerJsx ||
    !hasDirectNumericInitializer(state) ||
    usage.transportedOccurrences !== 0 ||
    usage.setterUsesPreviousValue
  ) {
    return null;
  }

  const allowedCalls = new Set([
    ...pureProjectionImports,
    ...localPureProjectionBindings(state.owner.getSourceFile()),
  ]);
  const terminals = effectSplitTerminals(state, usage, allowedCalls);
  const leaves = terminals
    ? terminalPresentationLeaves(terminals, state.owner, allowedCalls)
    : null;
  const uniqueLeaves = leaves ? boundedUniquePresentationLeaves(leaves, ownerJsx) : null;
  const common = uniqueLeaves ? lowestCommonJsxSubtree(uniqueLeaves, state.owner) : null;
  if (!terminals || !uniqueLeaves || !common) {
    return null;
  }
  return splitProjectionResult(common, terminals, { leafCount: uniqueLeaves.length, state });
}

interface SplitProjectionOwner {
  readonly leafCount: number;
  readonly state: StateCandidate;
}

function splitProjectionResult(
  common: JsxSubtreeNode,
  terminals: readonly ts.Node[],
  { leafCount, state }: SplitProjectionOwner,
): StateSubtree {
  const result = stateSubtreeResult("effect-split-projection", common, {
    renderNodes: terminals,
    state,
  });
  result.leafCount = leafCount;
  return result;
}

function effectSplitRenderRoots(
  state: StateCandidate,
  usage: StateUsage,
  allowedCalls: ReadonlySet<string>,
): readonly ts.Identifier[] | null {
  if (!state.owner.body) {
    return null;
  }
  const direct = new Set(usage.directRenderNodes);
  const roots: ts.Identifier[] = [];
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (direct.has(node)) {
      roots.push(node);
      return;
    }
    const call = findAncestorUntil(node, ts.isCallExpression, state.owner);
    if (
      call &&
      ts.isIdentifier(call.expression) &&
      allowedCalls.has(call.expression.text) &&
      call.arguments.some((argument) => nodeWithin(node, argument)) &&
      nearestNestedFunction(node, state.owner) === null
    ) {
      roots.push(node);
      return;
    }
    safe = false;
  });
  return safe && roots.length > 0 ? roots : null;
}

function hasDirectNumericInitializer(state: StateCandidate): boolean {
  const [initializer] = state.call.arguments;
  if (!initializer) {
    return false;
  }
  const value = unwrapTransparentExpression(initializer);
  return (
    ts.isNumericLiteral(value) ||
    (ts.isPrefixUnaryExpression(value) &&
      (value.operator === ts.SyntaxKind.PlusToken || value.operator === ts.SyntaxKind.MinusToken) &&
      ts.isNumericLiteral(unwrapTransparentExpression(value.operand)))
  );
}
