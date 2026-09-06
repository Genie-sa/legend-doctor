import { BROAD_OWNER_JSX_ELEMENTS, MAX_LEAF_SUBTREE_RATIO } from "../constants.js";
import type { StateCandidate, StateUsage } from "../model.js";
import { findAncestorUntil, nodeWithin, visit } from "../../core/ast.js";
import { isNonValueIdentifier, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import {
  jsxElementCount,
  jsxElementCountIn,
  nearestRepeatedRenderCall,
} from "../../rules/state-proofs/jsx-subtrees.js";
import type { ClusterAnalysisContext } from "../clusters/observable-clusters.js";
import { isDirectTruthyStateCondition } from "../clusters/gated-feedback-cluster.js";
import { isJsxNode } from "../../rules/state-proofs/callback-sites.js";
import { jsxTargetName } from "../ast-helpers.js";
import ts from "typescript";

export function payloadControlsOwnerJsx(
  payload: StateCandidate,
  knownComponents: ReadonlySet<string>,
): boolean {
  let controls = false;
  visit(payload.owner.body, (node) => {
    controls ||= readControlsOwnerJsx(node, payload, knownComponents);
  });
  return controls;
}

function readControlsOwnerJsx(
  node: ts.Node,
  payload: StateCandidate,
  knownComponents: ReadonlySet<string>,
): boolean {
  if (!ts.isIdentifier(node) || node.text !== payload.valueName || isNonValueIdentifier(node)) {
    return false;
  }
  if (!findAncestorUntil(node, isJsxNode, payload.owner)) {
    return false;
  }
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, payload.owner);
  const target = attribute ? jsxTargetName(attribute) : null;
  return !target || !knownComponents.has(target);
}

export function stateHasBoundedDialogGate(
  state: StateCandidate,
  members: readonly StateCandidate[],
  { knownComponents, usageByState }: ClusterAnalysisContext,
): boolean {
  const stateUsage = usageByState.get(state);
  if (
    !stateUsage ||
    stateUsage.localRenderReads === 0 ||
    stateUsage.localRenderReads !== stateUsage.directRenderNodes.length
  ) {
    return false;
  }

  const gate = boundedDialogGate(state, stateUsage);
  if (!gate) {
    return false;
  }
  const targetSites = knownComponentCallSites(gate.trueBranch, knownComponents);
  if (targetSites.size === 0) {
    return false;
  }
  return members.every((member) =>
    memberIsConfinedToDialogGate(usageByState.get(member), gate.expression, {
      knownComponents,
      targetSites,
    }),
  );
}

interface DialogGateTargets {
  readonly knownComponents: ReadonlySet<string>;
  readonly targetSites: ReadonlySet<number>;
}

function memberIsConfinedToDialogGate(
  usage: StateUsage | undefined,
  gate: ts.JsxExpression,
  { knownComponents, targetSites }: DialogGateTargets,
): boolean {
  return (
    usage !== undefined &&
    [...usage.jsxTargets].every((target) => knownComponents.has(target)) &&
    [...usage.valueTransportSites, ...usage.setterTransportSites].every((site) =>
      targetSites.has(site),
    ) &&
    usage.directRenderNodes.every((read) => nodeWithin(read, gate))
  );
}

interface BoundedDialogGate {
  readonly expression: ts.JsxExpression;
  readonly trueBranch: ts.Node;
}

function boundedDialogGate(
  state: StateCandidate,
  stateUsage: StateUsage,
): BoundedDialogGate | null {
  const [firstRead] = stateUsage.directRenderNodes;
  const gate = firstRead ? findAncestorUntil(firstRead, ts.isJsxExpression, state.owner) : null;
  const expression = gate?.expression && unwrapTransparentExpression(gate.expression);
  const trueBranch = expression ? directDialogPayloadGateBranch(expression, state.valueName) : null;
  if (
    !gate ||
    !trueBranch ||
    (!ts.isJsxElement(trueBranch) &&
      !ts.isJsxSelfClosingElement(trueBranch) &&
      !ts.isJsxFragment(trueBranch)) ||
    nearestRepeatedRenderCall(gate, state.owner) ||
    jsxElementCountIn(trueBranch) > BROAD_OWNER_JSX_ELEMENTS ||
    jsxElementCountIn(trueBranch) / jsxElementCount(state.owner) > MAX_LEAF_SUBTREE_RATIO ||
    !stateUsage.directRenderNodes.every((read) => nodeWithin(read, gate))
  ) {
    return null;
  }
  return { expression: gate, trueBranch };
}

function knownComponentCallSites(
  root: ts.Node,
  knownComponents: ReadonlySet<string>,
): ReadonlySet<number> {
  const sites = new Set<number>();
  visit(root, (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      knownComponents.has(node.tagName.getText())
    ) {
      sites.add(node.getStart());
    }
  });
  return sites;
}

export function directDialogPayloadGateBranch(
  expression: ts.Expression,
  payloadName: string,
): ts.Expression | null {
  const value = unwrapTransparentExpression(expression);
  if (
    ts.isConditionalExpression(value) &&
    isDirectTruthyStateCondition(value.condition, payloadName) &&
    unwrapTransparentExpression(value.whenFalse).kind === ts.SyntaxKind.NullKeyword
  ) {
    return unwrapTransparentExpression(value.whenTrue);
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    isDirectTruthyStateCondition(value.left, payloadName)
  ) {
    return unwrapTransparentExpression(value.right);
  }
  return null;
}
