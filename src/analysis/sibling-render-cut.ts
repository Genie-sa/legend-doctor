import {
  MAX_LEAF_SUBTREE_RATIO,
  PAIRED_TRANSPORT_OCCURRENCES,
  SAFE_PROJECTION_CALLS,
  SMALL_OWNER_JSX_ELEMENTS,
} from "./constants.js";
import type { SiblingRenderCut, StateCandidate, StateUsage } from "./model.js";
import {
  findAncestorUntil,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../core/ast.js";
import {
  hasAncestorInSet,
  isCustomHookOwner,
  jsxSubtreeForOpening,
  jsxSubtreeLabel,
} from "./ast-helpers.js";
import {
  hasUnstableSubtreeLifetime,
  isSafeJsxProjectionReference,
  jsxElementCount,
  jsxElementCountIn,
  lowestCommonJsxSubtree,
  nearestRepeatedRenderCall,
} from "../rules/state-proofs/jsx-subtrees.js";
import { jsxProducerForSetterCall, shareUniqueOwnerReturn } from "./callbacks/local-callbacks.js";
import type { JsxSubtreeNode } from "../rules/deferred-reveal/jsx-subtrees.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import { directUniqueReturnCallSite } from "./return-call-sites.js";
import { isJsxNode } from "../rules/state-proofs/callback-sites.js";
import { isRenderGateReference } from "../rules/deferred-reveal/render-gates.js";
import { jsxSubtreeAncestors } from "../rules/deferred-reveal/jsx-subtrees.js";
import { mutationRegionOnlyCallsStateSetters } from "../rules/effect-drafts/draft-mutations.js";
import { nearestMutationFunction } from "./mutations.js";
import { oneHopRenderProjectionReferences } from "../rules/state-proofs/projection-hops.js";
import { stateMayHoldCallable } from "../rules/state-proofs/state-proofs.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../core/analysis-ast.js";

function hasLocalRenderConsumer(usage: StateUsage): boolean {
  return (
    usage.transportedOccurrences === 0 &&
    usage.localRenderReads > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length
  );
}

function hasPairedTransportConsumer(usage: StateUsage): boolean {
  return (
    usage.localRenderReads === 0 &&
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1 &&
    usage.setterTransportSites.size === 1 &&
    usage.setterTargets.size === 1 &&
    usage.setterCalls === 0 &&
    usage.setterReferences === 1 &&
    usage.transportedOccurrences === PAIRED_TRANSPORT_OCCURRENCES &&
    !usage.repeatedTransport &&
    !usage.unstableTransport
  );
}

function uniqueSetterProducer(
  state: StateCandidate,
  usage: StateUsage,
  effectNodes: ReadonlySet<ts.Node>,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const setterNames = new Set(state.setterName === null ? [] : [state.setterName]);
  const commandCalls = usage.setterCallNodes.filter((call) => !hasAncestorInSet(call, effectNodes));
  const commandProducers = commandCalls.map((call) => jsxProducerForSetterCall(call, state.owner));
  const producer =
    commandCalls.length > 0 ? commandProducers[0] : directTransportProducer(usage, state.owner);
  if (
    !producer ||
    commandProducers.some((candidate) => candidate !== producer) ||
    commandCalls.some(
      (call) =>
        !mutationRegionOnlyCallsStateSetters(
          nearestMutationFunction(call, state.owner),
          setterNames,
        ),
    )
  ) {
    return null;
  }
  return producer;
}

function subtreesAreStableSiblings(
  producerSubtree: JsxSubtreeNode,
  consumer: JsxSubtreeNode,
  owner: RuntimeFunctionLike,
): boolean {
  return (
    producerSubtree !== consumer &&
    !nodeWithin(producerSubtree, consumer) &&
    !nodeWithin(consumer, producerSubtree) &&
    !nearestRepeatedRenderCall(producerSubtree, owner) &&
    !hasUnstableSubtreeLifetime(producerSubtree, owner) &&
    !hasUnstableSubtreeLifetime(consumer, owner) &&
    shareUniqueOwnerReturn(producerSubtree, consumer, owner)
  );
}

function stateAllowsSiblingRenderCut(state: StateCandidate, usage: StateUsage): boolean {
  return (
    state.setterName !== null &&
    !isCustomHookOwner(state.owner) &&
    jsxElementCount(state.owner) >= SMALL_OWNER_JSX_ELEMENTS &&
    (hasLocalRenderConsumer(usage) || hasPairedTransportConsumer(usage)) &&
    usage.effectReads === 0 &&
    usage.deferredReads === 0 &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped &&
    !stateMayHoldCallable(state)
  );
}

export function siblingProducerConsumerCut(
  state: StateCandidate,
  usage: StateUsage,
  effectNodes: ReadonlySet<ts.Node>,
): SiblingRenderCut | null {
  if (!stateAllowsSiblingRenderCut(state, usage)) {
    return null;
  }
  const consumer = siblingProjectionConsumer(state, usage);
  if (!consumer) {
    return null;
  }
  const producer = uniqueSetterProducer(state, usage, effectNodes);
  if (
    !producer ||
    !subtreesAreStableSiblings(jsxSubtreeForOpening(producer), consumer, state.owner)
  ) {
    return null;
  }
  return {
    consumerLabel: jsxSubtreeLabel(consumer),
    consumerLine:
      consumer.getSourceFile().getLineAndCharacterOfPosition(consumer.getStart()).line + 1,
  };
}

function siblingProjectionConsumer(
  state: StateCandidate,
  usage: StateUsage,
): JsxSubtreeNode | null {
  if (usage.localRenderReads === 0) {
    const opening = directUniqueReturnCallSite(usage, state.owner)?.opening;
    return opening ? jsxSubtreeForOpening(opening) : null;
  }
  const references = oneHopRenderProjectionReferences(state.owner, usage.directRenderNodes);
  if (
    !references ||
    references.some((reference) => !isSafeSiblingProjectionReference(reference, state.owner))
  ) {
    return null;
  }
  const consumer = sharedProjectionSubtree(references, state.owner);
  return consumer &&
    jsxElementCountIn(consumer) / jsxElementCount(state.owner) <= MAX_LEAF_SUBTREE_RATIO
    ? consumer
    : null;
}

function sharedProjectionSubtree(
  references: readonly ts.Identifier[],
  owner: RuntimeFunctionLike,
): JsxSubtreeNode | null {
  const repeated = references.map((reference) => nearestRepeatedRenderCall(reference, owner));
  const [repeatedCall] = repeated;
  if (repeated.some((call) => call !== repeatedCall)) {
    return null;
  }
  return repeatedCall
    ? (jsxSubtreeAncestors(repeatedCall, owner)[0] ?? null)
    : lowestCommonJsxSubtree(references, owner);
}

function isSafeSiblingProjectionReference(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
): boolean {
  if (
    isRenderGateReference(reference, owner) &&
    !findAncestorUntil(reference, ts.isJsxAttribute, owner)
  ) {
    return false;
  }
  if (!findAncestorUntil(reference, isJsxNode, owner)) {
    return false;
  }
  return (
    isSafeJsxProjectionReference(reference, owner, SAFE_PROJECTION_CALLS) ||
    isSnapshotFallbackReference(reference, owner)
  );
}

function isSnapshotFallbackReference(reference: ts.Identifier, boundary: ts.Node): boolean {
  const attribute = findAncestorUntil(reference, ts.isJsxAttribute, boundary);
  const initializer = attribute?.initializer;
  if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) {
    return false;
  }
  const expression = unwrapTransparentExpression(initializer.expression);
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
    unwrapTransparentExpression(expression.left) !== reference
  ) {
    return false;
  }
  let readsStateAgain = false;
  visit(expression.right, (node) => {
    if (ts.isIdentifier(node) && node.text === reference.text) {
      readsStateAgain = true;
    }
  });
  return !readsStateAgain;
}

function directTransportProducer(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const [site] = [...usage.setterTransportSites];
  const valueCallSite = directUniqueReturnCallSite(usage, owner);
  if (site === undefined || !valueCallSite) {
    return null;
  }
  const openings: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  visitSkippingNestedRuntimeFunctions(valueCallSite.returned, (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.getStart() === site
    ) {
      openings.push(node);
    }
  });
  return openings.length === 1 ? openings[0]! : null;
}
