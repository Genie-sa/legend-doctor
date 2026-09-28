import type { ClassifiedState, StateCandidate } from "./model.js";
import {
  hasTrivialRenderRemainder,
  minimalLeafRoots,
  movedStateLeafRoot,
} from "./subtree/render-cut-remainder.js";
import type { FindingsScope } from "./finding-clusters.js";
import type { StateClassificationInputs } from "./verdicts/classification-context.js";
import { isCustomHookOwner } from "./ast-helpers.js";
import { stateClusterFor } from "./finding-clusters.js";
import type ts from "typescript";

/**
 * A leaf cut is worth its machinery only when the owner render it skips does material work. When
 * every element the owner keeps rendering is a host element or a hook-free host-only component,
 * fewer than a compact owner's worth, and the owner calls no custom hook or unproven function, the
 * cut removes only that trivial remainder. Repeated rows and context values are exempt, and a
 * cluster moves together only when every member's remainder is trivial.
 */
export function stateHasTrivialRenderRemainder(
  classification: ClassifiedState,
  inputs: StateClassificationInputs,
  result: FindingsScope,
): boolean {
  const { state } = inputs;
  if (
    (classification.action !== "use-observable" && classification.action !== "move-state-down") ||
    isCustomHookOwner(state.owner) ||
    inputs.subtree?.repeated === true ||
    inputs.isKeyedLeafCollection ||
    inputs.isKeyedLeafRecord ||
    inputs.isKeyedLeafScalar ||
    inputs.isKeyedScalarWithSecondary ||
    result.clusters.contextClusters.has(state)
  ) {
    return false;
  }
  const members = stateClusterFor(state, result)?.members ?? [state];
  return members.every((member) => {
    const leafRoots = stateLeafRoots(member, classification, result);
    return (
      leafRoots !== null &&
      hasTrivialRenderRemainder({
        childContracts: inputs.childContracts,
        imports: result.analysis.imports,
        leafRoots,
        owner: member.owner,
        pureProjectionImports: inputs.pureProjectionImports,
      })
    );
  });
}

function stateLeafRoots(
  state: StateCandidate,
  { action }: ClassifiedState,
  { analysis }: FindingsScope,
): readonly ts.Node[] | null {
  const usage = analysis.usageByState.get(state);
  const readRoots = usage ? minimalLeafRoots(state, usage, analysis.imports) : null;
  if (!usage || !readRoots) {
    return null;
  }
  if (action === "use-observable") {
    return readRoots.length > 0 ? readRoots : null;
  }
  const moved = movedStateLeafRoot(state, usage, readRoots);
  return moved ? [moved] : null;
}

export function trivialRenderRemainderClassification(state: StateCandidate): ClassifiedState {
  return {
    action: "keep-state",
    confidence: "probable",
    message: `Keep \`${state.valueName}\` as React state; outside the leaf that would read it, its owner renders only a few host elements and calls no custom hook or unproven function, so a leaf cut cannot remove material render work.`,
  };
}
