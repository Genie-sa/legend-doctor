import type { CommandProofs, SourceAnalysis } from "./contracts.js";
import type { StateCandidate, StateSubtree, StateUsage } from "../model.js";
import {
  setterCallbackEscapesThroughUnknownHook,
  setterReactiveMutationPaths,
} from "../commands/reactive-mutation-paths.js";
import { EMPTY_BINDINGS } from "../constants.js";
import type { ReactiveMutationPathCoverage } from "../commands/reactive-mutation-paths.js";
import { analyzeStateSubtree } from "../subtree/analyze-subtree.js";
import { isEffectOwnedMemoizedPresentationState } from "../commands/effect-owned-presentation.js";
import { isEffectOwnedReturnedKeyedCursor } from "../keyed-cursor.js";
import { isEffectOwnedSelfRefreshingCommandState } from "../commands/self-refreshing-command.js";
import { isSourceProvenMemoizedOptionCommand } from "../commands/memoized-option-command.js";
import { primitiveSetterUpdatersArePure } from "../mutations.js";

interface CommandProofSink {
  readonly memoizedOptionCommandStates: Set<StateCandidate>;
  readonly reactiveMutationAffectedStates: Set<StateCandidate>;
  readonly returnedKeyedCursorStates: Set<StateCandidate>;
  readonly safeCommandStates: Set<StateCandidate>;
  readonly selfRefreshingCommandStates: Set<StateCandidate>;
  readonly subtreeByState: Map<StateCandidate, StateSubtree>;
}

interface CommandProofScope {
  readonly analysis: SourceAnalysis;
  readonly sink: CommandProofSink;
}

function recordStateCommandProofs(
  state: StateCandidate,
  usage: StateUsage,
  { analysis, sink }: CommandProofScope,
): void {
  const reactiveMutationPaths = setterReactiveMutationPaths(
    state,
    usage,
    analysis.reactiveMutationsByOwner.get(state.owner) ?? EMPTY_BINDINGS,
  );
  if (reactiveMutationPaths.any) {
    sink.reactiveMutationAffectedStates.add(state);
  }
  const { effectOwnedMemoizedCommand, memoizedOptionCommand } = recordMemoizedCommandProofs(
    state,
    usage,
    { analysis, sink },
  );
  const projectionAllowed = stateProjectionIsSafe(state, usage, {
    memoizedCommand: effectOwnedMemoizedCommand || memoizedOptionCommand,
    reactiveMutationPaths,
  });
  if (projectionAllowed) {
    sink.safeCommandStates.add(state);
  }
  recordStateSubtreeProof(state, usage, {
    analysis,
    effectOwnedMemoizedCommand,
    projectionAllowed,
    sink,
  });
}

interface MemoizedCommandProofs {
  readonly effectOwnedMemoizedCommand: boolean;
  readonly memoizedOptionCommand: boolean;
}

function recordMemoizedCommandProofs(
  state: StateCandidate,
  usage: StateUsage,
  { analysis, sink }: CommandProofScope,
): MemoizedCommandProofs {
  const { childContracts, directEffectCalls, imports } = analysis;
  if (isEffectOwnedSelfRefreshingCommandState(state, usage, { directEffectCalls, imports })) {
    sink.selfRefreshingCommandStates.add(state);
  }
  const memoizedOptionCommand =
    childContracts !== null &&
    isSourceProvenMemoizedOptionCommand(state, usage, { childContracts, imports });
  if (memoizedOptionCommand) {
    sink.memoizedOptionCommandStates.add(state);
  }
  return {
    effectOwnedMemoizedCommand: isEffectOwnedMemoizedPresentationState(state, usage, {
      directEffectCalls,
      imports,
    }),
    memoizedOptionCommand,
  };
}

interface ProjectionSafetyEvidence {
  readonly memoizedCommand: boolean;
  readonly reactiveMutationPaths: ReactiveMutationPathCoverage;
}

function stateProjectionIsSafe(
  state: StateCandidate,
  usage: StateUsage,
  { memoizedCommand, reactiveMutationPaths }: ProjectionSafetyEvidence,
): boolean {
  return (
    !reactiveMutationPaths.all &&
    (!setterCallbackEscapesThroughUnknownHook(state, usage) || memoizedCommand) &&
    primitiveSetterUpdatersArePure(state, usage)
  );
}

interface SubtreeProofFlags {
  readonly effectOwnedMemoizedCommand: boolean;
  readonly projectionAllowed: boolean;
}

function recordStateSubtreeProof(
  state: StateCandidate,
  usage: StateUsage,
  {
    analysis,
    effectOwnedMemoizedCommand,
    projectionAllowed,
    sink,
  }: CommandProofScope & SubtreeProofFlags,
): void {
  const { childContracts, directEffectCalls, materiality, pureProjectionImports } = analysis;
  const subtree = analyzeStateSubtree(state, usage, {
    childContracts,
    directEffectCalls,
    effectOwnedMemoizedCommand,
    materiality,
    projectionAllowed,
    pureProjectionImports,
  });
  if (subtree) {
    sink.subtreeByState.set(state, subtree);
  }
  if (
    childContracts &&
    isEffectOwnedReturnedKeyedCursor(state, usage, { childContracts, directEffectCalls })
  ) {
    sink.returnedKeyedCursorStates.add(state);
  }
}

export function collectCommandProofs(analysis: SourceAnalysis): CommandProofs {
  const { states, usageByState } = analysis;
  const sink: CommandProofSink = {
    memoizedOptionCommandStates: new Set<StateCandidate>(),
    reactiveMutationAffectedStates: new Set<StateCandidate>(),
    returnedKeyedCursorStates: new Set<StateCandidate>(),
    safeCommandStates: new Set<StateCandidate>(),
    selfRefreshingCommandStates: new Set<StateCandidate>(),
    subtreeByState: new Map<StateCandidate, StateSubtree>(),
  };
  for (const state of states) {
    const usage = usageByState.get(state);
    if (usage) {
      recordStateCommandProofs(state, usage, { analysis, sink });
    }
  }
  return sink;
}
