import type { SetterMutation, StateCandidate, StateUsage } from "../model.js";
import { callSetsLiteral, mutationsAreProvenCoexecuting } from "../mutations.js";
import { callSiteIsKeyed, directUniqueReturnCallSite } from "../return-call-sites.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import type { ClusterMemberContext } from "./observable-clusters.js";
import type { ClusterPairUsage } from "./cluster-pairs.js";
import type { StateFlowIndex } from "../../project/state-flow/state-flow.js";
import { directSetterTransport } from "../filter/filter-leaf-cut.js";
import { distinctClusterPair } from "./cluster-pairs.js";
import { hasStateInitializer } from "../../rules/deferred-reveal/deferred-reveal.js";
import { isRuntimeFunctionLike } from "../../core/ast.js";
import { mutationIsEventRooted } from "./text-draft-cluster.js";
import { stateMayHoldCallable } from "../../rules/state-proofs/state-proofs.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

interface ScalarDialogContractScope {
  readonly childContracts: ChildContractResolver;
  readonly knownComponents: ReadonlySet<string>;
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

function scalarDialogSharesDeferredCallSite(
  payload: StateCandidate,
  flag: StateCandidate,
  { childContracts, knownComponents, usageByState }: ScalarDialogContractScope,
): boolean {
  const usages: ClusterPairUsage = {
    firstUsage: usageByState.get(payload),
    secondUsage: usageByState.get(flag),
  };
  const [target] = [...(usages.firstUsage?.valueTargets ?? [])];
  return (
    scalarDialogUsageSharesCallSite(payload, flag, usages) &&
    target !== undefined &&
    knownComponents.has(target) &&
    scalarDialogCallSiteIsDeferred(payload, flag, {
      childContracts,
      knownComponents,
      target,
      usages,
    })
  );
}

export function normalizePersistentScalarDialogClusterMembers(
  members: readonly StateCandidate[],
  context: ClusterMemberContext,
): readonly StateCandidate[] | null {
  const { childContracts, knownComponents, mutations, stateFlow, usageByState } = context;
  const pair = childContracts
    ? distinctClusterPair(
        members,
        (state) => hasLiteralScalarDialogPayloadInitializer(state),
        (state) => hasStateInitializer(state, ts.SyntaxKind.FalseKeyword),
      )
    : null;
  if (!childContracts || !pair) {
    return null;
  }
  const { first: payload, second: flag } = pair;
  if (
    !scalarDialogSharesDeferredCallSite(payload, flag, {
      childContracts,
      knownComponents,
      usageByState,
    })
  ) {
    return null;
  }
  const payloadMutations = mutations.filter((mutation) => mutation.state === payload);
  const flagMutations = mutations.filter((mutation) => mutation.state === flag);
  return scalarDialogMutationsArePaired(payloadMutations, flagMutations, {
    flag,
    payload,
    stateFlow,
  })
    ? members
    : null;
}

function scalarDialogUsageSharesCallSite(
  payload: StateCandidate,
  flag: StateCandidate,
  { firstUsage: payloadUsage, secondUsage: flagUsage }: ClusterPairUsage,
): boolean {
  if (!payloadUsage || !flagUsage) {
    return false;
  }
  return (
    ![payloadUsage, flagUsage].some(
      (usage) =>
        usage.localRenderReads !== 0 ||
        usage.effectReads !== 0 ||
        usage.effectWrites !== 0 ||
        usage.deferredReads !== 0 ||
        usage.repeatedTransport ||
        usage.unstableTransport ||
        usage.setterUsesPreviousValue ||
        usage.shadowed ||
        usage.escaped,
    ) &&
    !stateMayHoldCallable(payload) &&
    !stateMayHoldCallable(flag) &&
    payloadUsage.valueTransportSites.size === 1 &&
    flagUsage.valueTransportSites.size === 1 &&
    [...payloadUsage.valueTransportSites][0] === [...flagUsage.valueTransportSites][0] &&
    payloadUsage.valueTargets.size === 1 &&
    flagUsage.valueTargets.size === 1 &&
    [...payloadUsage.valueTargets][0] === [...flagUsage.valueTargets][0] &&
    payloadUsage.setterTransportSites.size === 0 &&
    payloadUsage.setterReferences === payloadUsage.setterCalls &&
    flagUsage.setterTransportSites.size === 1 &&
    flagUsage.setterReferences === flagUsage.setterCalls + 1
  );
}

interface ScalarDialogCallSiteScope {
  readonly childContracts: ChildContractResolver;
  readonly knownComponents: ReadonlySet<string>;
  readonly target: string;
  readonly usages: ClusterPairUsage;
}

function scalarDialogCallSiteIsDeferred(
  payload: StateCandidate,
  flag: StateCandidate,
  { childContracts, target, usages }: ScalarDialogCallSiteScope,
): boolean {
  const { firstUsage: payloadUsage, secondUsage: flagUsage } = usages;
  if (!payloadUsage || !flagUsage) {
    return false;
  }
  const payloadCallSite = directUniqueReturnCallSite(payloadUsage, payload.owner)?.opening;
  const flagCallSite = directUniqueReturnCallSite(flagUsage, flag.owner)?.opening;
  const closeTransport = directSetterTransport(flag);
  return (
    payloadCallSite !== undefined &&
    payloadCallSite === flagCallSite &&
    !callSiteIsKeyed(payloadCallSite) &&
    closeTransport !== null &&
    closeTransport.target === target &&
    closeTransport.attribute.parent.parent === payloadCallSite &&
    childContracts.componentCallbackPropIsDeferred(target, closeTransport.attribute.name.getText())
  );
}

interface ScalarDialogPairScope {
  readonly flag: StateCandidate;
  readonly payload: StateCandidate;
  readonly stateFlow: StateFlowIndex;
}

function scalarDialogMutationsArePaired(
  payloadMutations: readonly SetterMutation[],
  flagMutations: readonly SetterMutation[],
  { flag, payload, stateFlow }: ScalarDialogPairScope,
): boolean {
  const opens = flagMutations.filter((mutation) =>
    callSetsLiteral(mutation, ts.SyntaxKind.TrueKeyword),
  );
  const closes = flagMutations.filter((mutation) =>
    callSetsLiteral(mutation, ts.SyntaxKind.FalseKeyword),
  );
  const paired = (left: SetterMutation, right: SetterMutation): boolean =>
    left.region === right.region &&
    mutationsAreProvenCoexecuting(left.call, right.call, { region: left.region, stateFlow });
  return (
    payloadMutations.length > 0 &&
    opens.length > 0 &&
    flagMutations.length === opens.length + closes.length &&
    payloadMutations.every(
      (mutation) =>
        mutationIsEventRooted(mutation, payload) && mutationWritesTypedPrimitive(mutation),
    ) &&
    flagMutations.every((mutation) => mutationIsEventRooted(mutation, flag)) &&
    payloadMutations.every((payloadMutation) =>
      opens.some((open) => paired(payloadMutation, open)),
    ) &&
    opens.every((open) => payloadMutations.some((payloadMutation) => paired(open, payloadMutation)))
  );
}

function hasLiteralScalarDialogPayloadInitializer(state: StateCandidate): boolean {
  const [initializer] = state.call.arguments;
  if (!initializer) {
    return false;
  }
  const value = unwrapTransparentExpression(initializer);
  return ts.isStringLiteralLike(value) || ts.isNumericLiteral(value);
}

function mutationWritesTypedPrimitive(mutation: SetterMutation): boolean {
  const [argument] = mutation.call.arguments;
  if (!argument || mutation.call.arguments.length !== 1) {
    return false;
  }
  const value = unwrapTransparentExpression(argument);
  if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)) {
    return true;
  }
  if (!ts.isIdentifier(value) || !isRuntimeFunctionLike(mutation.region)) {
    return false;
  }
  return mutation.region.parameters.some(
    (parameter) =>
      ts.isIdentifier(parameter.name) &&
      parameter.name.text === value.text &&
      parameter.type !== undefined &&
      primitiveDialogPayloadType(parameter.type),
  );
}

