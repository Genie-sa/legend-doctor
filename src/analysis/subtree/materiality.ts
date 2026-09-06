import {
  BROAD_OWNER_JSX_ELEMENTS,
  COMPACT_OWNER_JSX_ELEMENTS,
  MAX_LEAF_SUBTREE_RATIO,
  MAX_REPEATED_PROJECTION_RATIO,
  MIN_OWNER_RENDER_CUT_ELEMENTS,
} from "../constants.js";
import type { StateCandidate, StateSubtree, StateUsage } from "../model.js";
import { commonRepeatedRender, jsxSubtreeLabel } from "../ast-helpers.js";
import { findAncestorUntil, nearestNestedFunction } from "../../core/ast.js";
import {
  hasUnstableSubtreeLifetime,
  jsxElementCountIn,
  nearestRepeatedRenderCall,
} from "../../rules/state-proofs/jsx-subtrees.js";
import type { JsxSubtreeNode } from "../../rules/deferred-reveal/jsx-subtrees.js";
import type { MaterialityPolicy } from "../constants.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { commonRenderGateSubtree } from "../../rules/deferred-reveal/render-gates.js";
import { expressionDependsOnBinding } from "../../rules/state-proofs/binding-lookup.js";
import { hasStateInitializer } from "../../rules/deferred-reveal/deferred-reveal.js";
import { isJsxNode } from "../../rules/state-proofs/callback-sites.js";
import { oneHopRenderProjectionReferences } from "../../rules/state-proofs/projection-hops.js";
import { repeatedRenderHasStableItemKey } from "../../rules/state-proofs/unique-repeated-selection.js";
import ts from "typescript";

export function repeatedSubscriptionSuffix(subtree: StateSubtree): string {
  if (subtree.uniqueRepeatedBranch) {
    return " inside its uniquely selected branch";
  }
  return subtree.repeated ? " with a per-item selector" : "";
}

export interface EffectSplitProjectionScope {
  readonly materiality: MaterialityPolicy;
  readonly ownerJsx: number;
  readonly pureProjectionImports: ReadonlySet<string>;
}

interface SubtreeMaterialityEvidence {
  readonly effectWrittenPresentation: boolean;
  readonly materiality: MaterialityPolicy;
  readonly uniqueRepeatedProjection: boolean;
}

export function isMaterialStateSubtree(
  subtree: JsxSubtreeNode,
  ownerJsx: number,
  { effectWrittenPresentation, materiality, uniqueRepeatedProjection }: SubtreeMaterialityEvidence,
): boolean {
  const subtreeJsx = jsxElementCountIn(subtree);
  return (
    (ownerJsx >= materiality.broadOwnerJsx && subtreeJsx / ownerJsx <= MAX_LEAF_SUBTREE_RATIO) ||
    (uniqueRepeatedProjection &&
      ownerJsx >= COMPACT_OWNER_JSX_ELEMENTS &&
      subtreeJsx / ownerJsx <= MAX_REPEATED_PROJECTION_RATIO) ||
    (effectWrittenPresentation &&
      ownerJsx < BROAD_OWNER_JSX_ELEMENTS &&
      ownerJsx - subtreeJsx >= MIN_OWNER_RENDER_CUT_ELEMENTS)
  );
}

export function multipleOneHopRenderProjectionReferences(
  owner: RuntimeFunctionLike,
  renderNodes: readonly ts.Node[],
): readonly ts.Identifier[] | null {
  const references = new Set<ts.Identifier>();
  for (const renderNode of renderNodes) {
    const projected = oneHopRenderProjectionReferences(owner, [renderNode]);
    if (!projected) {
      return null;
    }
    for (const reference of projected) {
      references.add(reference);
    }
  }
  return references.size > 0 ? [...references] : null;
}

export function isSafeEffectPresentationReference(
  node: ts.Node,
  owner: RuntimeFunctionLike,
): boolean {
  if (!findAncestorUntil(node, isJsxNode, owner)) {
    return false;
  }
  if (commonRenderGateSubtree([node], owner)) {
    return true;
  }
  const repeated = nearestRepeatedRenderCall(node, owner);
  if (
    !repeated ||
    !ts.isPropertyAccessExpression(repeated.expression) ||
    repeated.expression.expression !== node
  ) {
    return false;
  }
  const [callback] = repeated.arguments;
  return (
    callback !== undefined &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    repeatedRenderHasStableItemKey(callback)
  );
}

export function isKeyedRepeatedProjection(
  nodes: readonly ts.Node[],
  owner: RuntimeFunctionLike,
): boolean {
  const repeated = commonRepeatedRender(nodes, owner);
  const callback = repeated?.arguments[0];
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !repeatedRenderHasStableItemKey(callback)
  ) {
    return false;
  }
  const binding = callback.parameters[0]?.name;
  if (binding === undefined) {
    return false;
  }
  return nodes.every((node) => {
    const expression = jsxProjectionExpression(node, owner);
    return expression !== null && expressionDependsOnBinding(expression, binding, callback);
  });
}

function jsxProjectionExpression(
  node: ts.Node,
  boundary: RuntimeFunctionLike,
): ts.Expression | null {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, boundary);
  if (attribute?.initializer && ts.isJsxExpression(attribute.initializer)) {
    return attribute.initializer.expression ?? null;
  }
  return findAncestorUntil(node, ts.isJsxExpression, boundary)?.expression ?? null;
}

interface StateSubtreeResultInputs {
  readonly movedDeclarations?: readonly string[];
  readonly renderNodes: readonly ts.Node[];
  readonly state: StateCandidate;
  readonly uniqueRepeatedBranch?: boolean;
}

export function stateSubtreeResult(
  kind: StateSubtree["kind"],
  node: JsxSubtreeNode,
  inputs: StateSubtreeResultInputs,
): StateSubtree {
  const { movedDeclarations = [], renderNodes, state, uniqueRepeatedBranch = false } = inputs;
  const lineNode =
    kind === "gate" && nearestNestedFunction(node, state.owner) ? (renderNodes[0] ?? node) : node;
  return {
    kind,
    label: jsxSubtreeLabel(node),
    line: lineNode.getSourceFile().getLineAndCharacterOfPosition(lineNode.getStart()).line + 1,
    movedDeclarations,
    node,
    repeated: commonRepeatedRender(renderNodes, state.owner) !== null,
    uniqueRepeatedBranch,
    unstable: hasUnstableSubtreeLifetime(node, state.owner),
  };
}

interface MixedProjectionScope {
  readonly allowNestedSite?: boolean;
  readonly common: JsxSubtreeNode;
}

export function isSafeMixedProjectionTransport(
  state: StateCandidate,
  usage: StateUsage,
  scope: MixedProjectionScope,
): boolean {
  const { allowNestedSite = false, common } = scope;
  const [site] = [...usage.valueTransportSites];
  const [target] = [...usage.valueTargets];
  if (
    usage.valueTransportSites.size !== 1 ||
    usage.setterTransportSites.size > 0 ||
    usage.valueTargets.size !== 1 ||
    usage.repeatedTransport ||
    !hasStateInitializer(state, ts.SyntaxKind.NullKeyword) ||
    site === undefined ||
    (site !== common.getStart() &&
      !(allowNestedSite && common.getStart() <= site && site < common.end)) ||
    !target
  ) {
    return false;
  }
  const props = usage.valueProps.get(target);
  return (
    props !== undefined &&
    props.size > 0 &&
    [...props].every((prop) => !/^(?:children|key|ref|render|on[A-Z])/u.test(prop))
  );
}
