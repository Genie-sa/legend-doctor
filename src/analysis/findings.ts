import type {
  ClassifiedState,
  SiblingRenderCut,
  StateCandidate,
  StateCluster,
  StateUsage,
} from "./model.js";
import type { SourceAnalysis, StateAnalysisResult } from "./proofs/contracts.js";
import {
  attachClusterGroup,
  clusterStateClassification,
  findingsScope,
  stateClusterFor,
} from "./finding-clusters.js";
import {
  commitSensitiveStateClassification,
  stateIsCommitSensitive,
} from "./commit-sensitive-state.js";
import { findingFor, stateEvidence, withMaterialityTier } from "./finding-format.js";
import { EMPTY_RUNTIME_FUNCTIONS } from "./constants.js";
import type { FindingsScope } from "./finding-clusters.js";
import type { HookFinding } from "../core/types.js";
import type { ResolvedStateClassification } from "./assumptions/review-assumptions.js";
import type { StateClassificationInputs } from "./verdicts/classification-context.js";
import { classifyState } from "./verdicts/classify-state.js";
import { effectFindingFor } from "./effect-findings.js";
import { hasLazyStateInitializer } from "../rules/effect-drafts/effect-drafts.js";
import { resolveStateClassification } from "./assumptions/review-assumptions.js";
import type ts from "typescript";
import { verificationFor } from "./assumptions/verification.js";

export function buildFindings(result: StateAnalysisResult): HookFinding[] {
  const { analysis } = result;
  const scope = findingsScope(result, (state) => classifyStateAlone(state, result));
  const stateFindings = new Map<StateCandidate, HookFinding>();
  for (const state of analysis.states) {
    const finding = stateFindingFor(state, scope);
    if (finding) {
      stateFindings.set(state, finding);
    }
  }
  const findings = [
    ...stateFindings.values(),
    ...analysis.unmatchedStateCalls.map((call) => unmatchedStateFinding(call, analysis)),
    ...analysis.effects.flatMap((effect) => effectFindingFor(effect, result, stateFindings) ?? []),
  ];
  return findings.toSorted(
    (left, right) =>
      left.location.line - right.location.line ||
      left.location.column - right.location.column ||
      left.hook.localeCompare(right.hook),
  );
}

function stateClassificationInputs(
  state: StateCandidate,
  usage: StateUsage,
  result: StateAnalysisResult,
): StateClassificationInputs {
  const { analysis, callbacks, clusters, commands, leaves, ownership } = result;
  return {
    belongsToObservableSelection: ownership.observableSelectionOwners.has(state.owner),
    branchUnmountMove: leaves.branchUnmountMoves.get(state) ?? null,
    childContracts: analysis.childContracts,
    deferredCallbackHooks: analysis.deferredCallbackHooks,
    dialogPayloadCut: ownership.dialogPayloadCuts.get(state) ?? null,
    eventTransitionCallbacks:
      callbacks.eventCallbacksByOwner.get(state.owner) ?? EMPTY_RUNTIME_FUNCTIONS,
    hasAdjacentEffectBooleanConsumers: leaves.adjacentEffectBooleanStates.has(state),
    hasAdjacentEventBooleanConsumers: leaves.adjacentEventBooleanStates.has(state),
    ...effectWriteInputs(usage, analysis),
    hasCompanionWrites: ownership.statesWithCompanionWrites.has(state),
    hasIndependentDirectEventWrite: leaves.independentStateWrites.directEventWrites.has(state),
    hasIndependentVisibilitySetterTransport:
      leaves.independentStateWrites.visibilitySetterTransports.has(state),
    hasMemoizedOptionCommand: commands.memoizedOptionCommandStates.has(state),
    hasMultiSurfaceBooleanConsumers: leaves.multiSurfaceBooleanStates.has(state),
    hasNonClosingCompanionWrites: ownership.companionWrites.nonClosing.has(state),
    hasReactiveHostPropScalarConsumer: leaves.reactiveHostPropScalarStates.has(state),
    hasReactiveMutationPath: commands.reactiveMutationAffectedStates.has(state),
    hasReturnedKeyedCursorConsumer: commands.returnedKeyedCursorStates.has(state),
    hasSafeCommands: commands.safeCommandStates.has(state),
    hasSourceEventScalarConsumers: leaves.sourceEventScalarStates.has(state),
    isAsyncLeafStatus: leaves.asyncLeafStatuses.isolated.has(state),
    isCohesiveAsyncStatus: leaves.asyncLeafStatuses.cohesive.has(state),
    isDeferredReveal: ownership.deferredRevealStates.has(state),
    isKeyedLeafCollection: clusters.keyedSelections.collectionStates.has(state),
    isKeyedLeafRecord: clusters.keyedSelections.recordStates.has(state),
    isKeyedLeafScalar: clusters.keyedSelections.scalarStates.has(state),
    isKeyedScalarWithSecondary: clusters.keyedSelections.secondaryLeafStates.has(state),
    isPropertyLocalObjectDraft: ownership.propertyLocalObjectDrafts.has(state),
    isSelfRefreshingCommand: commands.selfRefreshingCommandStates.has(state),
    isUnprovenAsyncStatus: leaves.asyncLeafStatuses.unproven.has(state),
    ownerObservableSubscriptions: analysis.observableSubscriptionsByOwner.get(state.owner) ?? 0,
    ownerIsCommitSensitive: analysis.commitSensitiveOwners.has(state.owner),
    siblingRenderCut: clusters.siblingRenderCuts.get(state) ?? null,
    ...sourceInputs(analysis),
    state,
    subtree: commands.subtreeByState.get(state) ?? null,
    usage,
  };
}

