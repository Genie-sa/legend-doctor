import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import {
  hasIndependentCollectionEventWrite,
  hasIndependentRepeatedEventWrite,
} from "./independent-event-writes.js";
import { isKeyedLeafScalarState, isKeyedScalarWithSecondaryLeaf } from "./keyed-scalars.js";
import type { ChildContractResolver } from "../child-contract/model.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isImperativeRenderedCollectionState } from "./imperative-collection-reads.js";
import { isKeyedLeafCollectionState } from "./keyed-collections.js";
import { isKeyedLeafRecordState } from "./keyed-records.js";

export interface KeyedSelectionAnalysis {
  collectionStates: ReadonlySet<StateCandidate>;
  recordStates: ReadonlySet<StateCandidate>;
  scalarStates: ReadonlySet<StateCandidate>;
  secondaryLeafStates: ReadonlySet<StateCandidate>;
}

export function analyzeKeyedSelections(inputs: KeyedSelectionInputs): KeyedSelectionAnalysis {
  return {
    collectionStates: keyedCollectionStates(inputs),
    recordStates: keyedRecordStates(inputs),
    scalarStates: keyedLeafSelections(inputs, isKeyedLeafScalarState),
    secondaryLeafStates: keyedLeafSelections(inputs, isKeyedScalarWithSecondaryLeaf),
  };
}

export interface KeyedSelectionInputs {
  childContracts: ChildContractResolver | null;
  imports: HookImports;
  safeCommandStates: ReadonlySet<StateCandidate>;
  states: readonly StateCandidate[];
  statesWithCompanionWrites: ReadonlySet<StateCandidate>;
  usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

function keyedCollectionStates(inputs: KeyedSelectionInputs): Set<StateCandidate> {
  const { imports, safeCommandStates, states, statesWithCompanionWrites, usageByState } = inputs;
  const settersByOwner = ownerSetterNames(states);
  return new Set(
    states.filter(
      (state) =>
        safeCommandStates.has(state) &&
        isKeyedCollectionSelection({
          imports,
          ownerSetters: settersByOwner.get(state.owner) ?? new Set(),
          state,
          statesWithCompanionWrites,
          usage: usageByState.get(state),
        }),
    ),
  );
}

function keyedRecordStates(inputs: KeyedSelectionInputs): Set<StateCandidate> {
  const { childContracts, states, statesWithCompanionWrites, usageByState } = inputs;
  return new Set(
    states.filter(
      (state) =>
        !statesWithCompanionWrites.has(state) &&
        isKeyedLeafRecordState(state, usageByState.get(state), childContracts),
    ),
  );
}

function keyedLeafSelections(
  inputs: KeyedSelectionInputs,
  isKeyedLeaf: (state: StateCandidate, usage: StateUsage | undefined) => boolean,
): Set<StateCandidate> {
  const { safeCommandStates, states, statesWithCompanionWrites, usageByState } = inputs;
  return new Set(
    states.filter((state) => {
      const usage = usageByState.get(state);
      return (
        safeCommandStates.has(state) &&
        writesIndependentlyOfCompanions(state, usage, statesWithCompanionWrites) &&
        isKeyedLeaf(state, usage)
      );
    }),
  );
}

function ownerSetterNames(
  states: readonly StateCandidate[],
): Map<RuntimeFunctionLike, Set<string>> {
  const settersByOwner = new Map<RuntimeFunctionLike, Set<string>>();
  for (const state of states) {
    if (!state.setterName) {
      continue;
    }
    const setters = settersByOwner.get(state.owner) ?? new Set<string>();
    setters.add(state.setterName);
    settersByOwner.set(state.owner, setters);
  }
  return settersByOwner;
}

interface KeyedCollectionSelectionCheck {
  imports: HookImports;
  ownerSetters: ReadonlySet<string>;
  state: StateCandidate;
  statesWithCompanionWrites: ReadonlySet<StateCandidate>;
  usage: StateUsage | undefined;
}

function isKeyedCollectionSelection(check: KeyedCollectionSelectionCheck): boolean {
  const { imports, ownerSetters, state, statesWithCompanionWrites, usage } = check;
  return (
    (hasIndependentCollectionEventWrite(state, usage, ownerSetters) &&
      isKeyedLeafCollectionState(state, usage)) ||
    (!statesWithCompanionWrites.has(state) &&
      isImperativeRenderedCollectionState(state, usage, imports))
  );
}

function writesIndependentlyOfCompanions(
  state: StateCandidate,
  usage: StateUsage | undefined,
  statesWithCompanionWrites: ReadonlySet<StateCandidate>,
): boolean {
  return !statesWithCompanionWrites.has(state) || hasIndependentRepeatedEventWrite(state, usage);
}

export function isSelectionStateName(name: string): boolean {
  return /(?:selected|selection|added|checked)/iu.test(name);
}
