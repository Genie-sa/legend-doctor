# PR 17: before/after evidence

[PR #17](https://github.com/Genie-sa/legend-doctor/pull/17) compares the actual `main` snapshot
`57c8020e70d718eabe57472f1dc9e618d0901f6a` with implementation commit
`80db8f6168007beef2fa0037501167350ae79765`. Subsequent evidence-only changes do not change executable code or labels;
the exact final PR head is recorded in the PR description. The worktree started at
`378977306448c0fc3d0326dbc986f0f6e082b622`; comparison with the actual base showed only `README.md` changed upstream.
The base was independently checked out, installed, built, tested, and evaluated; results are not inferred solely
from the earlier research report.

Environment: Node **22.23.2**, macOS/arm64. Both versions used the same seven clean source pins listed in
[audit-2026-09-19.md](audit-2026-09-19.md). The head also evaluated freshly downloaded checkouts using the exact CI
workflow scripts, without installing application dependencies. Hosted Actions cache behavior is separate from these
local runs. This PR changes selection/coverage reporting and two source-audited labels, not rendering behavior;
there are no new render, selector-execution, duration, or native-performance measurements.

## Actual CLI comparisons

| Identical scenario                                | Actual base                                                         | Implementation head                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `--repo typo=/tmp`                                | Exit **0**, zero targets, 100% precision and recall.                | Exit **1**, unknown repository diagnostic, no metrics.                                       |
| `--complete --repo open-webui-react-native=<pin>` | Exit **0**, flag ignored, 5 hooks/3 targets, no omissions reported. | Exit **1**, lists all six omitted repositories and fails before analysis.                    |
| `--partial --repo open-webui-react-native=<pin>`  | Subset was allowed with no explicit mode/omission disclosure.       | Exit **0**, 1/7 repositories, every omission named, 5 hooks/3 targets.                       |
| All seven valid pins                              | Exit **1**, 1,236 hooks/237 targets, seven existing failures.       | Exit **1**, identical predictions, five existing failures after two audited label additions. |
| Full quality command                              | `npm run check` passes: **978 tests**.                              | `npm run check` passes: **987 tests**.                                                       |

The three targeted CLI regression tests fail against the actual base. They pass against the head. A separate
counterfactual replacing `fileURLToPath` with `URL.pathname` makes the spaced/hash/non-ASCII entry-path regression
fail; the mutation was restored. Tests also cover missing/empty/invalid option values, exact repository names,
duplicates, both conflicting-mode orders, missing filesystem paths, off-pin zero-target runs in both modes,
private-slice completeness, paths containing equals, repeated same mode, argument ordering, and caller-array
preservation. These cases do not claim exhaustive coverage of all Git/network failures or all possible inputs.

## All seven application deltas

Hook and practice **action × disposition** inventories are unchanged. Every listed app has zero additions,
removals, action changes, and disposition changes. The two extra gold labels affect scoring only in Legend Music.

| App                     | Hooks / targets | Hook change/candidate/keep, before = after | Practice change/style, before = after | Action delta | Disposition delta |
| ----------------------- | --------------- | ------------------------------------------ | ------------------------------------- | ------------ | ----------------- |
| legend-music            | 51 / 1          | 14 / 18 / 19                               | 49 / 2                                | 0            | 0                 |
| excalidraw              | 186 / 2         | 8 / 93 / 85                                | 0 / 0                                 | 0            | 0                 |
| expensify               | 345 / 95        | 66 / 188 / 91                              | 0 / 0                                 | 0            | 0                 |
| formbricks              | 422 / 90        | 127 / 253 / 42                             | 0 / 0                                 | 0            | 0                 |
| outline                 | 150 / 45        | 22 / 80 / 48                               | 0 / 0                                 | 0            | 0                 |
| open-webui-react-native | 5 / 3           | 3 / 1 / 1                                  | 3 / 0                                 | 0            | 0                 |
| hoalu                   | 77 / 1          | 8 / 55 / 14                                | 15 / 0                                | 0            | 0                 |

Practice matches change **67/71 → 69/73** and practice precision **67/69 → 69/69** because the GeneralSettings error
boundary and VisualizerWindow bin-count boundaries received independent source-audited labels. No detector improved
or changed its output. Hook matches remain **508/523**, known non-enforced misses **15**, grouped matches **10/10**,
and unscored changes **31/248**. All 31 unscored changes have individual audit-ledger entries; no bulk relabeling was
performed.

## Merge blockers and evidence

The new complete-corpus gate remains red on **five pre-existing failures**, so the PR must remain unmerged:
Outline's copying diagnostic, PlaybackArea's two missing relocation recommendations, VisualizerWindow's playback
relocation, and Hoalu's kind-filter relocation. The audit ledger explains the exact structural helper/dependency
proofs still missing. Two source-supported label gaps were corrected in their own commit; no correct expectation,
pin, scoring rule, or gate was weakened. The pre-existing Radix state-ownership defect in ledger U28 remains a
separate detector follow-up, supported by pinned source and a minimal reproduction sketch rather than a claimed
executed Radix runtime test.

Local raw evidence is preserved at
`/Users/alialdhamen/.codex/artifacts/legend-doctor-pr17-evidence-2026-09-19/`: base/head quality logs, CLI comparisons,
full-corpus outputs, before/after target inventories, counterfactual test output, exact-pin download output,
Legend Music Doctor comparisons, and small executed proof-gap probes. Reproduce the full run with the seven
`--repo` paths in [README.md](README.md); use `--complete` on the new runner. Unit/runtime reproduction is
`npm run check` on each compared commit. Final remote checks and final head SHA are linked in the PR description.
