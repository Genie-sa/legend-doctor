import type {
  BranchUnmountMove,
  ClassifiedEffect,
  ClassifiedState,
  DialogPayloadCut,
  EffectCandidate,
  EffectStateScope,
  SiblingRenderCut,
  StateCandidate,
  StateCluster,
  StateSubtree,
  StateUsage,
} from "../model.js";
import type { AsyncLeafStatusAnalysis } from "../../rules/async-leaf-status/async-leaf-status.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import type { ConfirmationSet } from "../assumptions/confirmations.js";
import type { EffectDraftAnalysis } from "../../rules/effect-drafts/model.js";
import type { HookImports } from "../../core/imports.js";
import type { IndependentStateWrites } from "../independent-writes.js";
import type { InstalledLegendState } from "../../core/types.js";
import type { KeyedSelectionAnalysis } from "../../rules/keyed-selection/keyed-selection.js";
import type { MaterialityPolicy } from "../constants.js";
import type { ReactCommitContext } from "../../rules/react-commit-sensitivity/react-commit-sensitivity.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCompanionWrites } from "../companion-writes.js";
import type { StateFlowIndex } from "../../project/state-flow/state-flow.js";
import type ts from "typescript";

export interface ParsedSourceAnalysisOptions {
  /** Directory report file names are relative to, for locating research steps in other files. */
  readonly analysisRoot?: string | null;
  readonly childContracts: ChildContractResolver | null;
  readonly confirmations?: ConfirmationSet | null;
  readonly deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>;
  readonly imports?: HookImports;
  readonly legendState: InstalledLegendState | null;
  readonly legendValueBridges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly materiality?: MaterialityPolicy;
  readonly sourceComponents: ReadonlySet<string>;
  readonly stateFlow: StateFlowIndex;
}

export interface SourceAnalysis {
  readonly analysisRoot: string | null;
  readonly childContracts: ChildContractResolver | null;
  readonly commitSensitiveOwners: ReadonlySet<RuntimeFunctionLike>;
  /** Answered review questions this scan honours, or null when none were supplied. */
  readonly confirmations: ConfirmationSet | null;
  readonly deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>;
  readonly directEffectCallbacks: ReadonlySet<RuntimeFunctionLike>;
  readonly directEffectCalls: ReadonlySet<ts.CallExpression>;
  readonly effects: readonly EffectCandidate[];
  readonly fileName: string;
  readonly imports: HookImports;
  readonly knownComponents: ReadonlySet<string>;
  readonly legendState: InstalledLegendState | null;
  readonly legendValueBridges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly lifecycleRegions: ReadonlySet<ts.Node>;
  readonly localComponents: ReadonlySet<string>;
  readonly moduleScopeBindings: ReadonlySet<string>;
  readonly nonProductionHarness: boolean;
  readonly observableSubscriptionsByOwner: ReadonlyMap<RuntimeFunctionLike, number>;
  readonly materiality: MaterialityPolicy;
  readonly pureProjectionImports: ReadonlySet<string>;
  readonly reactCommit: ReactCommitContext;
  readonly reactiveMutationsByOwner: ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>>;
  readonly sourceComponents: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
  readonly stateFlow: StateFlowIndex;
  readonly states: readonly StateCandidate[];
  readonly unmatchedStateCalls: readonly ts.CallExpression[];
  readonly usageByState: ReadonlyMap<StateCandidate, StateUsage>;
  readonly useObservableBindingsByOwner: ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>>;
  readonly useValueBindingsByOwner: ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>>;
}

export interface OwnerEventCallbacks {
  readonly eventCallbacksByOwner: ReadonlyMap<
    RuntimeFunctionLike,
    ReadonlySet<RuntimeFunctionLike>
  >;
  readonly sourceEventCallbacksByOwner: Map<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>;
}

export interface CommandProofs {
  readonly memoizedOptionCommandStates: ReadonlySet<StateCandidate>;
  readonly reactiveMutationAffectedStates: ReadonlySet<StateCandidate>;
  readonly returnedKeyedCursorStates: ReadonlySet<StateCandidate>;
  readonly safeCommandStates: ReadonlySet<StateCandidate>;
  readonly selfRefreshingCommandStates: ReadonlySet<StateCandidate>;
  readonly subtreeByState: ReadonlyMap<StateCandidate, StateSubtree>;
}

export interface OwnershipProofs {
  readonly companionWrites: StateCompanionWrites;
  readonly deferredRevealStates: ReadonlySet<StateCandidate>;
  readonly dialogPayloadCuts: ReadonlyMap<StateCandidate, DialogPayloadCut>;
  readonly effectStateScopes: ReadonlyMap<RuntimeFunctionLike, EffectStateScope>;
  readonly observableSelectionOwners: ReadonlySet<RuntimeFunctionLike>;
  readonly propertyLocalObjectDrafts: ReadonlySet<StateCandidate>;
  readonly statesWithCompanionWrites: ReadonlySet<StateCandidate>;
}

export interface LeafConsumerProofs {
  readonly adjacentEffectBooleanStates: ReadonlySet<StateCandidate>;
  readonly adjacentEventBooleanStates: ReadonlySet<StateCandidate>;
  readonly asyncLeafStatuses: AsyncLeafStatusAnalysis;
  readonly branchUnmountMoves: ReadonlyMap<StateCandidate, BranchUnmountMove>;
  readonly independentStateWrites: IndependentStateWrites;
  readonly multiSurfaceBooleanStates: ReadonlySet<StateCandidate>;
  readonly reactiveHostPropScalarStates: ReadonlySet<StateCandidate>;
  readonly sourceEventScalarStates: ReadonlySet<StateCandidate>;
}

export interface ClusterProofs {
  readonly contextClusters: ReadonlyMap<StateCandidate, StateCluster>;
  readonly effectDrafts: EffectDraftAnalysis;
  readonly keyedSelections: KeyedSelectionAnalysis;
  readonly listenerRefClusters: ReadonlyMap<StateCandidate, StateCluster>;
  readonly observableClusters: ReadonlyMap<StateCandidate, StateCluster>;
  readonly siblingRenderCuts: ReadonlyMap<StateCandidate, SiblingRenderCut>;
  readonly subtreeClusters: ReadonlyMap<StateCandidate, StateCluster>;
}

export interface EffectProofs {
  readonly derivedStates: ReadonlySet<StateCandidate>;
  readonly effectClassifications: ReadonlyMap<EffectCandidate, ClassifiedEffect>;
  readonly legendValueMirrors: ReadonlyMap<StateCandidate, ClassifiedState>;
}

export interface StateAnalysisResult {
  readonly analysis: SourceAnalysis;
  readonly callbacks: OwnerEventCallbacks;
  readonly clusters: ClusterProofs;
  readonly commands: CommandProofs;
  readonly effectProofs: EffectProofs;
  readonly leaves: LeafConsumerProofs;
  readonly ownership: OwnershipProofs;
}
