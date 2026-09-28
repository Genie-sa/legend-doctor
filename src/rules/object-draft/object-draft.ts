import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import { hasIndependentSinkWitness, independentDraftSinks } from "./independent-sinks.js";
import { hasOnlyEventCommandReads, stateMayHoldCallable } from "../state-proofs/state-proofs.js";
import type { ChildContractResolver } from "../child-contract/model.js";
import type { PropertyWrite } from "./property-writes.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { exactPropertyWrite } from "./property-writes.js";
import { jsxElementCount } from "../state-proofs/jsx-subtrees.js";
import { stateValueReferences } from "../../analysis/ast-helpers.js";
import ts from "typescript";
import { typedStringDraftProperties } from "./typed-draft-seed.js";

export interface ObjectDraftProofs {
  childContracts: ChildContractResolver | null;
  eventCallbacks: ReadonlySet<RuntimeFunctionLike>;
  hasCompanionWrites: boolean;
  hasReactiveMutationPath: boolean;
  hasSafeCommands: boolean;
  localComponents: ReadonlySet<string>;
  sourceComponents: ReadonlySet<string>;
}

const MINIMUM_OWNER_JSX_ELEMENTS = 12;

const MINIMUM_DRAFT_SETTER_CALLS = 2;

/** Proves a typed string draft whose controlled fields can subscribe independently. */
export function isPropertyLocalObjectDraftState(
  state: StateCandidate,
  usage: StateUsage,
  proofs: ObjectDraftProofs,
): boolean {
  if (!usageAdmitsPropertyLocalDraft(state, usage, proofs)) {
    return false;
  }
  const properties = typedStringDraftProperties(state);
  if (!properties || usage.setterCalls !== properties.size) {
    return false;
  }
  const writes = usage.setterCallNodes.map((call) =>
    exactPropertyWrite(call, state, proofs.childContracts),
  );
  if (
    !writesCoverProperties(writes, properties) ||
    !readsAreDirectPropertyAccesses(state, properties) ||
    !hasOnlyEventCommandReads(state, new Set(usage.directRenderNodes), proofs.eventCallbacks)
  ) {
    return false;
  }
  return hasIndependentSinkWitness(
    proofs,
    independentDraftSinks(state, usage.directRenderNodes, properties),
    state.owner,
  );
}

function usageAdmitsPropertyLocalDraft(
  state: StateCandidate,
  usage: StateUsage,
  proofs: ObjectDraftProofs,
): boolean {
  if (
    !state.setterName ||
    !state.owner.body ||
    jsxElementCount(state.owner) < MINIMUM_OWNER_JSX_ELEMENTS ||
    usage.localRenderReads === 0 ||
    usage.localRenderReads !== usage.directRenderNodes.length ||
    usage.deferredReads === 0 ||
    usage.effectReads !== 0 ||
    usage.effectWrites !== 0 ||
    usage.transportedOccurrences !== 0 ||
    usage.setterCalls < MINIMUM_DRAFT_SETTER_CALLS ||
    usage.setterReferences !== usage.setterCalls ||
    usage.shadowed ||
    usage.escaped ||
    proofs.hasCompanionWrites ||
    proofs.hasReactiveMutationPath ||
    !proofs.hasSafeCommands ||
    stateMayHoldCallable(state)
  ) {
    return false;
  }
  return true;
}

function writesCoverProperties(
  writes: readonly (PropertyWrite | null)[],
  properties: ReadonlySet<string>,
): boolean {
  return !(
    writes.some((write) => write === null) ||
    new Set(writes.map((write) => write?.property)).size !== properties.size ||
    writes.some((write) => !write || !properties.has(write.property))
  );
}

function readsAreDirectPropertyAccesses(
  state: StateCandidate,
  properties: ReadonlySet<string>,
): boolean {
  const references = stateValueReferences(state);
  return (
    references.length > 0 &&
    !references.some((reference) => {
      const access = directPropertyAccess(reference);
      return !access || !properties.has(access.name.text);
    })
  );
}

function directPropertyAccess(node: ts.Identifier): ts.PropertyAccessExpression | null {
  return ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
    ? node.parent
    : null;
}
