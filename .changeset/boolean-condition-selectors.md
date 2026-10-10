---
"legend-doctor": patch
---

Select one boolean per condition when a `useValue` result is read only through comparisons, read-only built-in predicates, and truthiness tests over its declared members, `length`, or `size`, such as `items.length > 1`, `user?.role === "admin"`, `selected.includes(id)`, or `status === "loading" || status === "saving"`. The owner then renders only when one of those booleans flips. Member reads on values that may be `null` or `undefined` need `?.` or a guard inside the condition, predicate callbacks must be pure, and the finding is withheld unless some change of the value leaves every boolean unchanged or another practice already rewrites the same subscription.
