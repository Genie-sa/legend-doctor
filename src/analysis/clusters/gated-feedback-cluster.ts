import type { CoexecutionScope, SetterMutation, StateCandidate, StateUsage } from "../model.js";
import { MAX_FEEDBACK_LEAF_ELEMENTS, MIN_REPEATED_SETTER_CALLS } from "../constants.js";
import { bindingDeclarationCount, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import {
  callSetsLiteral,
  callsAreAdjacentDraftWrites,
  mutationsAreProvenCoexecuting,
  mutationsWriteTogether,
  nearestMutationFunction,
} from "../mutations.js";
import {
  findAncestorUntil,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import {
  jsxElementCountIn,
  lowestCommonJsxSubtree,
} from "../../rules/state-proofs/jsx-subtrees.js";
import type { ClusterMemberContext } from "./observable-clusters.js";
import type { ClusterPairUsage } from "./cluster-pairs.js";
import type { JsxSubtreeNode } from "../../rules/deferred-reveal/jsx-subtrees.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { distinctClusterPair } from "./cluster-pairs.js";
import { hasStateInitializer } from "../../rules/deferred-reveal/deferred-reveal.js";
import { stateMayHoldCallable } from "../../rules/state-proofs/state-proofs.js";
import ts from "typescript";
import { uniqueReturnedExpression } from "../return-call-sites.js";

function gatedFeedbackUsageIsIsolated(
  payload: StateCandidate,
  feedback: StateCandidate,
  { firstUsage: payloadUsage, secondUsage: feedbackUsage }: ClusterPairUsage,
): boolean {
  if (!payloadUsage || !feedbackUsage) {
    return false;
  }
  return (
    ![payloadUsage, feedbackUsage].some(
      (usage) =>
        usage.shadowed ||
        usage.escaped ||
        usage.effectReads > 0 ||
        usage.effectWrites > 0 ||
        usage.setterUsesPreviousValue ||
        usage.transportedOccurrences > 0,
    ) &&
    !stateMayHoldCallable(payload) &&
    !stateMayHoldCallable(feedback) &&
    payloadUsage.localRenderReads > 0 &&
    feedbackUsage.localRenderReads > 0 &&
    payloadUsage.setterReferences === payloadUsage.setterCalls &&
    feedbackUsage.setterReferences === feedbackUsage.setterCalls
  );
}

interface GatedFeedbackTimingScope extends CoexecutionScope {
  readonly payloadResets: readonly SetterMutation[];
}

function gatedFeedbackMutationsAreTimed(
  payloadMutations: readonly SetterMutation[],
  feedbackMutations: readonly SetterMutation[],
  { payloadResets, region, stateFlow }: GatedFeedbackTimingScope,
): boolean {
  const feedbackResets = feedbackMutations.filter((mutation) =>
    callSetsLiteral(mutation, ts.SyntaxKind.FalseKeyword),
  );
  const feedbackStarts = feedbackMutations.filter((mutation) =>
    callSetsLiteral(mutation, ts.SyntaxKind.TrueKeyword),
  );
  return (
    payloadMutations.length >= MIN_REPEATED_SETTER_CALLS &&
    payloadResets.length > 0 &&
    payloadMutations.some((mutation) => !callSetsLiteral(mutation, ts.SyntaxKind.NullKeyword)) &&
    feedbackStarts.length > 0 &&
    feedbackResets.length >= MIN_REPEATED_SETTER_CALLS &&
    feedbackHasTimedReset(feedbackStarts, feedbackResets, { region, stateFlow })
  );
}

function feedbackIsGatedByPayload(
  payload: StateCandidate,
  feedback: StateCandidate,
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
): boolean {
  const payloadUsage = usageByState.get(payload);
  const feedbackUsage = usageByState.get(feedback);
  return (
    payloadUsage !== undefined &&
    feedbackUsage !== undefined &&
    gatedFeedbackUsageIsIsolated(payload, feedback, {
      firstUsage: payloadUsage,
      secondUsage: feedbackUsage,
    }) &&
    feedbackRenderIsConfinedToPayloadGate(payload, payloadUsage, feedbackUsage)
  );
}

export function normalizeGatedFeedbackClusterMembers(
  members: readonly StateCandidate[],
  { mutations, stateFlow, usageByState }: ClusterMemberContext,
): readonly StateCandidate[] | null {
  const pair = distinctClusterPair(
    members,
    (state) => hasStateInitializer(state, ts.SyntaxKind.NullKeyword),
    (state) => hasStateInitializer(state, ts.SyntaxKind.FalseKeyword),
  );
  if (!pair) {
    return null;
  }
  const { first: payload, second: feedback } = pair;
  if (!feedbackIsGatedByPayload(payload, feedback, usageByState)) {
    return null;
  }
  const payloadMutations = mutations.filter((mutation) => mutation.state === payload);
  const feedbackMutations = mutations.filter((mutation) => mutation.state === feedback);
  return gatedFeedbackResetsArePaired(payloadMutations, feedbackMutations, {
    region: feedback.owner,
    stateFlow,
  })
    ? [payload, feedback]
    : null;
}

function gatedFeedbackResetsArePaired(
  payloadMutations: readonly SetterMutation[],
  feedbackMutations: readonly SetterMutation[],
  { region, stateFlow }: CoexecutionScope,
): boolean {
  const payloadResets = payloadMutations.filter((mutation) =>
    callSetsLiteral(mutation, ts.SyntaxKind.NullKeyword),
  );
  if (
    !gatedFeedbackMutationsAreTimed(payloadMutations, feedbackMutations, {
      payloadResets,
      region,
      stateFlow,
    })
  ) {
    return false;
  }
  const feedbackResets = feedbackMutations.filter((mutation) =>
    callSetsLiteral(mutation, ts.SyntaxKind.FalseKeyword),
  );
  return payloadResets.some((payloadReset) =>
    feedbackResets.some((feedbackReset) =>
      mutationsWriteTogether(payloadReset, feedbackReset, stateFlow),
    ),
  );
}

function feedbackRenderIsConfinedToPayloadGate(
  payload: StateCandidate,
  payloadUsage: StateUsage,
  feedbackUsage: StateUsage,
): boolean {
  if (
    payloadUsage.directRenderNodes.length === 0 ||
    payloadUsage.localRenderReads !== payloadUsage.directRenderNodes.length ||
    feedbackUsage.directRenderNodes.length === 0 ||
    feedbackUsage.localRenderReads !== feedbackUsage.directRenderNodes.length
  ) {
    return false;
  }
  const feedbackLeaf = lowestCommonJsxSubtree(feedbackUsage.directRenderNodes, payload.owner);
  const returned =
    uniqueReturnedExpression(payload.owner) ?? uniqueJsxReturnAllowingNullGuard(payload.owner);
  if (!feedbackLeaf || jsxElementCountIn(feedbackLeaf) > MAX_FEEDBACK_LEAF_ELEMENTS || !returned) {
    return false;
  }
  let confined = false;
  visit(returned, (node) => {
    if (!confined) {
      confined = payloadGateConfinesFeedback(node, feedbackLeaf, {
        feedbackUsage,
        payload,
        payloadUsage,
      });
    }
  });
  return confined;
}

interface GatedFeedbackScope {
  readonly feedbackUsage: StateUsage;
  readonly payload: StateCandidate;
  readonly payloadUsage: StateUsage;
}

function payloadGateConfinesFeedback(
  node: ts.Node,
  feedbackLeaf: JsxSubtreeNode,
  { feedbackUsage, payload, payloadUsage }: GatedFeedbackScope,
): boolean {
  if (
    !ts.isConditionalExpression(node) ||
    !isDirectTruthyStateCondition(node.condition, payload.valueName)
  ) {
    return false;
  }
  return (
    payloadUsage.directRenderNodes.every((read) => nodeWithin(read, node)) &&
    feedbackUsage.directRenderNodes.every((read) => nodeWithin(read, node.whenTrue)) &&
    nodeWithin(feedbackLeaf, node.whenTrue)
  );
}

function uniqueJsxReturnAllowingNullGuard(owner: RuntimeFunctionLike): ts.Expression | null {
  if (!owner.body) {
    return null;
  }
  const returned: ts.Expression[] = [];
  let unsafe = false;
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (!unsafe) {
      unsafe = !collectJsxOrNullReturn(node, returned);
    }
  });
  return !unsafe && returned.length === 1 ? returned[0]! : null;
}

