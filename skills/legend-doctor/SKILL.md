---
name: legend-doctor
description: Use when editing React useState/useEffect code or optimizing Legend State usage in a project with legend-doctor available. Scans before and after edits, applies proven change findings, and triages candidates against source proof.
---

# Legend Doctor

Legend Doctor is a read-only static analyzer that proves which React `useState`/`useEffect` hooks can become Legend State observables, move into leaf subscribers, or be deleted — and which observable usage patterns waste renders. Findings without a complete structural proof stay as candidates instead of instructions; never treat a candidate as an approved edit.

## Scan

```bash
node <legend-doctor>/dist/src/cli.js <absolute root> --json --actionable
```

Scan the smallest complete root that contains the relevant components, hooks, imports, re-exports, and observables. A single-file scan can hide the proof needed for a safe result. The JSON report root carries `schemaVersion` (currently `1`).

Useful filters:

```bash
# Proven edits only
node <legend-doctor>/dist/src/cli.js <root> --json --disposition change

# Opportunities that need review
node <legend-doctor>/dist/src/cli.js <root> --json --disposition candidate
```

## Act on dispositions

| Disposition | Action |
| --- | --- |
| `change` | Apply the instruction. Structural proof is complete. |
| `candidate` | Inspect the named source. Edit only when it proves the missing timing, ownership, or type fact. |
| `keep` | Preserve the current React or lifecycle boundary. |
| `style` | Apply only when the installed Legend API supports the equivalent form. |

## Loop

1. Scan before editing.
2. Apply one group of `change` findings.
3. Read every `candidate`; edit only on source proof.
4. Preserve state lifetime, mount identity, effect timing, cleanup, dependencies, write order, keys, and atomic writes.
5. Run the application's formatter, typecheck, and relevant tests.
6. Scan the same root again — applied changes can expose smaller subscription boundaries.
7. Report the exact finding delta, including a zero delta.
8. Stop when checks pass and every remaining finding is intentional.

Suppress a deliberate React effect's `review-effect` finding by preceding it with `// legend-doctor keep-react-effect`.

The tool's `README.md` documents every action with worked before/after examples; read the matching entry before applying an unfamiliar action.