function primitiveDialogPayloadType(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type)) {
    return primitiveDialogPayloadType(type.type);
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.length > 0 && type.types.every(primitiveDialogPayloadType);
  }
  if (ts.isLiteralTypeNode(type)) {
    return ts.isStringLiteralLike(type.literal) || ts.isNumericLiteral(type.literal);
  }
  return type.kind === ts.SyntaxKind.StringKeyword || type.kind === ts.SyntaxKind.NumberKeyword;
}

export function isMonotonicDialogLatch(
  flag: StateCandidate,
  payloadOpenMutations: readonly SetterMutation[],
  { mutations, stateFlow, usageByState }: ClusterMemberContext,
): boolean {
  const usage = usageByState.get(flag);
  const flagMutations = mutations.filter((mutation) => mutation.state === flag);
  return (
    usage !== undefined &&
    usage.localRenderReads > 0 &&
    usage.transportedOccurrences === 0 &&
    usage.deferredReads === 0 &&
    usage.setterReferences === usage.setterCalls &&
    flagMutations.length > 0 &&
    flagMutations.every((mutation) => callSetsLiteral(mutation, ts.SyntaxKind.TrueKeyword)) &&
    flagMutations.every((flagMutation) =>
      payloadOpenMutations.some(
        (payloadMutation) =>
          flagMutation.region === payloadMutation.region &&
          mutationsAreProvenCoexecuting(flagMutation.call, payloadMutation.call, {
            region: flagMutation.region,
            stateFlow,
          }),
      ),
    )
  );
}

export function hasDialogPayloadInitializer(state: StateCandidate): boolean {
  return state.call.arguments.length === 0 || hasStateInitializer(state, ts.SyntaxKind.NullKeyword);
}
