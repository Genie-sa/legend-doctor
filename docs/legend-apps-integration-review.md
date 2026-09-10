# Legend Apps integration review

Base: `c7864f639104823f1c868c2da4b529cbce3d9bb0`. This branch combines the source-context,
selector-equality, and helper-tracking tasks, then applies independent standards, spec, and
Legend State contract reviews. The research source is `LegendApp/legend-apps` at
`4744fb8b57026a645379e826fe8ab34861f43017` (Diff, Chat History, and Music).

## Integrated behavior

- Detailed coverage reports unavailable imported implementation edges without changing resolution
  precedence or claiming a missed optimization. Factory composition remains deferred.
- Same-value direct selectors and retained literal splitting are style suggestions. They do not
  establish a render saving. Async inputs, unproven option forwarding, prototype setters, omitted
  dependencies and reordered reads retain their original code.
- One synchronous local helper can produce an explicit dependency-review candidate. Candidates are
  hidden from actionable output, listed separately in evaluations, and cannot satisfy scored labels.
  Imported helpers and deeper call chains remain outside this phase.
- Scored practice labels can assert disposition. The combined regression test ensures candidate
  exclusion still works when a style prediction shares its action and source location.
- Public examples and the packaged Legend Doctor skill describe the limits and source-reading steps.

## Standards

The independent standards review found two new proof defects: optional/short-circuit execution was
counted unconditionally, and labeled exits allowed unreachable reads into helper summaries. Both
are resolved by structural abstention with adversarial caller/helper fixtures. Explicit throws and
unproven local initialization also invalidate the summary. No application-name or path exceptions
were introduced. The source-coverage phase preserved resolution precedence and passed its separate
adversarial controls. No additional maintainability blocker was reported.

## Spec

The independent spec review found four corrective areas: async selector equivalence, prototype-setting
literal properties, unreachable/uninitialized helper execution, and reversed ancestor coverage.
All are addressed. A direct parent read covers a helper child; a helper parent can add sibling
subscriptions beyond a direct child. Additional source review identified options-forwarding and
literal evaluation-order defects, which now cause abstention. Observer-context wording describes
selected values without claiming identical subscription ownership.

## Source and runtime evidence

[Legend State contract review](source-context/legend-contract-review.md) links official v3 docs,
identifies actual beta.47 and beta.48 implementation symbols, and records independent runtime
counterexamples and controls. Core observer probes and ReactDOM checks establish the tested
contracts; they do not certify native apps, all library versions, or general scheduling equivalence.

Pinned labels remain auditable and separate from synthetic counterexamples:
[source coverage](source-context/pinned-labels.json),
[equality](../evals/research/equality-contract.json), and
[helper tracking](../evals/research/helper-tracking.json).
Uncertain research labels are non-enforced and do not inflate scored coverage.

## Validation

- `npm run check`: lint, formatting, typecheck, build, **978/978 tests**, and package dry run pass.
- Independent integrated analyzer matrix: **15/15** targeted source-contract expectations pass.
- Full public corpus: **237 targets**, **1,236 hooks**, **508/523 hook labels**, **4/4 questions**,
  **10/10 groups**, **67/71 practice labels**, **67/69 practice precision**. Candidate reviews: zero
  on these pinned targets. The evaluator exits **1** for the same seven pre-existing mismatches,
  verified against the baseline output; no new mismatch was introduced. The original list remains in
  [source-phase validation](source-context/implementation.md#validation).
- Baseline source was verified byte-for-byte against all **363 tracked `src`/`evals` files** at the
  base commit before comparing complete reports. All pins were checked by the corpus evaluator.
- Doctor on `src --coverage`: **0 findings / 0 practices before and after**. Source inventory grows
  from 326 to 329 files. Builds recorded: `07d195c5617488b2` before, `c97af4f9870e2495` after.

[Every action/disposition delta](source-context/integration-action-deltas.json) includes zero changes.

| Application             | Entries before | Entries after | Action/disposition change                |
| ----------------------- | -------------: | ------------: | ---------------------------------------- |
| legend-music            |            102 |           102 | Two direct selectors: `change` → `style` |
| excalidraw              |            186 |           186 | 0                                        |
| expensify               |            345 |           345 | 0                                        |
| formbricks              |            422 |           422 | 0                                        |
| outline                 |            150 |           150 | 0                                        |
| open-webui-react-native |              8 |             8 | 0                                        |
| hoalu                   |             92 |            92 | 0                                        |

Standards: two initial blocking findings resolved. Spec: four initial corrective areas resolved.
The independent final contract review reported no remaining blocking semantic defect within scope.
The baseline corpus remains imperfect; this is a regression comparison, not a universal correctness claim.
