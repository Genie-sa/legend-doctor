import type { SetterMutation, StateCandidate, StateUsage } from "../model.js";
import {
  callSetsLiteral,
  isControlledBooleanTransition,
  mutationsAreProvenCoexecuting,
} from "../mutations.js";
import { hasDialogPayloadInitializer, isMonotonicDialogLatch } from "./scalar-dialog-cluster.js";
import { payloadControlsOwnerJsx, stateHasBoundedDialogGate } from "../dialog/dialog-gates.js";
import type { ClusterMemberContext } from "./observable-clusters.js";
import { PAIRED_CLUSTER_SIZE } from "../constants.js";
import type { StateFlowIndex } from "../../project/state-flow/state-flow.js";
import type { StateRenderScope } from "../dialog/nullable-payload-cut.js";
import { hasStateInitializer } from "../../rules/deferred-reveal/deferred-reveal.js";
import { stateMayHoldCallable } from "../../rules/state-proofs/state-proofs.js";
import ts from "typescript";

interface DialogFlagProofContext {
  readonly mutations: readonly SetterMutation[];
  readonly stateFlow: StateFlowIndex;
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

function flagOpensWithPayload(
  flag: StateCandidate,
  payloadOpenMutations: readonly SetterMutation[],
  { mutations, stateFlow, usageByState }: DialogFlagProofContext,
): boolean {
  const flagMutations = mutations.filter((mutation) => mutation.state === flag);
  const openMutations = flagMutations.filter((mutation) =>
    callSetsLiteral(mutation, ts.SyntaxKind.TrueKeyword),
  );
  const canClose =
    flagMutations.some((mutation) => callSetsLiteral(mutation, ts.SyntaxKind.FalseKeyword)) ||
    flagMutations.some((mutation) => isControlledBooleanTransition(mutation)) ||
    (usageByState.get(flag)?.setterTargets.size ?? 0) > 0;
  if (openMutations.length === 0 || !canClose) {
    return false;
  }
  return openMutations.some((flagMutation) =>
    payloadOpenMutations.some(
      (payloadMutation) =>
        flagMutation.region === payloadMutation.region &&
        mutationsAreProvenCoexecuting(flagMutation.call, payloadMutation.call, {
          region: flagMutation.region,
          stateFlow,
        }),
    ),
  );
}

export function normalizeObservableDialogClusterMembers(
  members: readonly StateCandidate[],
  context: ClusterMemberContext,
): readonly StateCandidate[] | null {
  const { mutations, stateFlow, usageByState } = context;
  const roles = dialogClusterRoles(members, context);
  if (!roles) {
    return null;
  }
  const { latch, payload, payloadOpenMutations } = roles;
  const targetSets = dialogMemberTargetSets(members, { latch, payload }, context);
  if (!targetSets || !targetSets.some((targets) => targets.size > 0)) {
    return null;
  }
  const flagsPairWithPayload = roles.flags.every(
    (flag) =>
      flag === latch ||
      flagOpensWithPayload(flag, payloadOpenMutations, { mutations, stateFlow, usageByState }),
  );
  return flagsPairWithPayload && dialogGatesAreBounded(members, roles, context) ? members : null;
}

interface DialogClusterMembership extends DialogClusterRoles {
  readonly flags: readonly StateCandidate[];
  readonly payloadOpenMutations: readonly SetterMutation[];
}

function dialogClusterRoles(
  members: readonly StateCandidate[],
  context: ClusterMemberContext,
): DialogClusterMembership | null {
  const payloads = members.filter((member) => hasDialogPayloadInitializer(member));
  const flags = members.filter((state) => hasStateInitializer(state, ts.SyntaxKind.FalseKeyword));
  const [payload] = payloads;
  if (
    members.length < PAIRED_CLUSTER_SIZE ||
    payloads.length !== 1 ||
    !payload ||
    flags.length === 0 ||
    payloads.length + flags.length !== members.length
  ) {
    return null;
  }
  const payloadOpenMutations = context.mutations.filter(
    (mutation) =>
      mutation.state === payload && !callSetsLiteral(mutation, ts.SyntaxKind.NullKeyword),
  );
  const latches = flags.filter((flag) =>
    isMonotonicDialogLatch(flag, payloadOpenMutations, context),
  );
  if (payloadOpenMutations.length === 0 || latches.length > 1) {
    return null;
  }
  return { flags, latch: latches[0] ?? null, payload, payloadOpenMutations };
}

function dialogGatesAreBounded(
  members: readonly StateCandidate[],
  { latch, payload }: DialogClusterRoles,
  context: ClusterMemberContext,
): boolean {
  if (
    payloadControlsOwnerJsx(payload, context.knownComponents) &&
    !stateHasBoundedDialogGate(payload, members, context)
  ) {
    return false;
  }
  return !latch || stateHasBoundedDialogGate(latch, members, context);
}

interface DialogClusterRoles {
  readonly latch: StateCandidate | null;
  readonly payload: StateCandidate;
}

function dialogMemberTargetSets(
  members: readonly StateCandidate[],
  roles: DialogClusterRoles,
  { knownComponents, usageByState }: ClusterMemberContext,
): readonly ReadonlySet<string>[] | null {
  const targetSets: ReadonlySet<string>[] = [];
  for (const member of members) {
    const usage = usageByState.get(member);
    if (!usage || !dialogMemberUsageIsIsolated(member, usage)) {
      return null;
    }
    const targets = new Set([...usage.jsxTargets].filter((target) => knownComponents.has(target)));
    if (!dialogMemberTargetsAreSufficient({ state: member, usage }, targets, roles)) {
      return null;
    }
    targetSets.push(targets);
  }
  return targetSets;
}

function dialogMemberUsageIsIsolated(member: StateCandidate, usage: StateUsage): boolean {
  return (
    !usage.shadowed &&
    !usage.escaped &&
    !stateMayHoldCallable(member) &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    !usage.setterUsesPreviousValue
  );
}

function dialogMemberTargetsAreSufficient(
  { state: member, usage }: StateRenderScope,
  targets: ReadonlySet<string>,
  { latch, payload }: DialogClusterRoles,
): boolean {
  if (targets.size > 0) {
    return true;
  }
  if (member !== payload && member !== latch) {
    return false;
  }
  return member !== payload || usage.localRenderReads > 0 || usage.deferredReads > 0;
}
