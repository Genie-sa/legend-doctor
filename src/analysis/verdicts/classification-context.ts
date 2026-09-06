import type {
  BranchUnmountMove,
  ClassifiedState,
  ComponentScope,
  DialogPayloadCut,
  DirectReturnCallSite,
  SiblingRenderCut,
  StateCandidate,
  StateSubtree,
  StateUsage,
} from "../model.js";
import {
  directBranchReturnCallSite,
  directUniqueReturnCallSite,
  setterCallEndsCommand,
} from "../return-call-sites.js";
import {
  functionalCounterUpdaterPreservesSnapshot,
  functionalUpdaterPrecedesSnapshotRead,
  refWouldChangeCommandSnapshot,
} from "../../rules/command-only-state/command-only-state.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import { EMPTY_NODES } from "../constants.js";
import type { HostTagImports } from "../../core/imports.js";
import { LAZY_CALLBACK_LEAF_PROOFS } from "../proofs/rule-proofs.js";
import type { LazyCallbackLeaf } from "../../rules/lazy-callback-leaf.js";
import type { MaterialityPolicy } from "../constants.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { SourceAnalysis } from "../proofs/contracts.js";
import { findLazyCallbackLeaf } from "../../rules/lazy-callback-leaf.js";
import { hasIndependentRenderCutWitness } from "../../rules/state-proofs/render-cut-witness.js";
import { hasOnlyEventCommandReads } from "../../rules/state-proofs/state-proofs.js";
import { hasRepeatedJsxRenderWorkOutside } from "../../rules/state-proofs/jsx-subtrees.js";
import { hasStateInitializer } from "../../rules/deferred-reveal/deferred-reveal.js";
import { jsxSubtreeForOpening } from "../ast-helpers.js";
import { nearestMutationFunction } from "../mutations.js";
import { setterOwnedByValueCallSite } from "../controlled-leaf-cuts.js";
import ts from "typescript";

export interface StateClassificationInputs {
  readonly belongsToObservableSelection: boolean;
  readonly branchUnmountMove: BranchUnmountMove | null;
  readonly childContracts: ChildContractResolver | null;
  readonly deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>;
  readonly dialogPayloadCut: DialogPayloadCut | null;
  readonly effectRegions: SourceAnalysis["lifecycleRegions"];
  readonly eventTransitionCallbacks: ReadonlySet<RuntimeFunctionLike>;
  readonly hasAdjacentEffectBooleanConsumers: boolean;
  readonly hasAdjacentEventBooleanConsumers: boolean;
  readonly hasCompanionWrites: boolean;
  readonly hasDetachedEffectWrites: boolean;
  readonly hasIndependentDirectEventWrite: boolean;
  readonly hasIndependentVisibilitySetterTransport: boolean;
  readonly hasMemoizedOptionCommand: boolean;
  readonly hasMultiSurfaceBooleanConsumers: boolean;
  readonly hasNonClosingCompanionWrites: boolean;
  readonly hasReactiveHostPropScalarConsumer: boolean;
  readonly hasReactiveMutationPath: boolean;
  readonly hasReturnedKeyedCursorConsumer: boolean;
  readonly hasSafeCommands: boolean;
  readonly hasSourceEventScalarConsumers: boolean;
  readonly hostTags: HostTagImports;
  readonly isAsyncLeafStatus: boolean;
  readonly isCohesiveAsyncStatus: boolean;
  readonly isDeferredReveal: boolean;
  readonly isKeyedLeafCollection: boolean;
  readonly isKeyedLeafRecord: boolean;
  readonly isKeyedLeafScalar: boolean;
  readonly isKeyedScalarWithSecondary: boolean;
  readonly isPropertyLocalObjectDraft: boolean;
  readonly isSelfRefreshingCommand: boolean;
  readonly isUnprovenAsyncStatus: boolean;
  readonly localComponents: ReadonlySet<string>;
  readonly ownerObservableSubscriptions: number;
  readonly ownerIsCommitSensitive: boolean;
  readonly materiality: MaterialityPolicy;
  readonly pureProjectionImports: ReadonlySet<string>;
  readonly siblingRenderCut: SiblingRenderCut | null;
  readonly sourceComponents: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
  readonly state: StateCandidate;
  readonly subtree: StateSubtree | null;
  readonly usage: StateUsage;
}

interface StateRenderCutEvidence {
  readonly branchCallSite: DirectReturnCallSite | null;
  readonly callbackLeaf: LazyCallbackLeaf | null;
  readonly descendantControlledCut: boolean;
  readonly directCallSite: DirectReturnCallSite | null;
  readonly hasCompactBooleanTransportCut: boolean;
  readonly hasRepeatedOwnerRenderCut: boolean;
  readonly hasVisibilityValueTransport: boolean;
}

