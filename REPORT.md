# Report reference

Field-level detail for the JSON report. Read [README.md](README.md) first.

Version-gate consumers with `schemaVersion`, currently `4`.

Grouped state findings may also include additive `transitions` evidence. `writes` lists direct
setter calls with state names, line/column positions, handler identities, and enclosing control
contexts. `relations` refers to zero-based write indices in the same handler. `coexecution: proven`
means a shared synchronous path exists; it does **not** mean all executions are one atomic update.
`disproven` includes separate suspension phases and mutually exclusive/unreachable paths; `unknown`
retains an explicit proof gap. No relation is inferred between different handlers.

Only `fusion: adjacent-literals` identifies adjacent replacements of distinct fields with literal
values that can form one `assign`. `preserve-source` means retain evaluation order, branches, and
exception/suspension boundaries; it does not authorize moving those expressions into an object
literal. Group reviews name unresolved pairs by exact source location. These are bounded source
facts, not a complete migration plan or new permission to convert a review finding. Transported
setters still depend on the existing child-contract proofs and are not listed as direct writes.

Schema 4 removes the unused `diagnostics.semantic` field. Coverage schema 2 reports only `parser`, `lowering`,
and `detector`: no detector consumed the former semantic stage. The experimental `createSemanticContext`,
`AnalysisContextOptions.configFilePath`, and semantic context types have been removed.

Important fields:

| Field          | Meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `status`       | `ok` or `error`                                                             |
| `root`         | Base directory for every finding path                                       |
| `analyzer`     | Tool `version` and compiled `build`                                         |
| `findings`     | React state and effect findings                                             |
| `practices`    | Legend State practice findings                                              |
| `hidden`       | Findings removed by filters                                                 |
| `capabilities` | Legend State version and exports, React Compiler status, and disabled rules |
| `scope`        | Active scope flag and loaded context file count                             |

Compare reports only when `analyzer.build` matches.

Every `review-state` and `review-effect` finding has an `abstentionReason`. It names the main fact or safety rule that
blocked a proven edit.

Every review also carries `review: { kind, blockers, next }`. This is additive guidance in schema 4;
the action and disposition remain authoritative. `blockers` combines the current reason, question facts,
and any group members' known next blockers. It is not an exhaustive list of every missing proof.

| `review.kind`       | Next step                                                                       |
| ------------------- | ------------------------------------------------------------------------------- |
| `confirm`           | Research and answer the attached open question.                                 |
| `recheck`           | Re-read changed source before renewing a stale answer.                          |
| `declined`          | Preserve the current behavior; the recorded answer rejected the conversion.     |
| `dependency`        | Resolve the question ids in `waitsOn`, then rescan.                             |
| `unsupported`       | Resolve a binding, callback, or callable-state shape the analyzer cannot model. |
| `no-proven-benefit` | Establish a render or lifecycle saving before proposing a migration.            |
| `investigate`       | Follow `review.next`; no supported yes/no answer currently yields an edit.      |

`async-command-origin-unresolved` means an async pending interval and leaf boundary are proven, but
the command's event origin is not. This differs from `callback-timing-unresolved`, which concerns
captured-value reads. Eligible direct JSX event references and inline adapters receive an event-origin
question; known direct render calls do not. Confirming it preserves the existing async command and
changes its pending writes and subscriber boundary. Old answers keyed to the former reason do not
silently confirm this new question.

Use an unfiltered scan to inventory all review kinds. `--actionable` still hides reviews without a
confirmable question; guidance does not override that filter or make a review actionable.

## Answer a review question

When one yes/no fact is all that blocks a `review-state` finding, the finding also carries an `assumption`:

