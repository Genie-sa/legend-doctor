# Derived migration: PR before/after evidence

- Actual PR base: `57c8020e70d718eabe57472f1dc9e618d0901f6a` (`main`).
- Tested implementation: `467d96ba7af161046232db44debc20525101ee64`.
- The final PR head adds this evidence document without changing executable files; its exact
  SHA is recorded in the PR description.
- Audited starting point: `378977306448c0fc3d0326dbc986f0f6e082b622`. Git confirms that
  only `README.md` changed between that commit and the actual PR base. Detector, tests,
  dependency locks, and corpus/scoring sources are identical, so the original full-corpus
  baseline applies to the actual base. Its quality suite was also rerun directly.

## Analyzer behavior

The same fixtures were executed against builds of the actual base and tested implementation.
All findings below have action `derive-computed-observable`.

| Source case                                                         | Base disposition | Head disposition |
| ------------------------------------------------------------------- | ---------------- | ---------------- |
| `id === helper()` where helper reads another observable             | change           | candidate        |
| `id + "!"`                                                          | change           | candidate        |
| Pure local JSX owner, stable string observable, `id === "selected"` | change           | change           |
| Same comparison, owner effect publishes `active$.peek()`            | change           | candidate        |
| Lowercase function used as `<row />`                                | change           | candidate        |
| Explicit custom JSX factory directive                               | change           | candidate        |

The hidden-helper runtime counterexample changes visible output after only the hidden
observable changes. The owner-effect counterexample skips a commit publication and leaves
a ref snapshot stale even though its comparison remains false. Both run in normal mode and
StrictMode. These are source-program versus previously suggested migration witnesses;
Legend Doctor itself remains read-only.

## Runtime work, measured separately

Same scenario: `a → b → c → d`, excluding mount. React 19.2.8, Legend State
3.0.0-beta.48, Node 22.23.2, jsdom, macOS arm64. Outputs match at every step.

| Projection    | StrictMode | Memo owner renders → computed owner renders | Memo callback evaluations → computed projection evaluations |
| ------------- | ---------- | ------------------------------------------- | ----------------------------------------------------------- |
| String suffix | off        | 3 → 3                                       | 3 → 3                                                       |
| `id === "a"`  | off        | 3 → 1                                       | 3 → 3                                                       |
| String suffix | on         | 6 → 6                                       | 6 → 3                                                       |
| `id === "a"`  | on         | 6 → 2                                       | 6 → 3                                                       |

Computed projection executions are counted; internal direct-`useValue` selector reads are
not instrumented. Callback/render durations and native work were not measured. The suffix
has no render saving in this scenario, even though StrictMode executes fewer computation
callbacks after migration. No device-performance or universal-speedup claim follows.

## Validation and corpus deltas

| Check                               | Actual base                               | Final implementation                  |
| ----------------------------------- | ----------------------------------------- | ------------------------------------- |
| `npm run check`, Node 22.23.2       | pass, 978 tests                           | pass, 1,004 tests                     |
| Final scoped detector/runtime suite | unsafe probes reproduced                  | pass, 32 tests                        |
| Full pinned corpus                  | 1,236 hooks / 237 targets, seven failures | identical output, same seven failures |
| Doctor on analyzer `src --coverage` | scan succeeds                             | scan succeeds                         |

| App                     | Action delta, all actions | Disposition delta: change / candidate / keep / style |
| ----------------------- | ------------------------- | ---------------------------------------------------- |
| Legend Music            | 0                         | 0 / 0 / 0 / 0                                        |
| Excalidraw              | 0                         | 0 / 0 / 0 / 0                                        |
| Expensify               | 0                         | 0 / 0 / 0 / 0                                        |
| Formbricks              | 0                         | 0 / 0 / 0 / 0                                        |
| Outline                 | 0                         | 0 / 0 / 0 / 0                                        |
| Open WebUI React Native | 0                         | 0 / 0 / 0 / 0                                        |
| Hoalu                   | 0                         | 0 / 0 / 0 / 0                                        |

Remaining corpus failures: Outline DocumentCopy's abstention reason; missing relocation
practices at Legend Music PlaybackArea:29/:31 and VisualizerWindow:13 and Hoalu
expense-filter-dropdown:67; unexpected relocation practices at Legend Music
GeneralSettings:16 and VisualizerWindow:15. No scored labels, pins, or gates changed.

See [proof boundary and deep-test ledger](derived-migration-proofs.md) for accepted/rejected/
unknown cases and residual integration limits. Repro scripts, source fixtures, runtime JSON,
quality logs, and both corpus logs are retained in
`/Users/alialdhamen/.codex/artifacts/derived-migration-proofs-2026-09-19/`.
