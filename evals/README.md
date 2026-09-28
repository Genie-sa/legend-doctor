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
- **Expert replay.** Performance commits by Legend State's author and by application maintainers are ground truth for
  what an expert changes. Each hunk is labeled at its line in the commit's first parent: `enforced` when a sound static
  proof shows the edit removes a render or lifecycle cost without changing behavior, `non-enforced` when it changes
  timing or dependencies or rests on an unprovable fact, and `excluded` when it removes no such cost (logging, UX,
  refactors, bug fixes).

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
- `LegendApp/legend-photos`
- `LegendApp/legend-apps`
- `nonbili/NouTube`
- `nonbili/Nori`

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
  --repo hoalu=/path/to/hoalu \
  --repo legend-photos=/path/to/legend-photos \
  --repo legend-apps=/path/to/legend-apps \
  --repo noutube=/path/to/NouTube \
  --repo nori=/path/to/Nori
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
is waived: see [the September 19 audit ledger](audit-2026-09-19.md) for the original seven failures, the follow-up source audits and detector repairs, and 31 unscored
changes. The [September 28 audit](audit-2026-09-28.md) records the renderer proof behind concurrent-root transaction
reviews and the three batch labels it retired. The [lockfile version audit](audit-2026-09-28-lockfile-versions.md)
records the Legend State version each checkout pins and the `replace-legacy-use-value` labels it retired. The [in-place memo key audit](audit-2026-09-28-in-place-memo-keys.md) records the runtime and replay
evidence behind `snapshot-mutated-use-value` and its two non-enforced legend-music candidates. A red corpus job remains a real gate; unit-suite success does not override it.

### Expert replay

`evals/corpus/*/replay-commits.ts` and `evals/corpus/legend-apps/replay-*.ts` pin each replayed commit and its first
parent. Every hook-level edit in a replayed commit is labeled, including the ones a static analyzer cannot or should not
recommend:

| Repository                | Commits | Scope                                                                                                                                | Enforced | Non-enforced | Excluded |
| ------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------ | -------: | -----------: | -------: |
| `LegendApp/legend-apps`   |      41 | Jay Meistrich's July and September 2026 performance sweeps in Music, Slides, Markdown, Code, Chat History, Diff, and shared packages |       64 |           83 |      115 |
| `LegendApp/legend-music`  |      11 | Jay Meistrich's subscription, observer, and timer commits                                                                            |       16 |           25 |       30 |
| `LegendApp/legend-photos` |       4 | Jay Meistrich's selection, image, plugin, and filmstrip commits                                                                      |        1 |            0 |        5 |
| `nonbili/NouTube`         |       1 | The maintainer's feed and library modal commit                                                                                       |        3 |            1 |        8 |
| `nonbili/Nori`            |       1 | The maintainer's bookmark drawer commit                                                                                              |        0 |            0 |        1 |

A deletion that stops subscribing to a lazily synced store, such as a `synced()` persisted store, is non-enforced: the
subscription is what activates the load, so a later `peek()` can read the default instead of the persisted value.

For every supplied repository, the runner extracts the parent tree from the checkout's object store with `git archive`
into a temporary directory, scans its source root, and prints `Expert replay recall: x/y`: enforced cases where a
proven `change` finding at the labeled line carries the expert's action or a listed equivalent. Recall on September 28,
2026 is 22/84. Each miss names what the analyzer reported there, including abstention reasons, subscription-inventory
blockers, and the gate at which the targeted rule abstained (`ruleGates`). Non-enforced cases are reported separately
and list any proven change the analyzer makes there, since that contradicts the audit; neither misses nor non-enforced
flags fail the run. A label whose parent line no longer contains its `source` text fails, as does a parent missing
from the checkout. A full-history clone contains every parent; for a shallow checkout, fetch each one by SHA:

```bash
git -C /path/to/legend-music fetch --depth=1 https://github.com/LegendApp/legend-music.git <parent>
```

CI fetches the parents the same way after the pinned commits, so the cost is one shallow fetch per distinct parent.

`npm run eval:runtime` runs the executable migration contracts under jsdom with pinned React and Legend State: form
submission snapshots, keyed selection and draft identity, independent hook lifetimes, atomic dialog publication,
memoized snapshot identity, and the lazy load a persisted-store subscription starts, with and without StrictMode. They
also run in `npm test`.

## Changing the corpus

Read `AGENTS.md` first. When a detector changes, add a minimal adversarial fixture test and a manually audited label
from a pinned application. Keep uncertain opportunities as explicit `enforced: false` labels rather than weakening a
proof. Report action deltas for every application after each detector phase, including zero-change applications.

Candidate Legend practices are source reviews rather than optimization predictions. The runner lists
every candidate location separately, excludes candidates from practice precision, and does not let a
candidate satisfy an enforced optimization label. Unlabeled `change` and `style` practices still fail.
`evals/research/helper-tracking.json` contains manually audited, pinned, non-enforced research labels;
these are not loaded into scored corpus totals and do not claim imported-helper support.
