# Open-work validation

Detector-phase baseline: `164e22d`. The PR branch also includes main at `618b97d` (PR #8); the complete checks and pinned corpus were rerun after incorporating it. All seven public corpus repositories were checked at their existing pins. The baseline unit suite and corpus passed before edits.

## Risk ledger

| Risk       | Evidence and trigger                                                          | Protected contract / plausible defect                                                                     | Test surface and status                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| C1-R, high | A command writes a ref and unread state                                       | Removing the state update must not freeze displayed ref data                                              | `render-purpose.test.ts`: named state, literal/self-read updates, direct/computed ref reads, aliases, helper calls, and an attribute; covered |
| C1-N       | A ref is used only by a command                                               | A deferred ref read alone must not block unused-state deletion                                            | `render-purpose.test.ts` positive control; covered                                                                                            |
| C2-I, high | Initializer differs from the effect's derived input                           | Deletion must preserve the initial committed value                                                        | `derived-mount-capture.test.ts`; covered                                                                                                      |
| C2-M, high | A keyed child captures a prop or children through state, ref, or mount effect | Matching initializers alone must not justify deleting the intermediate commit                             | `derived-mount-capture.test.ts`; covered, including nested JSX children                                                                       |
| C2-H, high | A keyed input captures defaults, or state controls an element gate            | Host mount inputs and conditional mounts must retain timing                                               | `derived-mount-capture.test.ts`; covered                                                                                                      |
| Q1-L       | Twenty-four render sites, on separate lines or one line, need the same check  | No silent truncation or repeated instruction; retain all lines and total sites                            | `review-assumptions.test.ts`; covered                                                                                                         |
| Q2-X, high | An exception occurs before or after a write                                   | Catch lowering must retain partial try writes, without treating try/catch as interchangeable control arms | `state-flow-boundaries.test.ts`; covered                                                                                                      |
| Q2-F, high | Return/throw passes through finally                                           | Finally executes, then preserves or overrides the pending termination                                     | `state-flow-boundaries.test.ts`; covered                                                                                                      |
| Q2-A, high | Writes are separated by await                                                 | Asynchronous epochs must not be declared synchronous                                                      | `state-flow-boundaries.test.ts`; covered                                                                                                      |
| Q2-H, high | A validation helper hides a companion setter before try                       | Better try coverage must not turn missing helper knowledge into a false negative                          | `async-command-boundaries.test.ts` and pinned CreateAttributeModal label; covered                                                             |
| Q3-P, high | An expression-bodied arrow contains 7/8/9/20 independent conditionals         | At most 128 paths may support a proof; truncation returns unknown                                         | `state-flow-boundaries.test.ts`; covered                                                                                                      |
| Q4-G       | The first group member remains blocked, another converts                      | Ranked group outcome and conversion count must reflect the whole group                                    | `review-assumptions.test.ts`; covered                                                                                                         |
| Q5-O       | A small owner has the same broad and compact outcome                          | Unchanged changes and keeps must not carry compact provenance                                             | `materiality-tier.test.ts`; covered                                                                                                           |
| Q5-C       | A zero-JSX hook has a compact or broad consumer                               | Provenance must follow the consumer threshold, not the hook owner's JSX count                             | `hook-consumer-leaf.test.ts`, real cross-file scans; covered                                                                                  |
| Q6-C       | Public JSON reports analysis stages                                           | Coverage must describe stages with actual consumers; incompatible field removal must be versioned         | CLI JSON and coverage-ledger tests; covered                                                                                                   |

The tests assert analyzer findings, complete research locations, flow outcomes, or the public JSON contract. Runtime migration tests already in the repository also run in the full unit suite. No live application was modified or executed.

## Decisions and limits

- C1 gates deletion/ref conversion on mutable render reads, including local helpers and rendered aliases. It deliberately abstains on unproven render-time calls and indexed data.
- C2 requires a matching transparent initializer and direct live text consumers. Attribute consumers, custom-component ancestors (including children), projected aliases, and element gates remain conservative instead of assuming a child never captures a value.
- Eight previous opportunities remain explicit non-enforced labels. Their command-only value usage is established, but independent refresh of the rest of the rendered output is not. No detector uses application names or path exceptions.
- Q2 keeps loops and hidden helper writes uncertain. Exception paths are bounded overapproximations; it does not attempt a general exception-aware CFG or predicate solver.
- Q5 preserves compact mode. It compares final actions and confirmable outcomes using the already-parsed source under both policies. This also handles alternative proofs and consumer-size gates; it adds a second analysis pass in compact mode.
- Q6 removes the 434-line unused semantic implementation and its orphan tests. Contrary to the attachment's absolute claim, this checkout did export a programmatic tsconfig path; the actual missing piece was a detector consumer. Report schema 4 and coverage schema 2 document the removal. Imported-hook escape resolution remains future work.

## Validation results

- `npm run check` passed: lint, formatting, typecheck, build, the complete unit/runtime suite, and package dry run.
- Full pinned corpus: 1,236 hooks across 237 targets; all enforced labels pass. Labeled actionable precision is 230/230 (100%); recall is 230/246 (93.5%). Sixteen non-enforced misses remain, eight pre-existing and eight retained after the new render-purpose guard.
- All 71 practice labels and 10 grouped-instruction labels pass. There are still 31 unlabelled change findings out of 247; these are **not precision-scored**.
- Legend Doctor ran on `src` before edits and after validation. Both scans completed; the analyzer implementation itself has no React hooks.
- Compact benchmark: one warmup followed by three alternating scans of pinned Legend Music (51 hooks). Broad: 191/187/197 ms; compact: 269/246/241 ms. Medians: 191 vs 246 ms, about 29% more scan time. This is a small representative measurement, not a scan-time guarantee.

Counterfactual evidence:

- C1, C2, Q3, Q4, and Q5 reproductions failed before their fixes. C2 also reproduced host-default and children-prop capture before those guards were added.
- Q1's 24-site checklist and Q5's unchanged-outcome tests fail against the isolated baseline build. The new JSON contract test also fails against that build.
- Replacing catch prefixes with only the incoming events makes the partial-write test fail.
- Replacing the true research-site total with the number of distinct lines makes the same-line case fail.
- Mutations were confined to disposable compiled output and restored immediately. The normal code passed the complete suite afterward.

## Action deltas by app

Every cell counts changed hook actions, including linked effect findings. The reporting-only changes Q1/Q4/Q5/Q6 and the Q3 cap changed no broad-mode corpus actions in any app. The final C1 column includes its later alias-read guard.

| App                     | C1                                                             | C2                                                                     | Q2                              | Q1 / Q3 / Q4 / Q5 / Q6 |
| ----------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------- | ---------------------- |
| Excalidraw              | 1 use-ref → review-state                                       | 0                                                                      | 0                               | 0                      |
| Expensify               | 4 use-ref → review-state; 1 keep-effect → review-effect        | 1 delete-derived-state → review-state; 1 delete-effect → review-effect | 0                               | 0                      |
| Formbricks              | 3 use-ref → review-state; 1 delete-unused-state → review-state | 1 delete-derived-state → use-observable; 1 delete-effect → keep-effect | 1 review-state → use-observable | 0                      |
| Hoalu                   | 0                                                              | 0                                                                      | 0                               | 0                      |
| Legend Music            | 2 delete-unused-state → review-state                           | 0                                                                      | 0                               | 0                      |
| Open WebUI React Native | 0                                                              | 0                                                                      | 0                               | 0                      |
| Outline                 | 1 use-ref → review-state                                       | 0                                                                      | 0                               | 0                      |

Overall: 261 → 247 `change`, 675 → 689 `candidate`, and 300 → 300 `keep` findings. The newly proven Q2 conversion is WebhookSettingsTab's `endpointAccessible`, now manually labeled; its success and catch paths preserve paired writes with `hittingEndpoint`.

Per-phase corpus runs were saved for C1, C2, Q3, Q2, and the final implementation. C2's initial audit found a valid observable alternative in SurveyMenuBar, and Q2's initial audit found the hidden validation-helper regression; both were resolved before handoff. No pins, target inventories, or scoring policies were weakened.
