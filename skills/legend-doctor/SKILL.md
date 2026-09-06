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

```bash
legend-doctor <absolute root> --actionable
```

Use `npx legend-doctor` when it is not installed in the project.

Scan the smallest complete root that contains the relevant components, hooks, imports, re-exports, and observables; a
single-file scan can hide the proof a safe result needs. The report root carries `schemaVersion` (currently `3`) and
`analyzer: { version, build }`; record `build` with any saved scan and compare scans only when it matches.

Filters: `--disposition change` (proven edits only), `--disposition candidate` (needs review), `--actionable` for
one entry per edit. On a large repository add `--changed` after the first full scan: it analyzes only files
with uncommitted work while every file under the root still loads for proofs, so the rescan after an edit costs a
parse instead of a full analysis. `--since <ref>` does the same for everything touched since the merge base with
`<ref>`; `--staged` reads the git index. Scope flags need a directory target inside a git work tree. `--help` documents the complete surface; exit 2 means invalid usage (the error names the
fix), exit 1 means the scan failed, exit 0 means the report is complete whatever it contains.

Stdout is always one JSON document. Branch on `status`: `"ok"` carries `root` (every `location.file` is
relative to it) and `hidden` (findings and practices removed by filters, so an empty list is not a clean scan);
`"error"` carries a stable `reason` (`invalid_usage`, `unsupported_target`, `target_not_found`, `scope_unavailable`,
`scan_failed`),
a `message` naming the fix, and `next` commands when one applies. `--fail-on change` exits 3 while any shown finding
still has a proven edit, which makes the scan usable as a CI gate; `gate.matched` in the JSON carries the count. Every
`review-state` and `review-effect` finding has one stable, kebab-case `abstentionReason` naming its primary blocker or
preservation constraint; non-review findings omit that field. Use the code for automation and the finding's message
for source-reading guidance. `capabilities.disabledRules` lists the rules the installed toolchain switched off (for
example `observable-clone-writes` under the React Compiler, or `browser-storage-persistence` when the installed
`@legendapp/state` has no `sync` entry point) with a stable `reason`, so a missing finding can be told apart from a
clean file.

## Dispositions

| Disposition | Action                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `change`    | Apply the instruction. Structural proof is complete.                                            |
| `candidate` | Inspect the named source. Edit only when it proves the missing timing, ownership, or type fact. |
| `keep`      | Preserve the current React or lifecycle boundary.                                               |
| `style`     | Apply only when the installed Legend API supports the equivalent form.                          |

Keep a deliberate React effect by preceding it with `// legend-doctor keep-react-effect`; that suppresses its
`review-effect` finding.

## Loop

1. Scan before editing.
2. Apply one group of `change` findings.
3. Read every `candidate`. Edit only when the named source proves the missing fact.
   For a `review-state` finding with an `assumption`, follow "Answer review questions" below instead of guessing.
4. Preserve lifecycle, mount identity, state ownership, command timing, keys, and atomic transitions.
5. Run the application's formatter, typecheck, and relevant tests.
6. Scan the same root again; applied changes can expose a smaller subscription boundary, so the second scan is part of
   the edit, not optional cleanup.
7. Report each added, removed, or changed finding, including a zero delta.
8. Stop when checks pass and every remaining finding is a `keep` or a `candidate` whose missing proof you can name.

Before applying an unfamiliar action, read its worked example in the tool's `EXAMPLES.md`.

## Answer review questions

A `review-state` finding whose blocker is one confirmable fact carries `assumption`. You are the reviewer: answer it
from source, never from the finding's own text.

1. Work through `report.questions` in `rank` order; `priority` is the owner's JSX element count times its update sites,
   so the top entries are the renders an answer saves.
2. For each id, open every `assumption.research` step (`file`, `line`) and verify its `check`. Do not answer until every
   step has been read; a step in another file names the child component the answer depends on.
3. Answer `yes` only when every step holds; a question with two `facts` needs both, and its text joins them with
   "Additionally". Answer `no` when any step fails, and say which in `note`. A question with
   `members` covers a whole co-written group under one id; read every member's steps before answering, and expect the
   members marked `review-state` to come back with their own question once the group is confirmed.
4. Record the answer with `legend-doctor <root> --answer "<id>=yes" --note "why, citing file:line"`; the tool
   writes `<root>/.legend-doctor/confirmations.json` with the current fingerprint and reports the scan that honours it.
   Repeat `--answer` for several ids in one run. Editing the file by hand works too, but copy `fingerprint` exactly.
5. A `review-effect` finding with `waitsOn` has no question of its own: answer the listed state questions, and the
   effect follows the state's verdict on the next scan.
6. Re-scan. A confirmed id now reports `ifConfirmed` as a `change` with the answer in its evidence; apply it like any
   other change. `confirmations.stale` counts answers whose owner has changed since; re-answer those, do not reuse them.
7. After applying a conversion that carries `verification`, run its recipe: mount the before and after components with
   `mountDom` from `legend-doctor/runtime`, drive the write sites, and compare DOM snapshots and render tallies. Record
   the counts in the confirmation's `note`; on a failed comparison change the answer to `no` and revert the edit.
8. Never answer to reach a conversion. A wrong `yes` removes a proof the tool refused to make on its own.
