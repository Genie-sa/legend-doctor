# Subscription measurement evidence

PR base: `57c8020e70d718eabe57472f1dc9e618d0901f6a` (`main`).
Implementation: `b99b67721370c3aa169e9bc3218aa38728e13c51`.
The PR description records its final head, including this evidence-only addition.
The base differs from audited `378977306448c0fc3d0326dbc986f0f6e082b622` only in `README.md`;
source, dependencies, tests, corpus and CI were verified identical.

## Actual base versus implementation

The new compiled measurement tests were executed against the actual base's compiled modules,
using Node 22.23.2. Six failed and one compatibility control passed; all seven pass on the implementation.
This compares the same assertions and inputs against both implementations, not two different expected outputs.

| Case                                   | Base behavior                                          | Implemented behavior                                                       |
| -------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| Optional costs and provenance          | Discarded from supplied records                        | Preserved on file and programmatic paths                                   |
| Malformed optional costs or provenance | Ignored; record can attach                             | Rejected; later valid record remains eligible                              |
| Incompatible environments/scenarios    | Compared as render savings                             | Evidence retained, whole batch ordered by static cut                       |
| Saved renders near safe-integer limit  | Two savings can round to one and rank below 1.5/sample | Exact count differences and rational comparison preserve the correct order |
| Close per-sample ratios                | Floating division can erase their ordering             | Integer cross-products preserve ordering and exact ties                    |
| Stale/unmatched/duplicate records      | Rejected                                               | Rejection retained; rejected provenance cannot affect ranking              |

The arithmetic reproduction uses before `{ownerRenders: MAX_SAFE_INTEGER, siblingRenders: 2}`
and after `{ownerRenders: MAX_SAFE_INTEGER, siblingRenders: 0}`: exactly two saved renders.
A competing record saves three renders over two samples. Base ranks that 1.5/sample record first;
the implementation correctly ranks two/sample first.

## Test coverage ledger

| Boundary                 | Covered cases                                                                                                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted optional fields | All eight field subsets; provenance-only; legacy records; measured zero; maximum safe count; finite duration extremes; absent metrics stay absent; unknown metadata ignored                                                                                             |
| Rejected costs           | Each field on both sides: null, booleans, strings, objects, arrays, negatives, nonfinite values; fractional/unsafe counts; asymmetric presence                                                                                                                          |
| Provenance/envelopes     | Every required string missing, malformed or blank; invalid JSON/non-array envelope; invalid entry followed by valid entry; missing file; real directory read error propagates; supplied empty list overrides file                                                       |
| Ranking/ownership        | Every provenance dimension and scenario; mixed legacy/provenance; input-order control; normalized samples; exact ties; near-limit differences and ratios; first valid duplicate wins; stale/unmatched entries; caller input unchanged; reattachment clears old evidence |
| Runtime                  | Normal and StrictMode; 100 rows; equal writes; atomic batched writes; visible selection; host identity; cleanup after unmount; observed selectors and monotonic durations                                                                                               |

Counterfactuals: original parser/ranker fail the new tests; a raw-subscription runtime mutant fails
both rendering modes. Targeted mutants dropping metrics, accepting negative durations, swallowing
file errors, and overwriting duplicates each fail their designated test. Restored implementations pass.
The large-count test was observed failing before the arithmetic fix.

These cases cover the identified measurement contract risks, not every possible input or runtime schedule.
No detector, alias proof, callback timing proof, corpus label/scoring, or CI policy changed.
Native errors, focus/keyboard/layout behavior and device performance remain unvalidated; see
[the concrete native setup](../../REPORT.md#native-validation-setup-and-remaining-limitation).

## Observed runtime diagnostic

The probe compares raw versus selected subscriptions; the PR adds measurement coverage, not a detector
migration or a claim that the PR itself accelerates the application. One update changes selection 0 → 1
across 100 rows, excluding mount. Same process and scenario, Node 22.23.2, darwin arm64, React 19.2.8,
Legend State 3.0.0-beta.48, jsdom 26.1.0, development rendering. `performance.now()` instruments selectors
and the scenario through React `act` completion. One observed run, milliseconds rounded below:

| Mode / implementation | Row renders | Selector executions | Selector ms | Scenario ms |
| --------------------- | ----------: | ------------------: | ----------: | ----------: |
| Normal / raw          |         100 |                   0 |           0 |      24.972 |
| Normal / selected     |           2 |                 102 |       0.030 |       1.199 |
| StrictMode / raw      |         200 |                   0 |           0 |       5.567 |
| StrictMode / selected |           4 |                 104 |       0.084 |       2.935 |

Durations are noisy diagnostics with instrumentation overhead, not benchmark thresholds or native timing.
Scenario time includes selector work; do not add the duration columns. No callback selector on the raw
side does not mean there is no library subscription work. Provenance and `behaviorEquivalent` remain
caller assertions; the existing fingerprint does not attest external dependencies or runtime settings.

## Validation and corpus deltas

Node 22.23.2: full `npm run check` passes on base (978 tests) and implementation (987 tests).
Doctor `src --coverage` completes with zero findings on the implementation; this source scan is not a
React correctness proof. Full seven-app scoring accepts all pins, inventories 1,236 hooks / 237 targets,
and retains the same seven failures: one Outline abstention reason, three missing Legend Music practices,
one missing Hoalu practice, and two unexpected Legend Music practices. Scored output is byte-identical.

| Application             | Every action/disposition delta |
| ----------------------- | -----------------------------: |
| Legend Music            |                              0 |
| Excalidraw              |                              0 |
| Expensify               |                              0 |
| Formbricks              |                              0 |
| Outline                 |                              0 |
| Open WebUI React Native |                              0 |
| Hoalu                   |                              0 |

Reproduce with `npm run check`, `npm run eval:runtime`, and the full seven `--repo` assignments documented
in [evals/README.md](../../evals/README.md). To reproduce the base counterfactual, build both checkouts,
copy the head's compiled `subscription-cost*.test.js` into the base's matching `dist/tests/project/analyze-path`
directory, and run those tests there. Do not rebuild the base after copying; its build clears `dist`.
