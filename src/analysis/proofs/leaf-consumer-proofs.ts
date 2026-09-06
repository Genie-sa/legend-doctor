import type {
  CommandProofs,
  LeafConsumerProofs,
  OwnerEventCallbacks,
  OwnershipProofs,
  SourceAnalysis,
} from "./contracts.js";
import {
  isAdjacentEffectBooleanLeafState,
  isAdjacentEventBooleanLeafState,
  isMultiSurfaceLiteralBooleanState,
} from "../../rules/literal-boolean-leaf/literal-boolean-leaf.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import type { HookImports } from "../../core/imports.js";
import type { MaterialityPolicy } from "../constants.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../model.js";
import { findAsyncLeafStatuses } from "../../rules/async-leaf-status/async-leaf-status.js";
import { findBranchUnmountMoves } from "../branch-unmount.js";
import { findIndependentStateWrites } from "../independent-writes.js";
import { isCustomHookOwner } from "../ast-helpers.js";
import { isReactiveHostPropScalarState } from "../../rules/event-scalar-leaf/reactive-host-prop.js";
import { isSourceEventScalarLeafState } from "../../rules/event-scalar-leaf/event-scalar-leaf.js";
import { nearestNestedFunction } from "../../core/ast.js";
import { sourceProvenDirectEventCallbacks } from "../callbacks/deferred-events.js";

export function collectLeafConsumerProofs(
  analysis: SourceAnalysis,
  callbacks: OwnerEventCallbacks,
  proofs: CommandProofs & OwnershipProofs,
): LeafConsumerProofs {
  const { childContracts, localComponents, sourceComponents, stateFlow, states, usageByState } =
    analysis;
  const { eventCallbacksByOwner } = callbacks;
  const { reactiveMutationAffectedStates, safeCommandStates } = proofs;
  return {
    ...booleanLeafConsumerProofs(analysis, proofs),
    ...scalarLeafConsumerProofs(analysis, callbacks, proofs),
    asyncLeafStatuses: findAsyncLeafStatuses({
      states,
      usageByState,
      safeCommandStates,
      reactiveMutationAffectedStates,
      localComponents,
      sourceComponents,
      childContracts,
      eventCallbacksByOwner,
    }),
    branchUnmountMoves: findBranchUnmountMoves(states, {
      safeCommandStates,
      stateFlow,
      usageByState,
    }),
    independentStateWrites: findIndependentStateWrites(states),
  };
}

interface LiteralBooleanLeafEvidence {
  readonly hasCompanionWrites: boolean;
  readonly hasReactiveMutationPath: boolean;
  readonly hasSafeCommands: boolean;
  readonly isCustomHookOwner: boolean;
  readonly materiality: MaterialityPolicy;
  readonly pureProjectionImports: ReadonlySet<string>;
}

interface ScalarLeafEvidence {
  readonly eventCallbacks: ReadonlySet<RuntimeFunctionLike>;
  readonly hasCompanionWrites: boolean;
  readonly hasReactiveMutationPath: boolean;
  readonly hasSafeCommands: boolean;
  readonly pureProjectionImports: ReadonlySet<string>;
  readonly useCallbackNames: ReadonlySet<string>;
}

interface BooleanLeafProofs {
  readonly adjacentEffectBooleanStates: ReadonlySet<StateCandidate>;
  readonly adjacentEventBooleanStates: ReadonlySet<StateCandidate>;
  readonly multiSurfaceBooleanStates: ReadonlySet<StateCandidate>;
}

