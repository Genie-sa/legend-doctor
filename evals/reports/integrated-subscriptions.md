# Integrated subscription analysis

Validated against the pinned corpus on 2026-09-08. This implements the five priorities in
[the optimization roadmap](optimization-roadmap.md), with bounded structural proofs.

## Delivered

1. Shared subscription flow follows closed const aliases, defaults, and supported memo projections to
   terminal consumers. Event/effect consumers, unknown calls, incomplete memo dependencies, and escaping
   mutation block relocation. Typed factory metadata follows a direct `Observable<T>` return; a transformed
   generic return does not establish the same primitive paths.
2. Owner plans combine individual actions, merge overlapping JSX boundaries, list complete derivation
   chains and parent inputs, and preserve module-level child identity, observable ownership, and batches.
3. Lifecycle checks accept independently stable primitive dependencies while retaining callback-ref,
   imperative snapshot, unresolved dependency, and every-commit blockers. Unrelated memos with missing
   or unproven dependencies also block a cut; only proven closed memo derivations count as tracked reads.
4. Ranking separates static JSX counts from supplied runtime evidence. Source-owner fingerprints reject
   stale evidence; invalid and duplicate entries are reported. Evidence never bypasses a detector proof.
5. Version 1 subscription inventory reports planned, other-action, and unresolved calls, with read kinds
   and explicit reasons. CLI filtering also removes plans for hidden actions.

The pinned targets inventory 148 recognized subscriptions: 10 belong to 5 coordinated owner plans, 18
have other actions, and 120 remain unresolved. This denominator is not a promise that every unresolved
subscription needs optimization. Custom hooks and unrecognized imports are outside this inventory.

## Source and documentation cross-validation

