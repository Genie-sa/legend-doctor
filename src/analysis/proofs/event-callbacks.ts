import { EMPTY_NODES, EMPTY_RUNTIME_FUNCTIONS, MIN_REPEATED_SETTER_CALLS } from "../constants.js";
import type { OwnerEventCallbacks, SourceAnalysis } from "./contracts.js";
import type { StateCandidate, StateUsage } from "../model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { addCallbackWithNestedFunctions } from "../callbacks/local-callbacks.js";
import { directReactHookFormEventCallbacks } from "../../rules/async-leaf-status/react-hook-form-adapters.js";
import { groupStatesByOwner } from "../clusters/observable-clusters.js";
import { hasOnlyEventCommandReads } from "../../rules/state-proofs/state-proofs.js";
import { hasStateInitializer } from "../../rules/deferred-reveal/deferred-reveal.js";
import { sourceProvenDirectEventCallbacks } from "../callbacks/deferred-events.js";
import { sourceProvenOptionEventCallbacks } from "../callbacks/memoized-options.js";
import ts from "typescript";

export function collectOwnerEventCallbacks(analysis: SourceAnalysis): OwnerEventCallbacks {
  const { states } = analysis;
  const eventCallbacksByOwner = new Map<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>();
  const sourceEventCallbacksByOwner = new Map<
    RuntimeFunctionLike,
    ReadonlySet<RuntimeFunctionLike>
  >();
  for (const [owner, ownedStates] of groupStatesByOwner(states)) {
    eventCallbacksByOwner.set(
      owner,
      ownerEventCallbacks(owner, ownedStates, {
        analysis,
        sourceEventCallbacksByOwner,
      }),
    );
  }
  return { eventCallbacksByOwner, sourceEventCallbacksByOwner };
}

interface EventCallbackScope {
  readonly analysis: SourceAnalysis;
  readonly sourceEventCallbacksByOwner: Map<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>;
}

function ownerEventCallbacks(
  owner: RuntimeFunctionLike,
  ownedStates: readonly StateCandidate[],
  { analysis, sourceEventCallbacksByOwner }: EventCallbackScope,
): ReadonlySet<RuntimeFunctionLike> {
  const { reactCommit, usageByState } = analysis;
  const callbacks = new Set<RuntimeFunctionLike>(
    reactCommit.eventTransitionCallbacks.get(owner) ?? EMPTY_RUNTIME_FUNCTIONS,
  );
  if (ownedStates.some((state) => (usageByState.get(state)?.deferredReads ?? 0) > 0)) {
    addFormEventCallbacks(owner, callbacks);
  }
  const needsProof = ownedStates.some((state) =>
    stateNeedsDeferredCallbackProof(state, usageByState.get(state), callbacks),
  );
  if (needsProof) {
    addSourceProvenEventCallbacks(owner, callbacks, { analysis, sourceEventCallbacksByOwner });
    addOptionEventCallbacks(owner, callbacks, analysis);
  }
  return callbacks;
}

function addOptionEventCallbacks(
  owner: RuntimeFunctionLike,
  callbacks: Set<RuntimeFunctionLike>,
  { childContracts, imports }: SourceAnalysis,
): void {
  if (!childContracts) {
    return;
  }
  for (const callback of sourceProvenOptionEventCallbacks(owner, imports, childContracts)) {
    addCallbackWithNestedFunctions(callback, callbacks);
  }
}

function stateNeedsDeferredCallbackProof(
  state: StateCandidate,
  usage: StateUsage | undefined,
  callbacks: ReadonlySet<RuntimeFunctionLike>,
): boolean {
  if (!usage) {
    return false;
  }
  const unprovenDeferredRead =
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.deferredReads > 0 &&
    usage.transportedOccurrences === 0 &&
    (usage.eventReads > 0 || usage.effectWrites > 0) &&
    !hasOnlyEventCommandReads(state, EMPTY_NODES, callbacks);
  const renderedBooleanCommand =
    hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.setterCallNodes.length >= MIN_REPEATED_SETTER_CALLS &&
    (usage.localRenderReads > 0 || usage.valueTransportSites.size > 0);
  return unprovenDeferredRead || renderedBooleanCommand;
}

function addFormEventCallbacks(
  owner: RuntimeFunctionLike,
  callbacks: Set<RuntimeFunctionLike>,
): void {
  for (const callback of directReactHookFormEventCallbacks(owner)) {
    callbacks.add(callback);
  }
}

function addSourceProvenEventCallbacks(
  owner: RuntimeFunctionLike,
  callbacks: Set<RuntimeFunctionLike>,
  { analysis, sourceEventCallbacksByOwner }: EventCallbackScope,
): void {
  const { childContracts, imports } = analysis;
  addFormEventCallbacks(owner, callbacks);
  const sourceCallbacks = sourceProvenDirectEventCallbacks(owner, imports, childContracts);
  sourceEventCallbacksByOwner.set(owner, sourceCallbacks);
  for (const callback of sourceCallbacks) {
    callbacks.add(callback);
  }
}
