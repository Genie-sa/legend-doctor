import type { ClassifiedEffect, EffectCandidate } from "../../analysis/model.js";
import type { DisabledRule, InstalledLegendState } from "../../core/types.js";
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

type EffectRuleGate = Omit<DisabledRule, "files">;

const PERSIST_PLUGIN_BY_STORAGE = {
  localStorage: "ObservablePersistLocalStorage",
  sessionStorage: "ObservablePersistSessionStorage",
} satisfies Record<BrowserStorage, string>;

const SYNC_EXPORT_MISSING_GATE: EffectRuleGate = {
  detail:
    "the installed @legendapp/state package does not export the sync entry point that carries synced and syncObservable",
  reason: "sync-export-missing",
  rule: "browser-storage-persistence",
};

/** Effect rules the installed toolchain switches off; each falls back to its React-preserving verdict. */
export function disabledEffectRules(
  legendState: InstalledLegendState | null,
): readonly EffectRuleGate[] {
  return legendState?.syncExport === "missing" ? [SYNC_EXPORT_MISSING_GATE] : [];
}

/**
 * Every proven persistence effect call, dependency array included. A persist plugin takes over
 * the reads inside it, so state proofs evaluate the persisted state as if the effect were gone.
 */
export function persistenceSinkEffects(
  effects: readonly EffectCandidate[],
  legendState: InstalledLegendState | null,
): ReadonlySet<ts.Node> {
  if (disabledEffectRules(legendState).length > 0) {
    return new Set();
  }
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
  context: EffectClassificationContext,
): ClassifiedEffect | null {
  if (!isDependencyDrivenBrowserStorageEffect(effect)) {
    return null;
  }
  return disabledEffectRules(context.legendState).length > 0
    ? keepBrowserStorageEffect()
    : persistExistingObservableEffect(persistPlugins(effect));
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
  if (disabledEffectRules(context.legendState).length > 0) {
    return keepBrowserStorageEffect();
  }
  const { opaque, states } = analyzeEffectStateDependencies(effect, callback, context);
  return opaque || states.length === 0
    ? keepBrowserStorageEffect()
    : keepBrowserStorageEffectPendingState({ plugins: persistPlugins(effect), states });
}

function persistPlugins(effect: EffectCandidate): readonly string[] {
  return browserStoragesWritten(effect).map((storage) => PERSIST_PLUGIN_BY_STORAGE[storage]);
}