function classifyStateAlone(state: StateCandidate, result: StateAnalysisResult): ClassifiedState {
  const usage = result.analysis.usageByState.get(state);
  if (!usage) {
    return {
      action: "review-state",
      abstentionReason: "binding-shape-unsupported",
      confidence: "probable",
      message: "",
    };
  }
  return classifyState({
    ...stateClassificationInputs(state, usage, result),
    hasCompanionWrites: false,
    hasNonClosingCompanionWrites: false,
  });
}

function sourceInputs(
  analysis: SourceAnalysis,
): Pick<
  StateClassificationInputs,
  | "hostTags"
  | "localComponents"
  | "materiality"
  | "pureProjectionImports"
  | "sourceComponents"
  | "sourceFile"
> {
  return {
    hostTags: analysis.imports,
    localComponents: analysis.localComponents,
    materiality: analysis.materiality,
    pureProjectionImports: analysis.pureProjectionImports,
    sourceComponents: analysis.sourceComponents,
    sourceFile: analysis.sourceFile,
  };
}

function effectWriteInputs(
  usage: StateUsage,
  analysis: SourceAnalysis,
): Pick<StateClassificationInputs, "effectRegions" | "hasDetachedEffectWrites"> {
  return {
    effectRegions: analysis.lifecycleRegions,
    hasDetachedEffectWrites: usage.effectWrites > 0 && usage.effectReads === 0,
  };
}

function baseStateClassification(
  state: StateCandidate,
  inputs: StateClassificationInputs,
  result: FindingsScope,
): ClassifiedState {
  const { analysis, clusters, effectProofs } = result;
  return (
    harnessStateClassification(state, analysis.nonProductionHarness) ??
    clusterStateClassification(stateClusterFor(state, result), state) ??
    effectDraftStateClassification(
      state,
      clusters.effectDrafts.singletons.has(state),
      clusters.siblingRenderCuts.get(state),
    ) ??
    derivedStateClassification(state, effectProofs.derivedStates.has(state)) ??
    effectProofs.legendValueMirrors.get(state) ??
    classifyState(inputs)
  );
}

interface StateVerdictResolution extends ResolvedStateClassification {
  /** A commit-sensitive owner overrides every conversion the verdicts or a confirmation produced. */
  readonly commitSensitiveOverride: boolean;
}

function resolveStateVerdict(
  state: StateCandidate,
  usage: StateUsage,
  result: FindingsScope,
): StateVerdictResolution {
  const inputs = stateClassificationInputs(state, usage, result);
  const resolved = resolveStateClassification(
    baseStateClassification(state, inputs, result),
    inputs,
    result,
  );
  const commitSensitiveOverride =
    stateIsCommitSensitive(state, usage, result.analysis) &&
    resolved.classification.action !== "review-state" &&
    resolved.classification.action !== "keep-state";
  return {
    ...resolved,
    classification: commitSensitiveOverride
      ? commitSensitiveStateClassification(state)
      : resolved.classification,
    commitSensitiveOverride,
  };
}