| Field         | Meaning                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- |
| `id`          | Stable across line shifts: report file, owner, state name, blocker                           |
| `question`    | The concrete fact to confirm, naming the states, targets, or read sites involved             |
| `facts`       | The blockers a "yes" assumes away; one, or two when a second blocker stands behind the first |
| `research`    | Distinct checks with `file`, first `line`, all `lines`, and the full source-site `total`     |
| `ifConfirmed` | The action a confirmed answer produces; the tool re-ran its proofs with that fact assumed    |
| `fingerprint` | Digest of the owner's source; an answer recorded for a different digest is reported `stale`  |
| `renderCost`  | JSX elements the owner renders per update of this state                                      |
| `updateSites` | Setter call sites; `renderCost × updateSites` is the `priority` used by `report.questions`   |
| `status`      | `open`, `confirmed`, `rejected`, or `stale`                                                  |

A question is asked only when the hypothetical run yields a conversion, so every "yes" has a concrete instruction.
`report.questions` lists the open ones by `rank`. A group reports the first converting member's action in
`ifConfirmed` and the number that convert in `convertingCount`; individual outcomes remain in `members`.
Repeated research instructions list every relevant line and a full site count, including multiple sites on one line. A step without `lines` or `total` describes one site at `line`.
Record answers in `<root>/.legend-doctor/confirmations.json`, which
every scan of that root reads, or in any file passed with `--confirm`:

```json
{
  "confirmations": [
    {
      "id": "src/panel.tsx::Panel::open::atomic-transition-unproven",
      "fingerprint": "8444a887430f",
      "answer": "yes",
      "note": "both writes sit in fail(); Drawer renders open directly (drawer.tsx:12)"
    },
    {
      "id": "src/panel.tsx::Panel::filter::render-cut-unproven",
      "fingerprint": "4f22f4aca655",
      "answer": "no"
    }
  ]
}
```

```bash
legend-doctor <root>
```

Or let the tool write the entry, fingerprint included, and report the scan that honours it in one command:

```bash
legend-doctor <root> --answer "src/panel.tsx::Panel::open::atomic-transition-unproven=yes" --note "both writes sit in fail()"
```

A `review-effect` finding can carry the same block: an empty-dependency setup effect asks whether `useMount`'s once-only
semantics are intended. An effect whose verdict waits on a React state instead lists that state's open question ids in
`waitsOn`, so the answer that settles the state settles the effect.

When assuming the first blocker away still leaves a review verdict, the tool assumes the next one too and asks both
facts in one question; the id then joins both reasons with `+`, and `facts` lists them in order. Two facts is the cap.

States a handler writes together share one question and one id, `file::Owner::{a,b}::atomic-transition-unproven`.
Its `members` list says what a "yes" does to each: members whose standalone proof already passes convert together under
one cluster instruction written with `assign`, and a member another blocker still holds is re-examined without the
co-write blocker and gets its next question on the same scan.

A confirmed individual question turns its finding into `ifConfirmed` with disposition `change`; a group converts only the members whose outcome is actionable. The answer is recorded in each converted finding's evidence. Such a finding also carries `verification`: the conversion rests on an answer rather than a proof, so the
recipe names the jsdom harness exported as `legend-doctor/runtime` (`mountDom`, `count`), the before/after comparison
to run, and the render-count and DOM expectations that must hold; a failed comparison means the answer was wrong. A rejected id keeps the review verdict and stops the question from being asked again. When the owner's code
changes, the fingerprint no longer matches: the answer is reported `stale`, not applied, and the question is asked
again. The report's `confirmations` block counts applied, rejected, and stale answers, names the file they came from,
and lists ids no finding produced.

Failures are also valid JSON. They include `status: "error"`, a stable `reason`, a useful `message`, and
sometimes a `next` command.

## Compact provenance

`materiality: "compact"` means compact mode changed the finding's action or made a new conversion confirmable.
Kept findings and outcomes already available in broad mode are untagged. This comparison includes consumer-size
thresholds for hook-owned state. Compact mode evaluates both policies on the same parsed source; it adds analysis
work but does not reread or reparse files.
