# Evaluation

Legend Doctor is evaluated as an agent-triage system against pinned open-source applications, not by snapshotting
whatever it currently prints.

## What is scored

- **Hook labels.** Every labeled `useState` or `useEffect` records the action it must receive. Proven opportunities the
  analyzer does not implement yet stay in the corpus with `enforced: false`: they count against recall without failing
  the run. An audited false positive is labeled the same way, with the action the tool should give and a rationale
  that starts with `Known false positive`: it counts against precision without failing the run, and the fix that
  removes it makes the label enforced. A label may also pin the `abstentionReason` a review finding must carry, and the review question it must ask
  through `assumption: { ifConfirmed }`.
- **Grouped instructions.** State-cluster labels verify exact cluster membership.
- **Legend practice labels.** Every practice finding on a labeled target must match a label; an unlabeled practice
  finding is a failure, so practice precision is measured over everything the tool prints. A manually audited optional
  `disposition` label also rejects the right action with an incorrect cost classification; omitted dispositions retain
  action-only matching. An audited false positive whose fix has not landed is labeled with the action the tool emits,
  `enforced: false`, and a rationale that starts with `Known false positive`: the finding stays in practice precision
  without failing the run, and the runner lists the label once the finding is gone so the fix deletes it. With the label
  deleted, the corpus asserts absence: any later `change` or `style` finding there fails as unlabeled. A proven
  opportunity the analyzer abstains on is labeled with the action it should give and `enforced: "known-miss"`: like a
  non-enforced hook label, it counts against practice recall without failing the run and never counts against practice
  precision. The runner prints `Known practice misses: x/y` for the ones still missing, and lists one emitted with the
  labeled action and disposition so its PR enforces the label. Never delete a known miss because it is not emitted.
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
- `gptme/gptme` (web UI)
- `equanimitech/zenborg`
- `skastr0/junto` (renderer)
- `skastr0/fractals` (expert replay only: no target is scanned at its pin)

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
  --repo nori=/path/to/Nori \
  --repo gptme=/path/to/gptme \
  --repo zenborg=/path/to/zenborg \
  --repo junto=/path/to/junto \
  --repo fractals=/path/to/fractals
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
evidence behind `snapshot-mutated-use-value` and its two non-enforced legend-music candidates. The [legacy-root handler audit](audit-2026-09-28-legacy-root-handlers.md) records the runtime proof that React event
handlers already render transaction writes once on legacy roots, and the three batch labels it retired. The [Slides parent-tree audit](audit-2026-09-28-slides-parent-tree.md)
records the runtime evidence behind the 17 Slides replay labels it moved to non-enforced. The [split-commit audit](audit-2026-09-28-split-commits.md) records the renderer
proof behind cross-microtask atomic-transition reviews and the three formbricks labels it moved to review. The [replay sweep audit](audit-2026-09-28-replay-sweep.md)
re-audits every remaining replay miss, moves four labels whose edit saves nothing alone to non-enforced, and records the
yield of each candidate proof. The [unseen-app pin audit](audit-2026-09-28-unseen-apps.md) records the gptme, zenborg, and junto labels and the known
false positives they carry. On October 1 the 14 `use-mount` and `use-unmount` labels and one first-render scroll
restoration review moved to `keep-effect`: Legend's `useMount` runs the same `useEffect` in production, and
`tests/runtime/lifecycle-aliases.test.ts` pins the only difference, a skipped teardown in Strict Mode's simulated
development unmount. The [latest-versions audit](audit-2026-10-01-latest-versions.md) supersedes the concurrent-root,
lockfile, and legacy-root findings above: on the supported React 19 and latest Legend State v3 baseline, it retires 25
transaction labels, marks six whose non-React observers span the writes as known misses, and labels every legacy
hook rename as style. Its same-file tracker gate enforces one of those six and removes the transaction reviews. A red
corpus job remains a real gate; unit-suite success does not override it.

### Expert replay

`evals/corpus/*/replay-commits.ts` and `evals/corpus/legend-apps/replay-*.ts` pin each replayed commit and its first
parent. Every hook-level edit in a replayed commit is labeled, including the ones a static analyzer cannot or should not
recommend:

