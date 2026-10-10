---
"legend-doctor": patch
---

Write proven conditional gates and conditional-slot `move-use-value-down` findings as Legend's own `<Show>` and `<Switch>` elements instead of a hand-written gate component, when the condition is boolean, the branches do not read the narrowed value, the state's literal values miss `Object.prototype`, and the slot's parent is a host element or fragment that never inspects its children. Add a `render-list-with-for` practice that replaces a keyed `useValue(list$).map(...)` with `<For>` when the map is the list's only read and its rows capture no changing owner value, and a `use-peek-for-snapshot` candidate for row keys read with `get()` inside an `observer` render or a Legend child function.
