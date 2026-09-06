import {
  BROAD_OWNER_JSX_ELEMENTS,
  MAX_LEAF_SUBTREE_RATIO,
  MIN_DIRECT_RENDER_READS,
  MIN_REPEATED_SETTER_CALLS,
} from "../constants.js";
import type { DialogPayloadCut, StateCandidate, StateUsage } from "../model.js";
import { findAncestorUntil, nodeWithin } from "../../core/ast.js";
import {
  hasUnstableSubtreeLifetime,
  isSafeJsxProjectionReference,
  jsxElementCount,
  jsxElementCountIn,
  lowestCommonJsxSubtree,
  nearestRepeatedRenderCall,
} from "../../rules/state-proofs/jsx-subtrees.js";
import { isCustomHookOwner, isCustomJsxTarget, jsxSubtreeLabel } from "../ast-helpers.js";
import {
  nodeIsDirectDeferredEvent,
  sourceProvenDirectEventCallbacks,
  stateReadsOutsideRenderAreEventRooted,
} from "../callbacks/deferred-events.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import type { DeferredEventScope } from "../callbacks/deferred-events.js";
import type { HookImports } from "../../core/imports.js";
import type { JsxSubtreeNode } from "../../rules/deferred-reveal/jsx-subtrees.js";
import type { MaterialityPolicy } from "../constants.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { directDialogPayloadGateBranch } from "./dialog-gates.js";
import { hasStateInitializer } from "../../rules/deferred-reveal/deferred-reveal.js";
import { isDirectTruthyStateCondition } from "../clusters/gated-feedback-cluster.js";
import { stateMayHoldCallable } from "../../rules/state-proofs/state-proofs.js";
import ts from "typescript";
import { uniqueReturnedExpression } from "../return-call-sites.js";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

interface DialogPayloadCutContext {
  readonly childContracts: ChildContractResolver | null;
  readonly imports: HookImports;
  readonly knownComponents: ReadonlySet<string>;
  readonly materiality: MaterialityPolicy;
}

function stateIsNullablePayload(state: StateCandidate, usage: StateUsage): boolean {
  return (
    state.setterName !== null &&
    !isCustomHookOwner(state.owner) &&
    hasStateInitializer(state, ts.SyntaxKind.NullKeyword) &&
    !stateMayHoldCallable(state) &&
    usage.localRenderReads > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.transportedOccurrences === 0 &&
    usage.setterCallNodes.length >= MIN_REPEATED_SETTER_CALLS &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped &&
    payloadWritesAlternateNullAndValue(usage)
  );
}

function payloadWritesAlternateNullAndValue(usage: StateUsage): boolean {
  return (
    usage.setterCallNodes.some((call) => setterCallSetsLiteral(call, ts.SyntaxKind.NullKeyword)) &&
    usage.setterCallNodes.some((call) => !setterCallSetsLiteral(call, ts.SyntaxKind.NullKeyword)) &&
    usage.setterCallNodes.every((call) => {
      const [argument] = call.arguments;
      return (
        call.arguments.length === 1 &&
        argument !== undefined &&
        !ts.isArrowFunction(argument) &&
        !ts.isFunctionExpression(argument)
      );
    })
  );
}

interface DialogBoundaryScope {
  readonly conditionalBoundary: NullablePayloadBoundary | null;
  readonly materiality: MaterialityPolicy;
  readonly usage: StateUsage;
}

function dialogSubtreeIsBounded(
  dialog: JsxSubtreeNode,
  state: StateCandidate,
  { conditionalBoundary, materiality, usage }: DialogBoundaryScope,
): boolean {
  const ownerJsx = jsxElementCount(state.owner);
  const dialogJsx = jsxElementCountIn(dialog);
  return (
    !ts.isJsxFragment(dialog) &&
    ownerJsx >= materiality.broadOwnerJsx &&
    !nearestRepeatedRenderCall(dialog, state.owner) &&
    (conditionalBoundary !== null || !hasUnstableSubtreeLifetime(dialog, state.owner)) &&
    usage.directRenderNodes.every((read) =>
      nodeWithin(read, conditionalBoundary?.gate ?? dialog),
    ) &&
    dialogJsx <= BROAD_OWNER_JSX_ELEMENTS &&
    dialogJsx / ownerJsx <= MAX_LEAF_SUBTREE_RATIO
  );
}

interface DialogMountScope {
  readonly conditionalBoundary: NullablePayloadBoundary | null;
  readonly knownComponents: ReadonlySet<string>;
}

function dialogMountIsProven(
  dialog: JsxSubtreeNode,
  state: StateCandidate,
  { conditionalBoundary, knownComponents }: DialogMountScope,
): boolean {
  const returned = uniqueReturnedExpression(state.owner);
  const opening = ts.isJsxElement(dialog) ? dialog.openingElement : dialog;
  if (returned === null || ts.isJsxFragment(opening)) {
    return false;
  }
  const target = opening.tagName.getText();
  return (
    nodeWithin(conditionalBoundary?.gate ?? dialog, returned) &&
    (!isCustomJsxTarget(target) || knownComponents.has(target)) &&
    (conditionalBoundary !== null || openingBindsNullablePayloadOpen(opening, state.valueName))
  );
}

function openingBindsNullablePayloadOpen(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  valueName: string,
): boolean {
  return opening.attributes.properties.some(
    (attribute) =>
      ts.isJsxAttribute(attribute) &&
      attribute.name.getText() === "open" &&
      attribute.initializer !== undefined &&
      ts.isJsxExpression(attribute.initializer) &&
      attribute.initializer.expression !== undefined &&
      isNullablePayloadOpenExpression(attribute.initializer.expression, valueName),
  );
}

