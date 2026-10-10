---
"legend-doctor": patch
---

Review props that a memoized child re-renders for. A `stabilize-memo-prop` candidate fires when an owner passes a `memo`, Legend `observer`, or MobX `observer` child, alone or composed with `forwardRef`, an inline function, object, array, or element, and the owner also renders for state or a `useValue` subscription the element never reads. The child is resolved through imports, re-exports, star exports, and default exports, and a `memo` with its own comparator is skipped. Project hooks are followed to the values they return. The finding names the props to wrap in `useCallback` or `useMemo` or to move to module scope, and lists every input whose identity stays unproven. It is always a candidate, because a child that reads a global its owner mutates before forcing a render needs those renders. Components the React Compiler compiles are skipped.
