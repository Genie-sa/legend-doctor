---
name: legend-doctor
description: React useState/useEffect triage for Legend State. Use before editing useState or useEffect, when migrating state to Legend State observables, or when cutting re-renders, in any project where a legend-doctor checkout is available.
---

# Legend Doctor

Legend Doctor is a read-only static analyzer. It proves which React `useState`/`useEffect` hooks can become Legend
State observables, move into leaf subscribers, or be deleted, and which observable usages waste renders. A finding
with complete structural proof arrives as a `change` instruction; everything else stays a `candidate` that names its
missing proof, and the edit is earned only by reading the named source.

## Scan

`<legend-doctor>` is the path to a built checkout of the tool (`npm ci && npm run build` inside it).

```bash
node <legend-doctor>/dist/src/cli.js <absolute root> --json --actionable
```

Scan the smallest complete root that contains the relevant components, hooks, imports, re-exports, and observables; a
single-file scan can hide the proof a safe result needs. The report root carries `schemaVersion` (currently `1`).

Filters: `--disposition change` (proven edits only), `--disposition candidate` (needs review), plain text without
`--json` for a compact queue. `--help` documents the complete surface; exit 2 means invalid usage (the error names the
fix), exit 1 means the scan failed, exit 0 means the report is complete whatever it contains.

## Dispositions

| Disposition | Action |
| --- | --- |
| `change` | Apply the instruction. Structural proof is complete. |
| `candidate` | Inspect the named source. Edit only when it proves the missing timing, ownership, or type fact. |
| `keep` | Preserve the current React or lifecycle boundary. |
| `style` | Apply only when the installed Legend API supports the equivalent form. |

Keep a deliberate React effect by preceding it with `// legend-doctor keep-react-effect`; that suppresses its
`review-effect` finding.

## Loop

1. Scan before editing.
2. Apply one group of `change` findings.
3. Read every `candidate`. Edit only when the named source proves the missing fact.
4. Preserve lifecycle, mount identity, state ownership, command timing, keys, and atomic transitions.
5. Run the application's formatter, typecheck, and relevant tests.
6. Scan the same root again; applied changes can expose a smaller subscription boundary, so the second scan is part of
   the edit, not optional cleanup.
7. Report each added, removed, or changed finding, including a zero delta.
8. Stop when checks pass and every remaining finding is a `keep` or a `candidate` whose missing proof you can name.

Before applying an unfamiliar action, read its worked example in the tool's `README.md`.
