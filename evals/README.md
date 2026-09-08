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
  finding is a failure, so practice precision is measured over everything the tool prints.

The primary metric is precision among non-review recommendations. Recall is reported globally and per action so
abstention cannot masquerade as accuracy. The runner also prints a deterministic abstention-reason histogram globally
and per application root.

The summary also separates review findings from distinct open question versions, dependent findings,
answered/stale findings, and findings without a question. Group outcomes show which members would
convert if confirmed and which remain blocked or retained. These are descriptive workload metrics,
not additional approvals, an exhaustive blocker ledger, or changes to precision/recall scoring.
Question identity includes its target, id, and source fingerprint.

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

Build, then pass a checkout for each repository you have:

```bash
npm run build
node dist/evals/run.js \
  --repo legend-music=/path/to/legend-music \
  --repo excalidraw=/path/to/excalidraw \
  --repo expensify=/path/to/App \
  --repo formbricks=/path/to/formbricks \
  --repo outline=/path/to/outline \
  --repo open-webui-react-native=/path/to/open-webui-react-native \
  --repo hoalu=/path/to/hoalu
```

Repositories without a path are reported and skipped. A checkout that is not at its pinned commit is reported as an
off-pin failure so drift is visible instead of silently changing the numbers.

`npm run eval:runtime` runs the executable migration contracts under jsdom with pinned React and Legend State: form
submission snapshots, keyed selection and draft identity, independent hook lifetimes, atomic dialog publication, and
memoized snapshot identity, with and without StrictMode. They also run in `npm test`.

## Changing the corpus

Read `AGENTS.md` first. When a detector changes, add a minimal adversarial fixture test and a manually audited label
from a pinned application. Keep uncertain opportunities as explicit `enforced: false` labels rather than weakening a
proof. Report action deltas for every application after each detector phase, including zero-change applications.
