---
"legend-doctor": patch
---

Stop treating a rebound hook name as React's hook. Recognition matched the imported name anywhere in
the file, so an injected or destructured `useState` in a closer scope still read as React state — and
`delete-unused-state` reported a proven `change` that would have deleted an unrelated call. A call now
reaches the import only when no enclosing scope rebinds the name.
