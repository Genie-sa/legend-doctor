import type {
  BrowserStoragePersistence,
  ClassifiedEffect,
  StateCandidate,
} from "../../analysis/model.js";

export function harnessEffect(): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "certain",
    derivedState: null,
    message:
      "Keep this effect in its test, story, or demo harness; production lifecycle migrations do not apply here.",
  };
}

export function ownershipDirectiveEffect(): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "certain",
    derivedState: null,
    message:
      "Keep this React effect; its adjacent ownership directive explicitly preserves React lifecycle semantics.",
  };
}

export function unresolvedCallbackEffect(): ClassifiedEffect {
  return {
    action: "review-effect",
    abstentionReason: "effect-callback-unresolved",
    confidence: "probable",
    derivedState: null,
    message:
      "Review this effect; its callback is not defined inline, so execution and cleanup ownership are unresolved.",
  };
}

export function unmountEffect(): ClassifiedEffect {
  return {
    action: "use-unmount",
    confidence: "probable",
    derivedState: null,
    message:
      "Replace this teardown-only empty-dependency effect with `useUnmount` if once-only Legend lifecycle semantics are intended.",
  };
}

export function useMountEffect(): ClassifiedEffect {
  return {
    action: "use-mount",
    confidence: "probable",
    derivedState: null,
    message:
      "Replace this module-global, setup-only effect with `useMount` if suppressing React Strict Mode's development replay is intended.",
  };
}

export function reviewEmptyDependencySetupEffect(): ClassifiedEffect {
  return {
    action: "review-effect",
    abstentionReason: "lifecycle-equivalence-unproven",
    confidence: "probable",
    derivedState: null,
    message:
      "Review this empty-dependency setup before choosing `useMount`; suppressing React Strict Mode's development replay changes lifecycle semantics.",
  };
}

export function keepPairedMountEffect(): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "certain",
    derivedState: null,
    message: "Keep this React effect; it owns paired mount setup and cleanup semantics.",
  };
}

export interface PeekedRead {
  readonly peek: string;
  readonly read: string;
}

function peekInstruction(peekedReads: readonly PeekedRead[]): string {
  if (peekedReads.length === 0) {
    return "";
  }
  const replacements = peekedReads.map(({ peek, read }) => `\`${read}\` with \`${peek}\``);
  const [reads, them] = peekedReads.length === 1 ? ["that read", "it"] : ["those reads", "them"];
  return ` Replace ${replacements.join(", ")}: the effect does not depend on ${reads}, and a tracked \`.get()\` would rerun the reaction on every change to ${them}.`;
}

export function observeEffect(
  peekedReads: readonly PeekedRead[],
  subscriptionHook: string,
): ClassifiedEffect {
  const peeks = peekInstruction(peekedReads);
  return {
    action: "use-observe-effect",
    confidence: "probable",
    derivedState: null,
    message: `Rewrite this post-mount reaction with \`useObserveEffect\`, reading its observable sources directly; dependencies are \`${subscriptionHook}\` snapshots or stable \`useObservable\` handles.${peeks}`,
  };
}

export function reviewUntrackableReadsEffect(): ClassifiedEffect {
  return {
    action: "review-effect",
    abstentionReason: "callback-timing-unresolved",
    confidence: "probable",
    derivedState: null,
    message:
      "Review this effect before choosing `useObserveEffect`; every observable `.get()` its body runs synchronously would become a trigger, and a read here sits in a callback of unknown timing, calls a subscription hook, or reads a receiver not proven observable. Settle whether each read runs during the observer's pass and peek the ones the effect does not depend on.",
  };
}

export function keepRenderedReactionEffect(subscriptionHook: string): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "probable",
    derivedState: null,
    message: `Keep this React effect; its \`${subscriptionHook}\` dependencies also render this owner, so an observable reaction would keep the subscription and only move the side effect ahead of commit.`,
  };
}

export function keepParentRenderedReactionEffect(subscriptionHook: string): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "probable",
    derivedState: null,
    message: `Keep this React effect; every component that renders this owner subscribes to its \`${subscriptionHook}\` dependencies too and rerenders it on each change, so an observable reaction would remove no render.`,
  };
}

export function reviewParentRenderedReactionEffect(subscriptionHook: string): ClassifiedEffect {
  return {
    action: "review-effect",
    abstentionReason: "render-cut-unproven",
    confidence: "probable",
    derivedState: null,
    message: `Review this effect before choosing \`useObserveEffect\`; a component that renders this owner also subscribes to its \`${subscriptionHook}\` dependencies, so dropping them may not remove the owner's render. Prove that every parent render site is memoized with stable props or reads none of these observables.`,
  };
}

export function keepBrowserStorageEffect(): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "probable",
    derivedState: null,
    message:
      "Keep this React effect; it persists React dependencies to browser storage after commit.",
  };
}

const PERSIST_MODULES =
  "`@legendapp/state/sync` and `@legendapp/state/persist-plugins/local-storage`";

