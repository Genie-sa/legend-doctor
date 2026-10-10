---
"legend-doctor": minor
---

Recommend more proven Legend State conversions. Wrap a toggle's single render slot in `Computed` when every read and setter hand-off sits in one slot of a large owner; convert unresolved co-written primitive groups as one `useObservable({...})` written with `assign`; prove a lone write on a branch that skips every co-written state; wrap leaves for value writes to provably primitive state; allow read-only built-in calls (`filter`, `map`, `Math.max`, `String`) inside wrapped sites; ask callback child contracts at the call site that wires them; and wrap conditional and keyed call sites whose mount identity is proven along the exact chain of child slots.

Add Legend practices that narrow `useValue(map$)` read only at one key to `useValue(map$[key])`, select a boolean when a value is only tested for truthiness, and peek observable reads used only as a compare-and-set guard or dead binding. Prove more `reset-during-render` effects from typed hook parameters, primitive and module-bound defaults, and pinned guards, and compare reset dependencies with `Object.is`.
