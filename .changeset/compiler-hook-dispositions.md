---
"legend-doctor": patch
---

Model which functions the React Compiler compiles, from its default rules: hook-shaped names, `memo`/`forwardRef` callbacks, `"use memo"` and `"use no memo"` directives, and ESLint suppressions. In compiled functions, report `use$` as `change`, because the Compiler only treats `use[A-Z0-9]` names as hooks. Report observable `.get()` reads in an `observer` render that reach the output as `change`, and flag method chains on a raw `useValue` result that the Compiler memoizes by reference.