function collectJsxOrNullReturn(node: ts.Node, returned: ts.Expression[]): boolean {
  if (!ts.isReturnStatement(node)) {
    return true;
  }
  const expression = node.expression && unwrapTransparentExpression(node.expression);
  if (expression?.kind === ts.SyntaxKind.NullKeyword) {
    return true;
  }
  if (!expression || !isJsxRootExpression(expression)) {
    return false;
  }
  returned.push(expression);
  return true;
}

function isJsxRootExpression(expression: ts.Expression): boolean {
  return (
    ts.isJsxElement(expression) ||
    ts.isJsxSelfClosingElement(expression) ||
    ts.isJsxFragment(expression)
  );
}

export function isDirectTruthyStateCondition(
  expression: ts.Expression,
  stateName: string,
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return value.text === stateName;
  }
  return (
    ts.isPrefixUnaryExpression(value) &&
    value.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isPrefixUnaryExpression(value.operand) &&
    value.operand.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isIdentifier(value.operand.operand) &&
    value.operand.operand.text === stateName
  );
}

function feedbackHasTimedReset(
  starts: readonly SetterMutation[],
  resets: readonly SetterMutation[],
  { region: owner, stateFlow }: CoexecutionScope,
): boolean {
  if (bindingDeclarationCount(owner, "setTimeout") > 0) {
    return false;
  }
  return resets.some((reset) => {
    const timer = findAncestorUntil(
      reset.call,
      (node): node is ts.CallExpression => {
        if (
          !ts.isCallExpression(node) ||
          !ts.isIdentifier(node.expression) ||
          node.expression.text !== "setTimeout"
        ) {
          return false;
        }
        const [callback] = node.arguments;
        return callback !== undefined && nodeWithin(reset.call, callback);
      },
      owner,
    );
    if (!timer) {
      return false;
    }
    const command = nearestMutationFunction(timer, owner);
    return starts.some(
      (start) =>
        start.region === command &&
        start.call.getStart() < timer.getStart() &&
        (callsAreAdjacentDraftWrites(start.call, timer) ||
          mutationsAreProvenCoexecuting(start.call, timer, { region: command, stateFlow })),
    );
  });
}
