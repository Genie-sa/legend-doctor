import type { SetterMutation, StateCandidate, StateUsage } from "./model.js";
import { collectSetterMutations, groupSettableStatesByOwner } from "./companion-writes.js";
import { executionOwner, executionUnit, functionEntryKey } from "../core/execution-units.js";
import type { ExecutionUnit } from "../core/execution-units.js";
import { PAIRED_CLUSTER_SIZE } from "./constants.js";
import type { ProgramReach } from "../project/source-components/write-units.js";
import type { SourceAnalysis } from "./proofs/contracts.js";
import { fileReach } from "../project/source-components/synchronous-reach.js";
import { localReachResolver } from "../project/source-components/reach-resolvers.js";
import { programReach } from "../project/source-components/write-units.js";
import ts from "typescript";

const PROMISE_CALLBACK_METHODS: ReadonlySet<string> = new Set(["catch", "finally", "then"]);

interface CommandWrite {
  readonly state: StateCandidate;
  /** Keys of the stretches that run the write's command synchronously. */
  readonly callers: ReadonlySet<string>;
  /** Entries of the functions that run the write's function synchronously: one command. */
  readonly commands: ReadonlySet<string>;
  /** Entries of the functions whose stretches run the write. */
  readonly functions: ReadonlySet<string>;
  /** The entry of the write's function when a suspension in that function precedes the write. */
  readonly resumedIn: string | null;
  /** A promise settlement starts the write's stretch: it follows a suspension or is a callback. */
  readonly settled: boolean;
}

/**
 * A converted state publishes through `useSyncExternalStore`, whose notification React commits on
 * the sync lane in a microtask; a setter called outside a React event waits for the default lane.
 * React renders both lanes together when they are pending at that flush, so a companion misses it
 * only when a promise settlement resumes the companion's write in another function.
 *
 * For each state, the rendered React states of its owner that the renderer may commit apart from it.
 */
export function findSplitCommitCompanions(
  analysis: SourceAnalysis,
): ReadonlyMap<StateCandidate, readonly StateCandidate[]> {
  const reach = programReach([fileReach(analysis.sourceFile, localReachResolver)]);
  return new Map(
    [...groupSettableStatesByOwner(analysis.states)]
      .filter(([, ownerStates]) => ownerStates.length >= PAIRED_CLUSTER_SIZE)
      .flatMap(([owner, ownerStates]) => {
        const render = functionEntryKey(owner);
        const writes = collectSetterMutations(owner, ownerStates).map((mutation) =>
          commandWrite(mutation, (unit) =>
            reach.callingUnits(unit).filter(({ entry }) => entry !== render),
          ),
        );
        return ownerStates.map(
          (state) => [state, companionsOf(state, writes, analysis.usageByState)] as const,
        );
      }),
  );
}

/** A promise callback runs in its own stretch, in the command that registered it. */
function commandWrite(
  { call, state }: SetterMutation,
  callingUnits: ProgramReach["callingUnits"],
): CommandWrite {
  const unit = executionUnit(call);
  const registration = promiseRegistration(call);
  const stretches = registration ? [unit] : callingUnits(unit);
  const callers = callingUnits(commandEntry(unit, registration));
  return {
    callers: new Set(callers.map(({ key }) => key)),
    commands: new Set(callers.map(({ entry }) => entry)),
    functions: new Set(stretches.map(({ entry }) => entry)),
    resumedIn: unit.resumed ? unit.entry : null,
    settled: unit.resumed || registration !== null,
    state,
  };
}

function commandEntry(unit: ExecutionUnit, registration: ts.CallExpression | null): ExecutionUnit {
  let command = unit;
  for (let current = registration; current; current = promiseRegistration(current)) {
    command = executionUnit(current);
  }
  return { ...command, key: command.entry, resumed: false };
}

function promiseRegistration(node: ts.Node): ts.CallExpression | null {
  const owner = executionOwner(node);
  const call = owner.parent;
  return call &&
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    PROMISE_CALLBACK_METHODS.has(call.expression.name.text) &&
    call.arguments.some((argument) => argument === owner)
    ? call
    : null;
}

function companionsOf(
  state: StateCandidate,
  writes: readonly CommandWrite[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
): StateCandidate[] {
  const converted = writes.filter((write) => write.state === state);
  return [
    ...new Set(
      writes
        .filter(
          (companion) =>
            companion.state !== state &&
            converted.some((write) => settlesApart(write, companion)) &&
            isObservedByCommits(usageByState.get(companion.state)),
        )
        .map((companion) => companion.state),
    ),
  ];
}

/**
 * Stretches of one function are separated by a suspension that may already let React commit
 * between them, and so is a write that runs before its command first suspends from any later one.
 * Only a settlement resumes another function's stretch without that chance. React renders a
 * companion that the converted write's function awaited earlier together with the sync-lane flush.
 */
function settlesApart(converted: CommandWrite, companion: CommandWrite): boolean {
  return (
    converted.settled &&
    companion.settled &&
    intersects(converted.commands, companion.commands) &&
    !intersects(converted.functions, companion.functions) &&
    (converted.resumedIn === null || !companion.callers.has(converted.resumedIn))
  );
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].some((key) => right.has(key));
}

/** A companion whose value never reaches a render, an effect, or unknown code shows no torn commit. */
function isObservedByCommits(usage: StateUsage | undefined): boolean {
  return (
    usage === undefined ||
    usage.escaped ||
    usage.localRenderReads > 0 ||
    usage.valueTargets.size > 0 ||
    usage.effectReads > 0
  );
}
