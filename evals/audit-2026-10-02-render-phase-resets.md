# Render-phase reset audit — October 2, 2026

New effect action: `reset-during-render` replaces an effect that resets the owner's React state when an input changes
with a previous-value comparison during render, the pattern React documents for adjusting state when a prop changes.
Analysis baseline: `4bac7d1`. No pin or target changed.

## React facts

- A render-phase update re-runs the component before React renders its children, and the re-run receives the same
  props object. A prop, or a property path off it, therefore keeps its identity while the comparison settles. A custom
  hook's parameter does not: the calling component re-runs and may rebuild the argument.
- A comparison against a value the owner builds on every render, such as an inline object, array, or function, or a
  custom hook result that returns a fresh object, never settles, and React stops it with "Too many re-renders". The
  effect form tolerates such a value because a same-value `setState` bails out after commit.
- The effect also runs on mount. The rewrite keeps the first commit only when every mount write is a no-op, so each
  written value must be the state's own initializer. An effect that swaps a placeholder for a real value after mount,
  such as an animation source that starts `undefined` so the first commit renders an empty view, keeps its timing.

## Proof

The finding is a change when every compared dependency is a state value, a module binding or import, a `length`, a
local primitive constant, or a component prop without a destructuring default. A memoized local or a hook result leaves
`review-effect` with `dependency-identity-unproven` and one question; a confirmed answer turns it into the change and
attaches a runtime verification recipe. The reset applies only while every target stays React state, so it never
conflicts with a `use-observable` instruction that keeps the effect, and the paired-draft cluster keeps precedence.

## Labels

Each label below was audited against its source.

| Target                       | Line | Before                                     | After                          |
| ---------------------------- | ---- | ------------------------------------------ | ------------------------------ |
| excalidraw `ColorInput`      | 37   | `review-effect`                            | `reset-during-render`          |
| excalidraw `PublishLibrary`  | 247  | `review-effect`                            | `reset-during-render`          |
| expensify-dynamic-plan-type  | 64   | `review-effect`                            | `reset-during-render`          |
| formbricks-filter-value      | 95   | `review-effect`                            | `reset-during-render`          |
| formbricks-recontact-options | 134  | `review-effect`                            | `reset-during-render`          |
| outline-icon-picker          | 170  | `effect-write-ownership-unresolved` review | `dependency-identity-unproven` |
| private slice (3 labels)     | —    | 2 `keep-effect`, 1 `review-effect`         | 2 changes, 1 identity review   |

The outline and private identity reviews depend on a memoized local and a custom hook result, so a question is the
correct outcome. Corpus scans add 53 `reset-during-render` findings across 12 pinned checkouts; a sample of 22, including all
10 that move from `keep-effect`, are prop, state, or length-keyed resets to the state's own initializer.

## Unseen apps

On 17 unpinned apps the action changes 55 effects: 21 become changes and 34 ask the identity question. All 21 changes
were audited correct. Of 24 previously audited removable reset effects, the action surfaces 9 and leaves both audited
"keep" effects alone. Most misses change the first commit, write through an updater, call an unresolved function, or
belong to the paired-draft cluster.