- [Legend React API](https://legendapp.com/open-source/state/v3/react/react-api/) establishes that
  subscriptions belong to their consuming React context and that `useObserve` has different timing from
  React effects. The implementation moves supported reads into stable children and preserves existing
  effect timing; it does not replace effects with render-time observers.
- [Tagged useSelector implementation](https://github.com/LegendApp/legend-state/blob/v3.0.0-beta.48/src/react/useSelector.ts)
  and installed `@legendapp/state/react.mjs` verify subscription disposal, external-store updates,
  observer contexts, and selector comparison. The installed beta.48 exports `useSelector` as `useValue`.
  Nested object writes may notify while preserving object identity: runtime tests explicitly preserve the
  existing `[track]` memo cache, then verify recomputation on whole-object replacement.
- [Tagged useObservable implementation](https://github.com/LegendApp/legend-state/blob/v3.0.0-beta.48/src/react/useObservable.ts)
  keeps the created observable in a component-owned ref. Plans retain that creation site and pass its
  handle to children.
- [React useMemo](https://react.dev/reference/react/useMemo) and
  [React useEffect](https://react.dev/reference/react/useEffect) support preserving memo dependencies,
  primitive dependency comparisons, and setup/cleanup timing. Normal and StrictMode fixtures exercise
  both the baseline and migrated component structures, including observer-wrapped owners.

## Subscription phase validation (before branch integration)

- Typecheck, build, lint, formatting, and diff whitespace checks pass. The post-validation Legend Doctor
  self-scan reports zero actionable findings. Package dry-run passes.
- Full suite: **855 tests pass**, including adversarial generic factories, closed memo dependencies,
  overlapping cuts, filtered plans, stale/invalid measurements, positive/regressive ranking, and runtime
  identity/lifecycle comparisons.
- Full pinned corpus: **237 targets**, **1,236 hooks**, **74/75 Legend practice labels**, no unexpected
  recommendations. One Hoalu opportunity remains explicit and non-enforced because independent memo
  dependencies do not yet have a structural stability proof. Both previously non-enforced Legend Music visualizer labels are now enforced.
- Existing hook results remain **507/523 labels**, with **16 known misses**; this phase does not weaken them.
- Runtime tests use the real installed Legend State **3.0.0-beta.48** and React **19.2.8** in jsdom. They
  demonstrate behavior and render isolation for representative migrations, not measured speedups in the
  pinned applications. Pinned application validation is source analysis.

## Action deltas from the preceding phase

All hook action deltas are zero. Legend practice action deltas:

| Pinned application      | Delta                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| Legend Music            | `move-use-value-down` +2                                         |
| Excalidraw              | 0                                                                |
| Expensify               | 0                                                                |
| Formbricks              | 0                                                                |
| Outline                 | 0                                                                |
| Open WebUI React Native | 0                                                                |
| Hoalu                   | `move-use-value-down` −1 (now a known, non-enforced opportunity) |

## Boundaries

General selector relocation, repeated render callbacks, ambiguous bindings, unsupported coercions,
unstable effect dependencies, and unproven owner work remain unresolved. Static JSX counts cannot predict
interaction frequency or render duration. Supplied measurement equivalence is a caller assertion, and
fingerprints cover the owner source rather than its transitive module graph. Reprofile when dependencies
or runtime configuration change. See [REPORT.md](../../REPORT.md#coordinated-subscriptions-version-1)
for the measurement format and operational details.

## Pre-push source audit

Rechecked the tagged Legend implementations above against the installed package and React 19.2.8's
[hook implementation](https://github.com/facebook/react/blob/v19.2.8/packages/react-reconciler/src/ReactFiberHooks.js)
and [child reconciliation](https://github.com/facebook/react/blob/v19.2.8/packages/react-reconciler/src/ReactChildFiber.js).
Dependency comparisons, memo caching, subscription disposal, and component type/key identity support the
existing migration constraints. The installed runtime fixtures exercise both observer and ordinary owners.

The report audit reproduced one additional defect: filtering away a subscription kept the complete owner's
runtime measurement attached to the remaining partial plan. Evidence now survives filtering only when the
complete edit still matches. The regression checks partial, empty, and unchanged plans; it failed before the
fix. This changes reporting only, with zero additional action deltas in all seven corpus applications.

The requested destination branch also contains Base UI and workspace-resolution work. Its installed
Base UI 1.7.0 `mergeProps`, `useRender`, and `useRenderElement` implementations were checked against
[mergeProps documentation](https://base-ui.com/react/utils/merge-props) and
[useRender documentation](https://base-ui.com/react/utils/use-render): props getters and render callbacks
execute during rendering, while merged event handlers retain their event semantics. The installed
`@manypkg/get-packages` 3.1.0 source and [package documentation](https://github.com/Thinkmill/manypkg/tree/main/packages/get-packages)
confirm workspace discovery and missing-name validation. These existing branch changes are preserved.

| Reporting risk                           | Protected behavior                                      | Regression evidence                          |
| ---------------------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| Partial filter reuses whole-plan metrics | A different edit must use static ranking until measured | Partial-plan assertion failed before the fix |
| Unchanged filter loses valid evidence    | Keeping the complete edit retains its measurement       | Unchanged-plan assertion passes              |
| Empty filter leaves actionable plans     | Hidden actions cannot reappear through plans            | Empty-plan and coverage assertions pass      |

## Combined destination branch validation

Integrated with `codex/improve-legend-detection-and-reviews` at `d71a472`, preserving its transition
review and workspace-resolution changes. Full `npm run check` passes: lint, formatting, typecheck,
build, **915 tests**, and package dry-run. `REPORT.md` is included in the package. The final self-scan
has zero actionable findings.

All **237 pinned targets** pass: **1,236 hooks**, **508/524 hook labels**, **74/75 Legend practice
labels**, one explicit Legend known miss, and no unexpected recommendations. The 16 known hook misses
remain visible. Subscription actions do not change during integration.

Relative to the pre-integration subscription snapshot, the combined branch has these additional action
deltas from the destination branch's detector work:

| Application             | Additional action delta                |
| ----------------------- | -------------------------------------- |
| Legend Music            | 0                                      |
| Excalidraw              | 0                                      |
| Expensify               | 0                                      |
| Formbricks              | 0                                      |
| Outline                 | 0                                      |
| Open WebUI React Native | 0                                      |
| Hoalu                   | `review-state` −1; `use-observable` +1 |

TypeScript's [module reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html#packagejson-exports)
and [5.9.3 resolver source](https://github.com/microsoft/TypeScript/blob/v5.9.3/src/compiler/moduleNameResolver.ts)
were also checked against the workspace resolver's use of the compiler API and its in-memory host.
