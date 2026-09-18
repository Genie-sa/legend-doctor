# Evaluation

Legend Doctor is evaluated as an agent-triage system against pinned open-source applications, not by snapshotting
whatever it currently prints.

## What is scored

- **Hook labels.** Every labeled `useState` or `useEffect` records the action it must receive. Proven opportunities the
  analyzer does not implement yet stay in the corpus with `enforced: false`: they count against recall without failing
  the run. A label may also pin the `abstentionReason` a review finding must carry, and the review question it must ask
  through `assumption: { ifConfirmed }`.
- **Grouped instructions.** State-cluster labels verify exact cluster membership.
- **Legend practice labels.** Every practice finding on a labeled target must match a label; an unlabeled practice
  finding is a failure, so practice precision is measured over everything the tool prints. A manually audited optional
  `disposition` label also rejects the right action with an incorrect cost classification; omitted dispositions retain
  action-only matching.

The primary metric is precision among non-review recommendations. Recall is reported globally and per action so
abstention cannot masquerade as accuracy. The runner also prints a deterministic abstention-reason histogram globally
and per application root.

## Corpus

Pinned public repositories, each at a fixed commit with focused source roots where the application is large:

- `LegendApp/legend-music`
- `excalidraw/excalidraw`
- `Expensify/App`
- `formbricks/formbricks`
- `outline/outline`
- `RonasIT/open-webui-react-native`
- `quanphm/hoalu`

Repository source is never copied into this project. Each corpus entry pins a commit and a source location, and the
runner scans local checkouts. A label enters the corpus only after manual review of the source it points at.

### Private slice

Labels for applications that cannot be published live in `evals/corpus/private/`, which git ignores. The directory
exports one `privateCorpus: CorpusSlice` from `index.ts`; when it is present the runner merges it into the public
corpus, and when it is absent the public corpus stands alone. Contributors and CI therefore run the same command, and
the summary's first line says which corpus ran.

## Running

Build, then require the complete corpus by passing every checkout:

```bash
npm run build
node dist/evals/run.js --complete \
  --repo legend-music=/path/to/legend-music \
  --repo excalidraw=/path/to/excalidraw \
  --repo expensify=/path/to/App \
  --repo formbricks=/path/to/formbricks \
  --repo outline=/path/to/outline \
  --repo open-webui-react-native=/path/to/open-webui-react-native \
  --repo hoalu=/path/to/hoalu
```

`--complete` requires every repository in the loaded corpus, including an optional private slice. Missing paths fail
before analysis, and each omitted repository is named. Unknown repository names, duplicate assignments, empty paths,
unknown arguments, and combining `--complete` with `--partial` are errors.

For intentional research on a subset, use `--partial` (also the default for existing commands):

```bash
node dist/evals/run.js --partial --repo legend-music=/path/to/legend-music
```

Partial runs visibly report their mode, supplied repository count, and every omitted repository. Their metrics cover
only evaluated targets and cannot establish complete-corpus success. Any off-pin checkout fails even in partial mode.
A run that evaluates zero targets fails without printing precision/recall percentages. Exit code 0 means the selected
nonempty corpus passed; exit code 1 means invalid input, checkout/analysis failure, or scored mismatches.

The `Complete pinned public corpus` CI job fetches the exact commits from `corpus/**/repository.ts`, caches source
checkouts by those manifests, and runs `--complete`. Application dependencies and scripts are never installed or run.
The cache is saved before evaluation so existing detector failures do not force repeated cold downloads. No mismatch
is waived: see [the September 19 audit ledger](audit-2026-09-19.md) for the original seven failures, two source-audited label corrections, five remaining blockers, and 31 unscored
changes. A red corpus job remains a real gate; unit-suite success does not override it.

`npm run eval:runtime` runs the executable migration contracts under jsdom with pinned React and Legend State: form
submission snapshots, keyed selection and draft identity, independent hook lifetimes, atomic dialog publication, and
memoized snapshot identity, with and without StrictMode. They also run in `npm test`.

## Changing the corpus

Read `AGENTS.md` first. When a detector changes, add a minimal adversarial fixture test and a manually audited label
from a pinned application. Keep uncertain opportunities as explicit `enforced: false` labels rather than weakening a
proof. Report action deltas for every application after each detector phase, including zero-change applications.

Candidate Legend practices are source reviews rather than optimization predictions. The runner lists
every candidate location separately, excludes candidates from practice precision, and does not let a
candidate satisfy an enforced optimization label. Unlabeled `change` and `style` practices still fail.
`evals/research/helper-tracking.json` contains manually audited, pinned, non-enforced research labels;
these are not loaded into scored corpus totals and do not claim imported-helper support.
