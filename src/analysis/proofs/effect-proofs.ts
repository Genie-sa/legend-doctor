import type {
  ClassifiedEffect,
  EffectCandidate,
  EffectStateScope,
  StateCandidate,
} from "../model.js";
import { EMPTY_BINDINGS, EMPTY_STATE_CANDIDATES, EMPTY_STATE_USAGES } from "../constants.js";
import type { EffectProofs, OwnershipProofs, SourceAnalysis } from "./contracts.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { classifyEffect } from "../../rules/effects/effects.js";
import { findLegendValueMirrors } from "../legend-value-mirrors.js";

export function collectEffectProofs(
  analysis: SourceAnalysis,
  ownership: OwnershipProofs,
): EffectProofs {
  const { effects, legendValueBridges, states, usageByState } = analysis;
  const { effectStateScopes } = ownership;
  const effectClassifications = new Map<EffectCandidate, ClassifiedEffect>();
  const derivedStates = new Set<StateCandidate>();
  for (const effect of effects) {
    const classification = classifyEffectFor(effect, analysis, effectStateScopes);
    effectClassifications.set(effect, classification);
    if (classification.derivedState) {
      derivedStates.add(classification.derivedState);
    }
  }
  return {
    derivedStates,
    effectClassifications,
    legendValueMirrors: findLegendValueMirrors(states, usageByState, legendValueBridges),
  };
}

function classifyEffectFor(
  effect: EffectCandidate,
  analysis: SourceAnalysis,
  effectStateScopes: ReadonlyMap<RuntimeFunctionLike, EffectStateScope>,
): ClassifiedEffect {
  const {
    childContracts,
    imports,
    legendState,
    moduleScopeBindings,
    nonProductionHarness,
    useObservableBindingsByOwner,
    useValueBindingsByOwner,
  } = analysis;
  const scope = effect.owner ? effectStateScopes.get(effect.owner) : undefined;
  return classifyEffect({
    effect,
    stateBySetter: scope?.bySetter ?? EMPTY_STATE_CANDIDATES,
    stateByValue: scope?.byValue ?? EMPTY_STATE_CANDIDATES,
    usageBySetter: scope?.usageBySetter ?? EMPTY_STATE_USAGES,
    useValueBindings: effect.owner
      ? (useValueBindingsByOwner.get(effect.owner) ?? EMPTY_BINDINGS)
      : EMPTY_BINDINGS,
    useObservableBindings: effect.owner
      ? (useObservableBindingsByOwner.get(effect.owner) ?? EMPTY_BINDINGS)
      : EMPTY_BINDINGS,
    imports,
    legendState,
    useRefBindings: imports.useRef,
    reactNamespaces: imports.reactNamespaces,
    moduleScopeBindings,
    nonProductionHarness,
    childContracts,
  });
}
