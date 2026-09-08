# Report reference

Field-level detail for the JSON report. Read [README.md](README.md) first.

Version-gate consumers with `schemaVersion`, currently `4`.

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

## Coordinated subscriptions (version 1)

`subscriptionAnalysis` is an additive section of schema 4. Its own `version` is `1`.

- `inventory` records each recognized imported `useValue` call in eligible scanned files, including aliases.
  Each entry contains its source location, binding, observable, classified reads, derivations, and status:
  `planned`, `other-action`, or `unresolved`. Unresolved entries have explicit reasons; they are not findings.
- `coverage` counts those three statuses and their total. This is subscription inventory coverage, separate
  from hook coverage and manually labeled corpus recall. It does not count hidden subscriptions inside
  arbitrary custom hooks or unrecognized imports.
- `plans` groups actionable subscription cuts by owner. Overlapping JSX boundaries merge into one child.
  Each plan lists subscriptions, complete derivation chains, child locations, remaining parent inputs,
  implementation steps, and behavioral verification. Define new children at module scope and retain their
  mount slots. Keep observable creation and atomic writes in their existing owner.
- `impact.basis: "static-jsx"` ranks by owner JSX elements outside the proposed children. These are source
  counts, not render counts, elapsed time, or a promised speedup. `rank` starts at 1.
- `impact.basis: "provided-runtime-measurement"` identifies externally supplied before/after render counts.
  Measurements do not bypass detector proofs or create findings.
- `rejectedMeasurements` reports malformed, stale, duplicate, or unmatched measurement entries.

A practice finding with a coordinated cut also has `subscription` metadata. Report filters remove matching
plans and mark filtered inventory entries `excluded-by-report-filter`, so ignored actions do not reappear
as implementation instructions. Filtering away any part of a plan also removes its runtime measurement;
measurements of a complete edit cannot rank a partial edit.

To attach runtime evidence, create `<analysis-root>/.legend-doctor/subscription-measurements.json`:

```json
[
  {
    "planId": "copy plans[i].id from the baseline report",
    "fingerprint": "copy plans[i].fingerprint from the baseline report",
    "scenario": "toggle the setting ten times with unrelated UI mounted",
    "samples": 10,
    "before": { "ownerRenders": 10, "siblingRenders": 30 },
    "after": { "ownerRenders": 0, "siblingRenders": 0 },
    "behaviorEquivalent": true
  }
]
```

Record equal interaction samples before and after in the same runtime configuration, excluding initial
mounts. Verify visible values, drafts, callback snapshots, identity, effect cleanup, and atomic updates
before setting `behaviorEquivalent`. The analyzer trusts this supplied assertion; it does not run the app.
Attach the evidence when scanning the **baseline source**: the fingerprint hashes the owner's source text,
so a scan of the edited owner rejects it as stale. External modules and runtime settings are not included
in that fingerprint; repeat measurements when either changes. Programmatic `analyzePath` callers may pass
`subscriptionMeasurements` instead of creating the file.

Measured positive savings rank first, unmeasured static plans next, and measured zero/negative savings last.
Within measured groups, ranking uses total owner-plus-sibling renders saved per sample. This ordering is a
triage aid; scenario frequency and render duration still require application profiling.

Closed `const` aliases/defaults and supported `useMemo` projections move with their subscriptions. Memo
identity and dependencies remain intact. Literal primitive effect dependencies and explicitly typed primitive
props can prove that an independent effect will not rerun on subscription-only updates. Missing/unstable
or unresolved dependencies, callback snapshots, refs, overlapping parent subscriptions, repeated render
callbacks, and unsupported expressions remain conservative blockers. General selector relocation is not
implied by inventory coverage.
