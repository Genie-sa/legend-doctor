import type {
  AsyncLeafCallSites,
  AsyncLeafStatus,
  AsyncLeafStatusInputs,
  PendingCommand,
} from "./model.js";
import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { asyncLeafCallSites } from "./leaf-call-sites.js";
import { hasIndependentRenderCutWitness } from "../state-proofs/render-cut-witness.js";
import { hasStateInitializer } from "../deferred-reveal/deferred-reveal.js";
import { isEventRootedCommand } from "./event-rooted-commands.js";
import { isProvenPendingSegment } from "./pending-segment.js";
import { jsxElementCount } from "../state-proofs/jsx-subtrees.js";
import { pendingCommand } from "./pending-command.js";
import ts from "typescript";

export interface AsyncLeafStatusAnalysis {
  cohesive: ReadonlySet<StateCandidate>;
  isolated: ReadonlySet<StateCandidate>;
  unproven: ReadonlySet<StateCandidate>;
}

interface LeafStatusProof {
  command: PendingCommand;
  inputs: AsyncLeafStatusInputs;
  leaves: AsyncLeafCallSites;
  state: StateCandidate;
}

const MIN_SETTER_CALLS = 2;

const DENSE_JSX_ELEMENT_COUNT = 12;

export function findAsyncLeafStatuses(inputs: AsyncLeafStatusInputs): AsyncLeafStatusAnalysis {
  const { states } = inputs;
  const buckets = {
    cohesive: new Set<StateCandidate>(),
    isolated: new Set<StateCandidate>(),
    unproven: new Set<StateCandidate>(),
  };
  for (const state of states) {
    const status = asyncLeafStatus(state, inputs);
    if (status) {
      buckets[status].add(state);
    }
  }
  return buckets;
}

function asyncLeafStatus(
  state: StateCandidate,
  inputs: AsyncLeafStatusInputs,
): AsyncLeafStatus | null {
  const usage = inputs.usageByState.get(state);
  if (!usage || !isAsyncCommandFlagUsage(state, usage, inputs)) {
    return null;
  }
  const leaves = asyncLeafCallSites(usage, state.owner);
  if (!leaves) {
    return null;
  }
  const command = pendingCommand(state, usage, inputs.states);
  if (!command || !isProvenPendingSegment({ command, leaves, owner: state.owner, usage })) {
    return null;
  }
  return leafStatusFor({ command, inputs, leaves, state });
}

function isAsyncCommandFlagUsage(
  state: StateCandidate,
  usage: StateUsage,
  inputs: AsyncLeafStatusInputs,
): boolean {
  return (
    Boolean(state.setterName) &&
    hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) &&
    inputs.safeCommandStates.has(state) &&
    !inputs.reactiveMutationAffectedStates.has(state) &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    !usage.repeatedValueTransport &&
    usage.setterCallNodes.length >= MIN_SETTER_CALLS &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped &&
    usage.setterCallNodes.every((call) => isBooleanLiteralSetterCall(call))
  );
}

function isBooleanLiteralSetterCall(call: ts.CallExpression): boolean {
  return (
    call.arguments.length === 1 &&
    (call.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword ||
      call.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword)
  );
}

function leafStatusFor(proof: LeafStatusProof): AsyncLeafStatus | null {
  const { command, inputs, leaves, state } = proof;
  if (!hasRenderCut(leaves, state.owner, inputs)) {
    return leaves.boundaries.length === 1 ? "cohesive" : null;
  }
  return isEventRootedCommand(command, state.owner, inputs) ? "isolated" : "unproven";
}

function hasRenderCut(
  leaves: AsyncLeafCallSites,
  owner: RuntimeFunctionLike,
  inputs: AsyncLeafStatusInputs,
): boolean {
  return (
    jsxElementCount(owner) >= DENSE_JSX_ELEMENT_COUNT ||
    hasIndependentRenderCutWitness({
      returned: leaves.returned,
      excluded: leaves.boundaries,
      localComponents: inputs.localComponents,
      sourceComponents: inputs.sourceComponents,
    })
  );
}