interface GroupAttachment {
  readonly cluster: StateCluster | undefined;
  readonly resolved: StateVerdictResolution;
  readonly state: StateCandidate;
}

function attachGroup(finding: HookFinding, { cluster, resolved, state }: GroupAttachment): void {
  if (resolved.commitSensitiveOverride) {
    return;
  }
  if (resolved.group) {
    finding.group = resolved.group;
    return;
  }
  attachClusterGroup(finding, state, cluster);
}

function stateFindingFor(state: StateCandidate, result: FindingsScope): HookFinding | null {
  const { analysis } = result;
  const usage = analysis.usageByState.get(state);
  if (!usage) {
    return null;
  }
  const resolved = resolveStateVerdict(state, usage, result);
  const finding = withMaterialityTier(
    findingFor(state.call, resolved.classification, {
      evidence: [...stateEvidence(state, usage, analysis.sourceFile), ...resolved.evidence],
      fileName: analysis.fileName,
      hook: "useState",
      name: state.valueName,
      sourceFile: analysis.sourceFile,
    }),
    state,
    analysis.materiality,
  );
  withAssumption(finding, { analysis, resolved, state });
  attachGroup(finding, { cluster: stateClusterFor(state, result), resolved, state });
  return finding;
}

interface AssumptionAttachment {
  readonly analysis: SourceAnalysis;
  readonly resolved: StateVerdictResolution;
  readonly state: StateCandidate;
}

/** A confirmed answer converts the finding and hands the agent the runtime check for that answer. */
function withAssumption(
  finding: HookFinding,
  { analysis, resolved, state }: AssumptionAttachment,
): void {
  const { assumption, commitSensitiveOverride } = resolved;
  if (!assumption || commitSensitiveOverride) {
    return;
  }
  finding.assumption = assumption;
  if (assumption.status === "confirmed") {
    finding.verification = verificationFor(
      assumption,
      `\`${state.valueName}\` and its owner`,
      analysis.fileName,
    );
  }
}

function unmatchedStateFinding(call: ts.CallExpression, analysis: SourceAnalysis): HookFinding {
  return findingFor(
    call,
    {
      action: "review-state",
      abstentionReason: "binding-shape-unsupported",
      confidence: "probable",
      message:
        "Review this React state; its binding shape is not a standard `[value, setter]` tuple.",
    },
    { fileName: analysis.fileName, hook: "useState", name: null, sourceFile: analysis.sourceFile },
  );
}

function harnessStateClassification(
  state: StateCandidate,
  nonProductionHarness: boolean,
): ClassifiedState | null {
  if (!nonProductionHarness) {
    return null;
  }
  return {
    action: "keep-state",
    confidence: "certain",
    message: `Keep \`${state.valueName}\` in this test, story, or demo harness; production render-boundary migrations do not apply here.`,
  };
}

function effectDraftStateClassification(
  state: StateCandidate,
  isEffectSynchronizedDraft: boolean,
  siblingCut: SiblingRenderCut | undefined,
): ClassifiedState | null {
  if (!isEffectSynchronizedDraft) {
    return null;
  }
  const subscription = siblingCut
    ? `keep producer commands non-tracking, subscribe only in the sibling ${siblingCut.consumerLabel} boundary at line ${siblingCut.consumerLine}, and pass state-independent fallback inputs as ordinary snapshots.`
    : "mutate from edit commands, snapshot once at command entry before deferred work, and subscribe only in rendered leaves.";
  const lazyNote = hasLazyStateInitializer(state)
    ? " Preserve its lazy initializer as a once-only owner snapshot; do not pass it to Legend as a computed function."
    : "";
  return {
    action: "use-observable",
    confidence: "probable",
    message: `Replace effect-synchronized React draft \`${state.valueName}\` with one component-lifetime observable; preserve the React synchronization effect and its dependencies, ${subscription}${lazyNote}`,
  };
}

function derivedStateClassification(
  state: StateCandidate,
  isDerived: boolean,
): ClassifiedState | null {
  if (!isDerived) {
    return null;
  }
  return {
    action: "delete-derived-state",
    confidence: "certain",
    message: `Delete React state \`${state.valueName}\`; it is assigned only by a derivation effect and should be calculated directly.`,
  };
}