| Repository                | Commits | Scope                                                                                                                                | Enforced | Non-enforced | Excluded |
| ------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------ | -------: | -----------: | -------: |
| `LegendApp/legend-apps`   |      49 | Jay Meistrich's July and September 2026 performance sweeps in Music, Slides, Markdown, Code, Chat History, Diff, and shared packages |       46 |          114 |      133 |
| `LegendApp/legend-music`  |      11 | Jay Meistrich's subscription, observer, and timer commits                                                                            |       16 |           25 |       30 |
| `LegendApp/legend-photos` |       4 | Jay Meistrich's selection, image, plugin, and filmstrip commits                                                                      |        1 |            0 |        5 |
| `nonbili/NouTube`         |       1 | The maintainer's feed and library modal commit                                                                                       |        3 |            1 |        8 |
| `nonbili/Nori`            |       1 | The maintainer's bookmark drawer commit                                                                                              |        0 |            0 |        1 |
| `skastr0/junto`           |      10 | The maintainer's renderer subscription, selector, and observer commits                                                               |       16 |           20 |       17 |
| `equanimitech/zenborg`    |       1 | The maintainer's drag-performance commit that drops an unread subscription                                                           |        1 |            0 |        1 |
| `skastr0/fractals`        |       2 | The maintainer's session-list virtualization and render-churn commits                                                                |        1 |            2 |       16 |

A deletion that stops subscribing to a lazily synced store, such as a `synced()` persisted store, is non-enforced: the
subscription is what activates the load, so a later `peek()` can read the default instead of the persisted value.

For every supplied repository, the runner extracts the parent tree from the checkout's object store with `git archive`
into a temporary directory, scans its source root, and prints `Expert replay recall: x/y`: enforced cases where a
proven `change` finding at the labeled line carries the expert's action or a listed equivalent. Recall on September 28,
2026 is 23/63; on October 1, with 21 enforced labels from new expert commits, it is 22/84. Each miss names what the
analyzer reported there, including abstention reasons, subscription-inventory blockers, and the gate at which the
targeted rule abstained (`ruleGates`). Non-enforced cases are reported separately
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
also cover the retry loop an observer starts when a loader it calls reads an observable before its first `await`, and
they run in `npm test`.

### Scan budgets

Scoring scans focused targets, often single files under one shared source index, so it never analyzes a whole
application. A cost that grows with the number of scanned files can pass it unnoticed: #57 left scoring green while a
whole-app Expensify scan went from 20s to 229s and ran out of memory at Node's default heap.

The `Check whole-app scan budgets` step of the corpus job scans each pinned repository root in its own Node process,
one repository at a time, and fails a repository that runs out of heap or is killed at its time limit. The limits live
in `evals/performance-budgets.ts`:

- **Heap:** `--max-old-space-size=4096`, Node's default on a 16 GB host, pinned so every machine enforces the same cap.
  Expensify has the least headroom: on Node 22 it passes at 3328 MiB and runs out of memory at 3072 MiB.
- **Time:** three times the repository's CI baseline, never below 60 seconds. The analyzer exposes no deterministic work
  counter, so wall time with that margin stands in for one.

Baselines come from CI run 36409722431 on ubuntu-latest (4 CPUs, 16 GB) with the analyzer at 51f2d32, and for gptme,
zenborg, and junto from CI run 36444683516 at c478731:

| Repository                | Baseline | Limit |
| ------------------------- | -------: | ----: |
| `expensify`               |    47.6s |  143s |
| `formbricks`              |    15.0s |   60s |
| `junto`                   |    13.6s |   60s |
| `legend-apps`             |     9.2s |   60s |
| `outline`                 |     6.1s |   60s |
| `noutube`                 |     4.5s |   60s |
| `excalidraw`              |     4.2s |   60s |
| `gptme`                   |     3.9s |   60s |
| `zenborg`                 |     3.7s |   60s |
| `hoalu`                   |     3.4s |   60s |
| `open-webui-react-native` |     3.1s |   60s |
| `legend-music`            |     2.4s |   60s |
| `nori`                    |     2.2s |   60s |
| `fractals`                |     2.2s |   60s |
| `legend-photos`           |     1.2s |   60s |

Each scan prints its wall time, peak RSS, file count, and hook count, so the job log shows trends before a limit
trips. Run it locally with the same arguments as the eval:

```bash
node dist/evals/scan-budgets.js --complete --repo legend-music=/path/to/legend-music ...
```

When an analyzer change legitimately costs more, or a pin moves, take the new baselines from that PR's job log and
say in the PR why the cost is worth it. A new public repository needs a baseline too; the unit suite and the scan
step both fail without one.

## Changing the corpus

Read `AGENTS.md` first. When a detector changes, add a minimal adversarial fixture test and a manually audited label
from a pinned application. Keep uncertain opportunities as explicit `enforced: false` labels rather than weakening a
proof. Report action deltas for every application after each detector phase, including zero-change applications.

Candidate Legend practices are source reviews rather than optimization predictions. The runner lists
every candidate location separately, excludes candidates from practice precision, and does not let a
candidate satisfy an enforced optimization label. Unlabeled `change` and `style` practices still fail.
`evals/research/helper-tracking.json` keeps the manually audited, pinned, non-enforced research labels of the
retired `review-helper-tracking` review; they are not loaded into scored corpus totals.