function booleanLeafConsumerProofs(
  analysis: SourceAnalysis,
  proofs: CommandProofs & OwnershipProofs,
): BooleanLeafProofs {
  const { directEffectCallbacks, materiality, pureProjectionImports, states, usageByState } =
    analysis;
  const { reactiveMutationAffectedStates, safeCommandStates, statesWithCompanionWrites } = proofs;
  const evidenceFor = (state: StateCandidate): LiteralBooleanLeafEvidence => ({
    hasCompanionWrites: statesWithCompanionWrites.has(state),
    hasReactiveMutationPath: reactiveMutationAffectedStates.has(state),
    hasSafeCommands: safeCommandStates.has(state),
    isCustomHookOwner: isCustomHookOwner(state.owner),
    materiality,
    pureProjectionImports,
  });
  return {
    adjacentEffectBooleanStates: new Set(
      states.filter((state) => {
        const usage = usageByState.get(state);
        return (
          usage !== undefined &&
          isAdjacentEffectBooleanLeafState(state, usage, {
            ...evidenceFor(state),
            effectWritesAreDirect: usage.setterCallNodes.every((call) => {
              const callback = nearestNestedFunction(call, state.owner);
              return callback !== null && directEffectCallbacks.has(callback);
            }),
          })
        );
      }),
    ),
    adjacentEventBooleanStates: new Set(
      states.filter((state) => {
        const usage = usageByState.get(state);
        return (
          usage !== undefined && isAdjacentEventBooleanLeafState(state, usage, evidenceFor(state))
        );
      }),
    ),
    multiSurfaceBooleanStates: new Set(
      states.filter((state) => {
        const usage = usageByState.get(state);
        return (
          usage !== undefined && isMultiSurfaceLiteralBooleanState(state, usage, evidenceFor(state))
        );
      }),
    ),
  };
}

interface ScalarLeafProofs {
  readonly reactiveHostPropScalarStates: ReadonlySet<StateCandidate>;
  readonly sourceEventScalarStates: ReadonlySet<StateCandidate>;
}

function ownerSourceEventCallbacks(
  owner: RuntimeFunctionLike,
  imports: HookImports,
  { childContracts, sourceEventCallbacksByOwner }: SourceEventCallbackCache,
): ReadonlySet<RuntimeFunctionLike> {
  const cached = sourceEventCallbacksByOwner.get(owner);
  if (cached) {
    return cached;
  }
  const resolved = sourceProvenDirectEventCallbacks(owner, imports, childContracts);
  sourceEventCallbacksByOwner.set(owner, resolved);
  return resolved;
}

interface SourceEventCallbackCache {
  readonly childContracts: ChildContractResolver;
  readonly sourceEventCallbacksByOwner: Map<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>;
}

function scalarLeafConsumerProofs(
  analysis: SourceAnalysis,
  callbacks: OwnerEventCallbacks,
  proofs: CommandProofs & OwnershipProofs,
): ScalarLeafProofs {
  const { childContracts, imports, localComponents, pureProjectionImports, sourceComponents } =
    analysis;
  const { states, usageByState } = analysis;
  const { reactiveMutationAffectedStates, safeCommandStates, statesWithCompanionWrites } = proofs;
  if (!childContracts) {
    return { reactiveHostPropScalarStates: new Set(), sourceEventScalarStates: new Set() };
  }
  const cache: SourceEventCallbackCache = {
    childContracts,
    sourceEventCallbacksByOwner: callbacks.sourceEventCallbacksByOwner,
  };
  const scalarStates = states.filter(
    (state) => usageByState.get(state) !== undefined && !isCustomHookOwner(state.owner),
  );
  const evidenceFor = (state: StateCandidate): ScalarLeafEvidence => ({
    eventCallbacks: ownerSourceEventCallbacks(state.owner, imports, cache),
    hasCompanionWrites: statesWithCompanionWrites.has(state),
    hasReactiveMutationPath: reactiveMutationAffectedStates.has(state),
    hasSafeCommands: safeCommandStates.has(state),
    pureProjectionImports,
    useCallbackNames: imports.useCallback,
  });
  return {
    reactiveHostPropScalarStates: new Set(
      scalarStates.filter((state) =>
        isReactiveHostPropScalarState(state, usageByState.get(state)!, {
          ...evidenceFor(state),
          hostTags: imports,
        }),
      ),
    ),
    sourceEventScalarStates: new Set(
      scalarStates.filter((state) =>
        isSourceEventScalarLeafState(state, usageByState.get(state)!, {
          ...evidenceFor(state),
          localComponents,
          sourceComponents,
        }),
      ),
    ),
  };
}
