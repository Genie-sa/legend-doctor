import type { ClassifiedEffect, EffectCandidate } from "../../analysis/model.js";
import {
  browserStoragesWritten,
  isDependencyDrivenBrowserStorageEffect,
} from "../browser-storage-effect.js";
import {
  keepBrowserStorageEffect,
  keepBrowserStorageEffectPendingState,
  persistExistingObservableEffect,
} from "./effect-verdicts.js";
import type { BrowserStorage } from "../browser-storage-effect.js";
import type { EffectClassificationContext } from "./model.js";
import { analyzeEffectStateDependencies } from "./state-independent-effects.js";
import type ts from "typescript";

const PERSIST_PLUGIN_BY_STORAGE = {
  localStorage: "ObservablePersistLocalStorage",
  sessionStorage: "ObservablePersistSessionStorage",
} satisfies Record<BrowserStorage, string>;

/**
 * Every proven persistence effect call, dependency array included. A persist plugin takes over
 * the reads inside it, so state proofs evaluate the persisted state as if the effect were gone.
 */
export function persistenceSinkEffects(effects: readonly EffectCandidate[]): ReadonlySet<ts.Node> {
  return new Set(
    effects.flatMap((effect) =>
      isDependencyDrivenBrowserStorageEffect(effect) ? [effect.call] : [],
    ),
  );
}

/**
 * A persistence effect whose every dependency is an observable-sourced binding already has a
 * Legend replacement: the persist plugin subscribes to the observable itself.
 */
export function persistedObservableClassification(
  effect: EffectCandidate,
): ClassifiedEffect | null {
  if (!isDependencyDrivenBrowserStorageEffect(effect)) {
    return null;
  }
  return persistExistingObservableEffect(persistPlugins(effect));
}

/**
 * A persistence effect driven by React values stays in React. When it reaches local React state,
 * the classification carries that state so the final verdict can follow the state's migration.
 */
export function browserStorageClassification(
  effect: EffectCandidate,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: EffectClassificationContext,
): ClassifiedEffect | null {
  if (!isDependencyDrivenBrowserStorageEffect(effect)) {
    return null;
  }
  const { opaque, states } = analyzeEffectStateDependencies(effect, callback, context);
  return opaque || states.length === 0
    ? keepBrowserStorageEffect()
    : keepBrowserStorageEffectPendingState({ plugins: persistPlugins(effect), states });
}

function persistPlugins(effect: EffectCandidate): readonly string[] {
  return browserStoragesWritten(effect).map((storage) => PERSIST_PLUGIN_BY_STORAGE[storage]);
}