export function keepBrowserStorageEffectPendingState(
  persistence: BrowserStoragePersistence,
): ClassifiedEffect {
  const names = quotedNames(persistence.states.map((state) => state.valueName));
  return {
    action: "keep-effect",
    confidence: "probable",
    derivedState: null,
    message: `Keep this React effect while ${names} stays React state; it persists that state to browser storage after commit. If the state migrates to an observable, replace this effect with \`synced({ persist: { name, plugin: ${pluginList(persistence.plugins)} } })\` from ${PERSIST_MODULES} rather than a hand-written write.`,
    persistence,
  };
}

export function persistExistingObservableEffect(plugins: readonly string[]): ClassifiedEffect {
  return {
    action: "persist-observable",
    confidence: "probable",
    derivedState: null,
    message: `Replace this persistence effect with Legend persistence: call \`syncObservable(source$, { persist: { name, plugin: ${pluginList(plugins)} } })\` once beside a module observable, or create a component observable with \`useObservable(synced({ initial, persist }))\`, both from ${PERSIST_MODULES}. Verify the storage key, the serialized shape, and any effect that hydrates the same key before changing readers.`,
  };
}

export function persistMigratedStateEffect(
  persistence: BrowserStoragePersistence,
): ClassifiedEffect {
  const names = quotedNames(persistence.states.map((state) => state.valueName));
  return {
    action: "persist-observable",
    confidence: "probable",
    derivedState: null,
    message: `When applying the state finding for ${names}, create the observable with \`synced({ initial, persist: { name, plugin: ${pluginList(persistence.plugins)} } })\` from ${PERSIST_MODULES}, then delete this persistence effect together with any mount effect that hydrates the same key. Verify the storage key and the serialized shape before changing readers.`,
  };
}

export function keepExternalIntegrationEffect(): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "probable",
    derivedState: null,
    message:
      "Keep this React effect; external integration follows React dependencies and is not an observable reaction.",
  };
}

export function keepLifecycleEffect(): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "certain",
    derivedState: null,
    message: "Keep this React effect; it owns an explicit setup and cleanup lifecycle.",
  };
}

export function reviewCausalOwnerEffect(): ClassifiedEffect {
  return {
    action: "review-effect",
    abstentionReason: "effect-causal-owner-unresolved",
    confidence: "probable",
    derivedState: null,
    message:
      "Review this effect's causal owner before choosing React lifecycle, an event handler, or an observable reaction.",
  };
}

export function committedRefEffect(): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "certain",
    derivedState: null,
    message:
      "Keep this React effect; it operates on a committed ref and depends on React post-commit ordering.",
  };
}

export function keepStateIndependentEffect(): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "certain",
    derivedState: null,
    message:
      "Keep this React effect; it reads only props, refs, module bindings, and external hook results, so no state migration inside this owner changes its inputs.",
  };
}

export function reviewStateReactionEffect(
  valueName: string,
  stateDependencies: readonly StateCandidate[],
): ClassifiedEffect {
  return {
    action: "review-effect",
    abstentionReason: "effect-causal-owner-unresolved",
    confidence: "probable",
    derivedState: null,
    message: `Review this effect's causal owner; it reacts to React state \`${valueName}\`, so the mutation site of that state or an observable reaction may own it once the state migrates.`,
    stateDependencies,
  };
}

export function reviewStateWritingEffect(
  valueName: string,
  stateDependencies: readonly StateCandidate[],
): ClassifiedEffect {
  return {
    action: "review-effect",
    abstentionReason: "effect-write-ownership-unresolved",
    confidence: "probable",
    derivedState: null,
    message: `Review this effect; it writes React state \`${valueName}\` after commit, so its ownership must be settled together with that state's migration.`,
    stateDependencies,
  };
}

export function keepStateSnapshotEffect(bindingName: string): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "probable",
    derivedState: null,
    message: `Keep this React effect; props and external values alone schedule it, and its read of \`${bindingName}\` is a snapshot that migrates with that state (read it with \`.peek()\` inside the effect) rather than a reactive source.`,
  };
}

export function keepEffectForKeptState(
  names: readonly string[],
  confidence: "certain" | "probable",
): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence,
    derivedState: null,
    message: `Keep this React effect; the React state it touches (${quotedNames(names)}) stays React state in this owner, so no Legend effect action applies.`,
  };
}

export function keepEffectForMigratedState(names: readonly string[]): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "probable",
    derivedState: null,
    message: `Keep this React effect and its dependencies; when applying the state finding for ${quotedNames(names)}, rewrite the setter calls this effect reaches, directly or through the owner functions it calls, to the observable or ref write it prescribes and snapshot any read with \`.peek()\`.`,
  };
}

function pluginList(plugins: readonly string[]): string {
  return plugins.join(" | ");
}

function quotedNames(names: readonly string[]): string {
  return names.map((name) => `\`${name}\``).join(", ");
}
