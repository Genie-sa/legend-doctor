import type {
  CommandProofs,
  OwnerEventCallbacks,
  OwnershipProofs,
  SourceAnalysis,
} from "./contracts.js";
import type { DialogPayloadCut, StateCandidate, StateUsage } from "../model.js";
import { EMPTY_RUNTIME_FUNCTIONS } from "../constants.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { collectEffectStateScopes } from "../owner-bindings.js";
import { findDeferredRevealStates } from "../../rules/deferred-reveal/deferred-reveal.js";
import { findStateCompanionWrites } from "../companion-writes.js";
import { isCustomHookOwner } from "../ast-helpers.js";
import { isPropertyLocalObjectDraftState } from "../../rules/object-draft/object-draft.js";
import { isSelectionStateName } from "../../rules/keyed-selection/keyed-selection.js";
import { isSetOrMapState } from "../../rules/keyed-selection/state-value-shapes.js";
import { nullableDialogPayloadCut } from "../dialog/nullable-payload-cut.js";

function selectionStateOwners(
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
): ReadonlySet<RuntimeFunctionLike> {
  return new Set(
    states
      .filter((state) => {
        const usage = usageByState.get(state);
        return (
          isSetOrMapState(state.call) &&
          isCustomHookOwner(state.owner) &&
          isSelectionStateName(state.valueName) &&
          usage !== undefined &&
          usage.effectWrites === 0
        );
      })
      .map((state) => state.owner),
  );
}

interface DialogPayloadScope {
  readonly safeCommandStates: ReadonlySet<StateCandidate>;
  readonly statesWithCompanionWrites: ReadonlySet<StateCandidate>;
}

function collectDialogPayloadCuts(
  analysis: SourceAnalysis,
  { safeCommandStates, statesWithCompanionWrites }: DialogPayloadScope,
): ReadonlyMap<StateCandidate, DialogPayloadCut> {
  const { childContracts, imports, knownComponents, materiality, states, usageByState } = analysis;
  const dialogPayloadCuts = new Map<StateCandidate, DialogPayloadCut>();
  for (const state of states) {
    const usage = usageByState.get(state);
    if (!usage || statesWithCompanionWrites.has(state) || !safeCommandStates.has(state)) {
      continue;
    }
    const cut = nullableDialogPayloadCut(state, usage, {
      childContracts,
      imports,
      knownComponents,
      materiality,
    });
    if (cut) {
      dialogPayloadCuts.set(state, cut);
    }
  }
  return dialogPayloadCuts;
}

function objectDraftStates(
  analysis: SourceAnalysis,
  { eventCallbacksByOwner }: OwnerEventCallbacks,
  proofs: CommandProofs & { readonly statesWithCompanionWrites: ReadonlySet<StateCandidate> },
): ReadonlySet<StateCandidate> {
  const { childContracts, localComponents, sourceComponents, states, usageByState } = analysis;
  const { reactiveMutationAffectedStates, safeCommandStates, statesWithCompanionWrites } = proofs;
  return new Set(
    states.filter((state) => {
      const usage = usageByState.get(state);
      return (
        usage !== undefined &&
        isPropertyLocalObjectDraftState(state, usage, {
          childContracts,
          eventCallbacks: eventCallbacksByOwner.get(state.owner) ?? EMPTY_RUNTIME_FUNCTIONS,
          hasCompanionWrites: statesWithCompanionWrites.has(state),
          hasReactiveMutationPath: reactiveMutationAffectedStates.has(state),
          hasSafeCommands: safeCommandStates.has(state),
          localComponents,
          sourceComponents,
        })
      );
    }),
  );
}

export function collectOwnershipProofs(
  analysis: SourceAnalysis,
  callbacks: OwnerEventCallbacks,
  commands: CommandProofs,
): OwnershipProofs {
  const { effects, stateFlow, states, usageByState } = analysis;
  const { safeCommandStates } = commands;
  const companionWrites = findStateCompanionWrites(states, stateFlow);
  const statesWithCompanionWrites = companionWrites.all;
  const propertyLocalObjectDrafts = objectDraftStates(analysis, callbacks, {
    ...commands,
    statesWithCompanionWrites,
  });
  const effectStateScopes = collectEffectStateScopes(states, usageByState);
  const observableSelectionOwners = selectionStateOwners(states, usageByState);
  const deferredRevealStates = findDeferredRevealStates(effects, states, usageByState);
  const dialogPayloadCuts = collectDialogPayloadCuts(analysis, {
    safeCommandStates,
    statesWithCompanionWrites,
  });
  return {
    companionWrites,
    deferredRevealStates,
    dialogPayloadCuts,
    effectStateScopes,
    observableSelectionOwners,
    propertyLocalObjectDrafts,
    statesWithCompanionWrites,
  };
}