interface StateCommandSnapshotEvidence {
  readonly hasCommandSnapshotHazard: boolean;
  readonly hasEventCommandReadProof: boolean;
  readonly hasFunctionalSnapshotHazard: boolean;
  readonly preservesFunctionalSnapshot: boolean;
}

export interface StateClassificationContext extends StateClassificationInputs {
  readonly commandSnapshot: StateCommandSnapshotEvidence;
  readonly renderCut: StateRenderCutEvidence;
}

export type StateVerdict = (context: StateClassificationContext) => ClassifiedState | null;

interface TransportRenderCutScope extends ComponentScope {
  readonly branchSubtree: ts.Node | null;
}

function isIndependentTransportRenderCut(
  branchCallSite: DirectReturnCallSite | null,
  { branchSubtree, localComponents, sourceComponents }: TransportRenderCutScope,
): boolean {
  if (branchCallSite === null || branchSubtree === null) {
    return false;
  }
  return hasIndependentRenderCutWitness({
    returned: branchCallSite.returned,
    excluded: [branchSubtree],
    localComponents,
    sourceComponents,
  });
}

function isCommandEndingBooleanState(state: StateCandidate, usage: StateUsage): boolean {
  return (
    usage.setterTargets.size === 0 &&
    usage.setterCallNodes.every((call) => setterCallEndsCommand(call, state.owner)) &&
    (hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) ||
      hasStateInitializer(state, ts.SyntaxKind.TrueKeyword))
  );
}

function transportsVisibilityProp(usage: StateUsage): boolean {
  return [...usage.valueProps.values()].some((props) =>
    [...props].some((prop) => /^(?:isOpen|isVisible|open|visible)$/u.test(prop)),
  );
}

export function stateRenderCutEvidence(inputs: StateClassificationInputs): StateRenderCutEvidence {
  const {
    hasCompanionWrites,
    hasIndependentVisibilitySetterTransport,
    hasReactiveMutationPath,
    localComponents,
    sourceComponents,
    state,
    usage,
  } = inputs;
  const directCallSite = directUniqueReturnCallSite(usage, state.owner);
  const branchCallSite = directBranchReturnCallSite(usage, state.owner);
  const branchSubtree = branchCallSite ? jsxSubtreeForOpening(branchCallSite.opening) : null;
  const hasIndependentTransportRenderCut = isIndependentTransportRenderCut(branchCallSite, {
    branchSubtree,
    localComponents,
    sourceComponents,
  });
  const hasRepeatedOwnerRenderCut =
    branchSubtree !== null && hasRepeatedJsxRenderWorkOutside(state.owner, branchSubtree);
  const hasCompactBooleanTransportCut =
    hasIndependentTransportRenderCut &&
    !hasCompanionWrites &&
    !hasReactiveMutationPath &&
    isCommandEndingBooleanState(state, usage);
  const descendantControlledCut =
    branchCallSite !== null &&
    branchSubtree !== null &&
    hasIndependentVisibilitySetterTransport &&
    setterOwnedByValueCallSite(usage, state.owner) &&
    hasIndependentTransportRenderCut;
  const callbackLeaf = findLazyCallbackLeaf({
    state,
    usage,
    localComponents,
    sourceComponents,
    proofs: LAZY_CALLBACK_LEAF_PROOFS,
  });
  return {
    branchCallSite,
    callbackLeaf,
    descendantControlledCut,
    directCallSite,
    hasCompactBooleanTransportCut,
    hasRepeatedOwnerRenderCut,
    hasVisibilityValueTransport: transportsVisibilityProp(usage),
  };
}

export function stateCommandSnapshotEvidence(
  inputs: StateClassificationInputs,
): StateCommandSnapshotEvidence {
  const { eventTransitionCallbacks, state, usage } = inputs;
  const hasFunctionalSnapshotHazard = functionalUpdaterPrecedesSnapshotRead(
    state,
    usage,
    nearestMutationFunction,
  );
  const preservesFunctionalSnapshot =
    hasFunctionalSnapshotHazard &&
    functionalCounterUpdaterPreservesSnapshot(state, usage, nearestMutationFunction);
  const hasEventCommandReadProof = hasOnlyEventCommandReads(
    state,
    EMPTY_NODES,
    eventTransitionCallbacks,
  );
  const hasCommandSnapshotHazard = refWouldChangeCommandSnapshot(
    state,
    usage,
    hasEventCommandReadProof,
  );
  return {
    hasCommandSnapshotHazard,
    hasEventCommandReadProof,
    hasFunctionalSnapshotHazard,
    preservesFunctionalSnapshot,
  };
}
