# Slides parent-tree audit — September 28, 2026

Scope: expert replay labels for legend-apps Slides commits `2e57a26` (parent `b73924e`) and `3447570` (parent
`81c6183`). No detector, pin, or target changed. Analysis baseline: `28772c7`.

The labels credited a caller-side field subscription with removing renders. A label is enforced only when the edit
removes a proven render at the labeled commit's parent. At both parents, most of these edits remove nothing on their
own.

## Runtime evidence

`tests/runtime/presentation-runtime-provider.test.ts` models the presentation runtime under jsdom with React 19.2.8 and
Legend State `3.0.0-beta.48`, with and without StrictMode. A deck publishes the slide clocks through a context-held
observable. Each step is one `set` of the step, its clock, the epochs, and the direction, the way `setSlidesState`
writes it. Consumer renders over three steps, without StrictMode (StrictMode doubles every nonzero count):

| Deck                                                            | Whole-runtime reader | Field reader |
| --------------------------------------------------------------- | -------------------: | -----------: |
| Rebuilds the provider value in render (`b73924e`)               |                    3 |            3 |
| Rebuilds it in render, content memoized as a compiler would     |                    3 |            0 |
| Computed runtime observable (`2e57a26`, `81c6183`)              |                    3 |            0 |
| Computed runtime, reader of `useStep`'s comparisons (`81c6183`) |                    3 |            0 |
| Computed runtime, reader of `useSlideLifecycle`'s fields        |                    3 |            3 |

With the deck rebuilding the value in render, React warns that a consumer update was not wrapped in `act`. The warning
comes from `useObservable(() => value, [value])` setting the runtime while the deck renders. The parent code does
exactly that.

## Relabels

Every case below moves from enforced to non-enforced.

**`2e57a26`, the 16 caller subscriptions.** At `b73924e`, Deck rebuilds the provider value in render from six
slide-clock subscriptions. Every runtime change therefore re-renders the deck content, and a field reader renders
exactly as often as a whole-runtime reader (row 1). The saving needs either compiler memoization of Deck's content
(row 2) or the computed runtime this same commit introduces (row 3).

| Action                          | Locations                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `split-use-value-leaves`        | `decks/react-native-desktop/GlassCaption.tsx:8` (`usePresentation`); `useSlideLifecycle` callers `AmbientAurora.tsx:33`, `Attention.tsx:20`, `FreezeFrame.tsx:10`, `motion.ts:6`, `effectRuntime.ts:19`, `LifecycleAnimation.tsx:8`, `SkiaNebula.tsx:32`, `TypeGPUBoids.tsx:146`, `TypeGPUGameOfLife.tsx:11`, `src/Effect.tsx:147`, `src/LiquidGlass.tsx:42`, `src/TypeGPU.tsx:34`, `src/steps.tsx:28` |
| `narrow-use-value-subscription` | `examples/components/FocusEngine.tsx:7`, `src/steps.tsx:85`                                                                                                                                                                                                                                                                                                                                            |

**`3447570` `runtime.tsx:40` (`useSlideLifecycle`).** Nothing in the `81c6183` tree calls the hook. The saving also
fails for any caller: every `setSlidesState` write that changes a runtime field the hook drops (`currentSlide`,
`currentStep`, `direction`, `stepEpochs`) also changes `startedAt`, `stepStartedAt`, or `stepIndex`, which it returns
(row 5). `slideCount` changes only through Deck's own render.

The legend-apps app enables the React Compiler in `shell/babel.config.js`. Deck at `b73924e` also says it subscribes
so the compiler cannot keep a stale snapshot. The compiler could therefore memoize Deck's content, and the field
subscriptions would then save renders. That depends on the compiler compiling Deck without bailing out, and no static
proof establishes it. The eval policy labels a saving that rests on an unprovable fact non-enforced.

## Kept

- **`3447570` `runtime.tsx:46` (`useStep`) stays enforced.** At `81c6183`, Deck publishes a computed runtime, and the
  audience window does not subscribe to the step, so a step change reaches only runtime subscribers. The narrowed
  selectors skip every step that flips neither comparison and leaves the `at`-th epoch and the direction unchanged
  (row 4). The rationale now cites this.
- **The Deck change stays non-enforced at `DeckRenderer.tsx:69-74` (`2e57a26`).** Replacing the render-built provider
  value with a computed runtime observable is the edit that creates the saving (row 3). It is not
  behavior-preserving: fixed previews stop publishing the live slide and step. It also needs every context consumer
  converted to field subscriptions before it removes any render. The existing `move-use-value-down` labels carry it.

## Totals

legend-apps replay labels: enforced 64 → 47, non-enforced 83 → 100, excluded 115. All 17 relabeled cases were misses
before this audit, so found cases are unchanged.
