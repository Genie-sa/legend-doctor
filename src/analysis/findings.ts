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
import { findingFor, stateEvidence } from "./finding-format.js";
import { EMPTY_RUNTIME_FUNCTIONS } from "./constants.js";
import type { FindingsScope } from "./finding-clusters.js";
import type { HookFinding } from "../core/types.js";
import type { ResolvedStateClassification } from "./assumptions/review-assumptions.js";
import type { StateClassificationInputs } from "./verdicts/classification-context.js";
import { classifyCowrittenState } from "./lone-write-stretches.js";
import { classifyState } from "./verdicts/classify-state.js";
import { effectFindingFor } from "./effect-findings.js";
import { hasLazyStateInitializer } from "../rules/effect-drafts/effect-drafts.js";
import { omittedValueSetterName } from "./candidates.js";
import { opaqueInstanceOverride } from "../rules/opaque-instance-state.js";
import { renderPhaseWriteOverride } from "./render-phase-writes.js";
import { resolveStateClassification } from "./assumptions/review-assumptions.js";
import { splitCommitVerdict } from "./verdicts/split-commit-verdict.js";
import type ts from "typescript";
import { verificationFor } from "./assumptions/verification.js";
import { withReviewGuidance } from "./review-guidance.js";
import { withTransitionEvidence } from "./transition-evidence.js";
import { withoutCompanionWrites } from "./verdicts/classification-context.js";

export function buildFindings(result: StateAnalysisResult): HookFinding[] {
  const { analysis } = result;
  const aloneByState = new Map<StateCandidate, ClassifiedState>();
  const scope = findingsScope(result, (state) => {
    const cached = aloneByState.get(state);
    if (cached) {
      return cached;
    }
    const alone = classifyStateAlone(state, result);
    aloneByState.set(state, alone);
    return alone;
  });
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
  return findings
    .map((finding) => withReviewGuidance(finding))
    .toSorted(
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
    splitCommitCompanions: ownership.splitCommitCompanions.get(state) ?? [],
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
  return classifyState(withoutCompanionWrites(stateClassificationInputs(state, usage, result)));
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
  | "subscriptionHook"
> {
  return {
    hostTags: analysis.imports,
    localComponents: analysis.localComponents,
    materiality: analysis.materiality,
    pureProjectionImports: analysis.pureProjectionImports,
    sourceComponents: analysis.sourceComponents,
    sourceFile: analysis.sourceFile,
    subscriptionHook: analysis.subscriptionHook,
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
    unreferencedOwnerStateClassification(state, analysis) ??
    splitClusterClassification(state, inputs, stateClusterFor(state, result)) ??
    effectDraftStateClassification(
      state,
      clusters.effectDrafts.singletons.has(state),
      clusters.siblingRenderCuts.get(state),
    ) ??
    derivedStateClassification(state, effectProofs.derivedStates.has(state)) ??
    effectProofs.legendValueMirrors.get(state) ??
    classifyCowrittenState(inputs, analysis)
  );
}

/** A cluster converts its members together, but a member written in another stretch still commits separately. */
function splitClusterClassification(
  state: StateCandidate,
  { splitCommitCompanions }: StateClassificationInputs,
  cluster: StateCluster | undefined,
): ClassifiedState | null {
  const clustered = clusterStateClassification(cluster, state);
  return clustered && splitCommitVerdict(clustered, state, splitCommitCompanions);
}

interface StateVerdictResolution extends ResolvedStateClassification {
  /** React scheduling the state depends on overrides what the verdicts or a confirmation produced. */
  readonly overridden: boolean;
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
  const { action } = resolved.classification;
  const override =
    renderPhaseWriteOverride(state, usage, action) ??
    opaqueInstanceOverride(state, action) ??
    (action !== "review-state" &&
    action !== "keep-state" &&
    stateIsCommitSensitive(state, usage, result.analysis)
      ? commitSensitiveStateClassification(state)
      : null);
  return {
    ...resolved,
    classification: override ?? resolved.classification,
    overridden: override !== null,
  };
}

interface GroupAttachment {
  readonly cluster: StateCluster | undefined;
  readonly resolved: StateVerdictResolution;
  readonly state: StateCandidate;
}

function attachGroup(finding: HookFinding, { cluster, resolved, state }: GroupAttachment): void {
  if (resolved.overridden) {
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
  const finding = findingFor(state.call, resolved.classification, {
    evidence: [...stateEvidence(state, usage, analysis.sourceFile), ...resolved.evidence],
    fileName: analysis.fileName,
    hook: "useState",
    name: state.valueName,
    sourceFile: analysis.sourceFile,
  });
  withAssumption(finding, { analysis, resolved, state });
  attachGroup(finding, { cluster: stateClusterFor(state, result), resolved, state });
  withTransitionEvidence(finding, state, result);
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
  const { assumption, overridden } = resolved;
  if (!assumption || overridden) {
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
  const forcedRenderSetter = omittedValueSetterName(call);
  return findingFor(
    call,
    {
      action: "review-state",
      abstentionReason: "binding-shape-unsupported",
      confidence: "probable",
      message: forcedRenderSetter
        ? `Review this forced-render state; \`${forcedRenderSetter}\` has no value binding, so nothing reads it and every call re-renders the whole owner. Confirm which rendered values that re-render refreshes, then subscribe those leaves to an observable instead.`
        : "Review this React state; its binding shape is not a standard `[value, setter]` tuple.",
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

function unreferencedOwnerStateClassification(
  state: StateCandidate,
  { childContracts }: SourceAnalysis,
): ClassifiedState | null {
  if (!childContracts?.componentIsUnreferenced(state.owner)) {
    return null;
  }
  return {
    action: "keep-state",
    confidence: "certain",
    message: `Keep \`${state.valueName}\`; no production source in this application package renders its component, so a render-boundary migration saves no render.`,
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
