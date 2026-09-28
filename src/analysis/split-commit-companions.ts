import type { SetterMutation, SplitCommitCompanion, StateCandidate, StateUsage } from "./model.js";
import { callbackIsEventRooted, isPlainFunction } from "../rules/state-proofs/event-roots.js";
import { collectSetterMutations, groupSettableStatesByOwner } from "./companion-writes.js";
import { executionOwner, executionUnit, functionEntryKey } from "../core/execution-units.js";
import type { ExecutionUnit } from "../core/execution-units.js";
import { PAIRED_CLUSTER_SIZE } from "./constants.js";
import type { ProgramReach } from "../project/source-components/write-units.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
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
  /** React commits the write with the rest of the host event that runs it, on every renderer. */
  readonly inHostEvent: boolean;
  /** The entry of the write's function when a suspension in that function precedes the write. */
  readonly resumedIn: string | null;
  /** A promise settlement starts the write's stretch: it follows a suspension or is a callback. */
  readonly settled: boolean;
  readonly stretches: ReadonlySet<string>;
}

/**
 * A converted state publishes through `useSyncExternalStore`, whose notification React commits on
 * the sync lane in a microtask; a setter called outside a React event waits for the default lane.
 * React 19 renders both lanes together when they are pending at that flush, so a companion misses
 * it only when a promise settlement resumes the companion's write in another function. React 18
 * renders the sync lane alone, so a companion written in the same stretch commits apart too. Every
 * renderer commits what a React host event runs before it suspends at once, as it did before.
 *
 * For each state, the rendered React states of its owner that the renderer may commit apart from it.
 */
export function findSplitCommitCompanions(
  analysis: SourceAnalysis,
): ReadonlyMap<StateCandidate, readonly SplitCommitCompanion[]> {
  const reach = programReach([fileReach(analysis.sourceFile, localReachResolver)]);
  return new Map(
    [...groupSettableStatesByOwner(analysis.states)]
      .filter(([, ownerStates]) => ownerStates.length >= PAIRED_CLUSTER_SIZE)
      .flatMap(([owner, ownerStates]) => {
        const render = functionEntryKey(owner);
        const writes = collectSetterMutations(owner, ownerStates).map((mutation) =>
          commandWrite(mutation, owner, (unit) =>
            reach.callingUnits(unit).filter(({ entry }) => entry !== render),
          ),
        );
        return ownerStates.map((state) => [state, companionsOf(state, writes, analysis)] as const);
      }),
  );
}

/** A promise callback runs in its own stretch, in the command that registered it. */
function commandWrite(
  { call, state }: SetterMutation,
  component: RuntimeFunctionLike,
  callingUnits: ProgramReach["callingUnits"],
): CommandWrite {
  const unit = executionUnit(call);
  const registration = promiseRegistration(call);
  const stretches = registration ? [unit] : callingUnits(unit);
  const callers = callingUnits(commandEntry(unit, registration));
  const settled = unit.resumed || registration !== null;
  const owner = executionOwner(call);
  return {
    callers: new Set(callers.map(({ key }) => key)),
    commands: new Set(callers.map(({ entry }) => entry)),
    functions: new Set(stretches.map(({ entry }) => entry)),
    inHostEvent:
      !settled &&
      isPlainFunction(owner) &&
      callbackIsEventRooted({
        callback: owner,
        dependencyName: "",
        owner: component,
        seen: new Set(),
      }),
    resumedIn: unit.resumed ? unit.entry : null,
    settled,
    state,
    stretches: new Set(stretches.map(({ key }) => key)),
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

/** A companion written in another stretch as well as the same one still commits apart. */
function companionsOf(
  state: StateCandidate,
  writes: readonly CommandWrite[],
  { syncLaneRendersAlone, usageByState }: SourceAnalysis,
): SplitCommitCompanion[] {
  const splits = new Map<StateCandidate, boolean>();
  for (const converted of writes.filter((write) => write.state === state && !write.inHostEvent)) {
    for (const companion of writes) {
      const sameStretch = intersects(converted.stretches, companion.stretches);
      if (
        companion.state !== state &&
        intersects(converted.commands, companion.commands) &&
        (sameStretch
          ? syncLaneRendersAlone
          : settlesApart(converted, companion, syncLaneRendersAlone)) &&
        isObservedByCommits(usageByState.get(companion.state))
      ) {
        splits.set(companion.state, sameStretch && (splits.get(companion.state) ?? true));
      }
    }
  }
  return [...splits].map(([companion, sameStretch]) => ({ sameStretch, state: companion }));
}

/**
 * Stretches of one function are separated by a suspension that may already let React commit
 * between them, and so is a write that runs before its command first suspends from any later one.
 * Only a settlement resumes another function's stretch without that chance. React 19 renders a
 * companion that the converted write's function awaited earlier together with the sync-lane flush.
 */
function settlesApart(
  converted: CommandWrite,
  companion: CommandWrite,
  syncLaneRendersAlone: boolean,
): boolean {
  return (
    converted.settled &&
    companion.settled &&
    !intersects(converted.functions, companion.functions) &&
    (syncLaneRendersAlone ||
      converted.resumedIn === null ||
      !companion.callers.has(converted.resumedIn))
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
