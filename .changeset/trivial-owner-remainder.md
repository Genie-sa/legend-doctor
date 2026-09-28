---
"legend-doctor": patch
---

Keep state as React state when a `use-observable` or `move-state-down` cut would skip only a trivial owner render. Outside the leaf that reads or carries the value, fewer elements than a compact owner must remain, none repeated, each a host element or a resolved child that calls only built-in reads and renders unrepeated host elements, and the owner must call nothing but read-only projections and core React hooks. Work in event handlers, commit callbacks, deferred schedulers, and `useMemo` factories does not count, since it does not re-run on the update. Repeated leaves, custom-hook owners, keyed leaves, and context clusters keep their cut, and a cluster converts only when every member's remainder is trivial.
