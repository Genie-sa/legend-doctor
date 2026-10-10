---
"legend-doctor": patch
---

Add the `select-stable-selector-result` candidate for `useValue` selectors that build a new object or array on every run, from `filter`/`map`/`flatMap`, `Object.keys`/`values`/`entries`, or a literal of comparisons. A tracked change that leaves the contents equal still re-renders the component, because Legend compares selector results by reference.
