# Render-phase reset identity and mount audit — October 10, 2026

`reset-during-render` now proves more of its two preconditions. No pin or target changed.

## What changed

- **Dependency identity.** A component prop with a primitive or module-binding destructuring default, a field
  destructured in the body from the props parameter or its rest element, a local alias of a module binding, and a memo
  whose factory returns only primitives or module constants compare equal while the comparison settles. A custom hook
  parameter qualifies when its declared type, directly or through a local non-generic interface or type alias, is a
  string, boolean, literal, `null`, or `undefined`: React requires a pure caller, which recomputes such a value to an
  equal one. `number` stays a question because `NaN` never equals itself.
- **Mount write.** A guard of the form `x === "a" || x === "b"` pins `x`; when the written value and the state's
  initializer fold to the same constant under every pinned literal, the mount run stores the value the state already
  holds and the first commit is unchanged. A subject pinned to `0` is folded only where it is compared, since `-0`
  differs from `0` under `Object.is`.

## Measurement

Before implementing, 577 `review-effect` findings across nine apps were classified by their dependency roots: 374
dependencies are props, 373 external hook results, 247 owner locals, 170 memos, 240 React states, and 37 Legend values.
Only 37 effects depend on local React state alone, and most of those render that state, so a paired
state-to-observable plus `useObserveEffect` conversion removes no render for nearly all of them. Effects keyed by props
cannot become observable reactions inside the owner. The sound gains are in the reset rule's proofs.

## Corpus deltas

Eighteen effects across eight pinned checkouts move to `reset-during-render`, each audited against its source: 17
from `review-effect` and one from `keep-effect`. Every other pinned app is unchanged.

| Label                                         | Before                                | After                 |
| --------------------------------------------- | ------------------------------------- | --------------------- |
| formbricks-when-to-send line 150              | `review-effect`                       | `reset-during-render` |
| formbricks-language-view line 127 (new)       | unlabeled                             | `reset-during-render` |
| outline-icon-picker line 170                  | `dependency-identity-unproven` review | `reset-during-render` |
| excalidraw `Tools` line 441 (new)             | unlabeled                             | `reset-during-render` |
| gptme `useConversationSettings` line 76 (new) | unlabeled                             | `reset-during-render` |
| junto `InspectorFields` line 603 (new)        | unlabeled                             | `reset-during-render` |