function payloadWritesAreEventRooted(
  state: StateCandidate,
  usage: StateUsage,
  { childContracts, imports }: Pick<DialogPayloadCutContext, "childContracts" | "imports">,
): boolean {
  const provenEventRoots = childContracts
    ? new Set(sourceProvenDirectEventCallbacks(state.owner, imports, childContracts))
    : new Set<RuntimeFunctionLike>();
  const eventScope: DeferredEventScope = { childContracts, eventRoots: provenEventRoots };
  return (
    stateReadsOutsideRenderAreEventRooted(state, usage, eventScope) &&
    usage.setterCallNodes.every(
      (call) =>
        setterCallSetsLiteral(call, ts.SyntaxKind.NullKeyword) ||
        nodeIsDirectDeferredEvent(call, state, eventScope),
    )
  );
}

export function nullableDialogPayloadCut(
  state: StateCandidate,
  usage: StateUsage,
  { childContracts, imports, knownComponents, materiality }: DialogPayloadCutContext,
): DialogPayloadCut | null {
  if (!stateIsNullablePayload(state, usage)) {
    return null;
  }
  const conditionalBoundary = conditionalNullablePayloadBoundary(state, usage, knownComponents);
  const dialog =
    conditionalBoundary?.dialog ?? lowestCommonJsxSubtree(usage.directRenderNodes, state.owner);
  if (
    !dialog ||
    !dialogSubtreeIsBounded(dialog, state, { conditionalBoundary, materiality, usage }) ||
    !dialogMountIsProven(dialog, state, { conditionalBoundary, knownComponents })
  ) {
    return null;
  }
  if (!payloadWritesAreEventRooted(state, usage, { childContracts, imports })) {
    return null;
  }
  return {
    conditional: conditionalBoundary !== null,
    consumerLabel: jsxSubtreeLabel(dialog),
    consumerLine:
      dialog
        .getSourceFile()
        .getLineAndCharacterOfPosition((conditionalBoundary?.gate ?? dialog).getStart()).line + 1,
  };
}

function conditionalNullablePayloadBoundary(
  state: StateCandidate,
  usage: StateUsage,
  knownComponents: ReadonlySet<string>,
): NullablePayloadBoundary | null {
  if (usage.directRenderNodes.length < MIN_DIRECT_RENDER_READS) {
    return null;
  }

  for (const read of usage.directRenderNodes) {
    const boundary = payloadGateBoundaryForRead(read, state, usage);
    if (
      boundary &&
      dialogTargetIsKnownAndSafe(boundary.dialog, knownComponents, { state, usage })
    ) {
      return boundary;
    }
  }
  return null;
}

interface NullablePayloadBoundary {
  readonly dialog: ts.JsxElement | ts.JsxSelfClosingElement;
  readonly gate: ts.JsxExpression;
}

function payloadGateBoundaryForRead(
  read: ts.Node,
  state: StateCandidate,
  usage: StateUsage,
): NullablePayloadBoundary | null {
  const gate = findAncestorUntil(read, ts.isJsxExpression, state.owner);
  const expression = gate?.expression && unwrapTransparentExpression(gate.expression);
  const dialog = expression ? directDialogPayloadGateBranch(expression, state.valueName) : null;
  if (
    !gate ||
    !expression ||
    !dialog ||
    (!ts.isJsxElement(dialog) && !ts.isJsxSelfClosingElement(dialog)) ||
    !nodeWithin(read, dialogGateCondition(expression)) ||
    nearestRepeatedRenderCall(gate, state.owner) ||
    !usage.directRenderNodes.every((node) => nodeWithin(node, gate))
  ) {
    return null;
  }
  return { dialog, gate };
}

export interface StateRenderScope {
  readonly state: StateCandidate;
  readonly usage: StateUsage;
}

function dialogTargetIsKnownAndSafe(
  dialog: ts.JsxElement | ts.JsxSelfClosingElement,
  knownComponents: ReadonlySet<string>,
  { state, usage }: StateRenderScope,
): boolean {
  const opening = ts.isJsxElement(dialog) ? dialog.openingElement : dialog;
  const target = opening.tagName.getText();
  if (isCustomJsxTarget(target) && !knownComponents.has(target)) {
    return false;
  }
  return usage.directRenderNodes.every(
    (node) => !nodeWithin(node, dialog) || isSafeJsxProjectionReference(node, state.owner),
  );
}

function dialogGateCondition(expression: ts.Expression): ts.Expression {
  const value = unwrapTransparentExpression(expression);
  if (ts.isConditionalExpression(value)) {
    return value.condition;
  }
  return ts.isBinaryExpression(value) ? value.left : value;
}

function isNullablePayloadOpenExpression(expression: ts.Expression, stateName: string): boolean {
  const value = unwrapTransparentExpression(expression);
  if (isDirectTruthyStateCondition(value, stateName)) {
    return true;
  }
  if (
    !ts.isBinaryExpression(value) ||
    (value.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsToken &&
      value.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken)
  ) {
    return false;
  }
  const left = unwrapTransparentExpression(value.left);
  const right = unwrapTransparentExpression(value.right);
  return (
    (ts.isIdentifier(left) &&
      left.text === stateName &&
      right.kind === ts.SyntaxKind.NullKeyword) ||
    (left.kind === ts.SyntaxKind.NullKeyword && ts.isIdentifier(right) && right.text === stateName)
  );
}

function setterCallSetsLiteral(call: ts.CallExpression, kind: ts.SyntaxKind): boolean {
  return call.arguments.length === 1 && call.arguments[0]?.kind === kind;
}
