import { directUniqueReturnCallSite, uniqueReturnedExpression } from "../return-call-sites.js";
import { mutationsAreProvenCoexecuting, nearestMutationFunction } from "../mutations.js";
import type { EffectDraftProofs } from "../../rules/effect-drafts/model.js";
import type { LazyCallbackLeafProofs } from "../../rules/lazy-callback-leaf.js";
import type { StateFlowIndex } from "../../project/state-flow/state-flow.js";
import { hasIndependentRenderCutWitness } from "../../rules/state-proofs/render-cut-witness.js";
import { hasUnstableSubtreeLifetime } from "../../rules/state-proofs/jsx-subtrees.js";
import { isCustomHookOwner } from "../ast-helpers.js";

export const LAZY_CALLBACK_LEAF_PROOFS: LazyCallbackLeafProofs = {
  hasUnstableSubtreeLifetime,
  uniqueReturnedExpression,
};

export function effectDraftProofs(stateFlow: StateFlowIndex): EffectDraftProofs {
  return {
    directUniqueReturnCallSite,
    hasIndependentRenderCutWitness,
    isCustomHookOwner,
    nearestMutationFunction,
    setterMutationsCanCooccur: (left, right, region) =>
      mutationsAreProvenCoexecuting(left, right, { region, stateFlow }),
    uniqueReturnedExpression,
  };
}
