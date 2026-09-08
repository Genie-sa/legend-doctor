# Full branch review

Reviewed all five branch commits from `main` (`fabc583`) through `c7a1afc`,
including the merged subscription work and both preceding safety-fix commits.
The review fixes below are applied on top; the separate three-app experiment
was not merged.

## Standards

Two confirmed P1 defects were fixed.

- Subscription relocation checked mutable values rendered as children, but skipped
  JSX props and spreads. Both now receive the same snapshot check. The existing
  primitive-flow proof still accepts safe conversions such as `String(number)`.
  Existing command-only callback proofs retain their scope.
- Stable effect dependencies could be reassigned by destructuring or loop targets.
  The proof now follows structural assignment targets, including defaults and
  rest patterns, without confusing property receivers, keys, or RHS reads with
  rebinding.

## Spec

No additional confirmed defect in the reviewed transition, confirmation, report,
CLI, measurement, packaging, or representative runtime interactions. Transition
evidence remains descriptive; confirmation cannot bypass per-member blockers;
partial report filtering cannot retain whole-plan runtime measurements.

Standards: two findings fixed (worst P1). Spec: zero new confirmed findings.
This is a bounded review, not a claim that every possible program is supported.

## Regression evidence

| Risk                                     | Protected behavior                                           | Evidence                                                                                |
| ---------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Mutable snapshots in props/spreads       | Subscription removal must not stop updating a sibling's prop | Two fixtures failed before the fix                                                      |
| Destructuring or loop rebinding          | Effect dependencies must retain their render-driven changes  | Six new fixtures failed before the fix; nested/default and read-only controls also pass |
| Command-only callback regressions        | Preserve existing callback handling across earlier commits   | Five existing tests exposed an overbroad first attempt and pass with the scoped fix     |
| Primitive conversion incorrectly blocked | Keep proven primitive subscription flows actionable          | Existing `String(number)` positive control passes                                       |

## Validation

`npm run check` passes: lint, formatting, typecheck, build, **947 tests**, and
package dry-run. The final Doctor scan of `src` has no findings or practices.
Node 22 and Node 24 also pass all 947 tests with concurrency limited to two files. The first Node 22
parallel run had timeout cancellations under interrupted/high-load execution,
without assertion failures; that run is not counted as a pass.

The unchanged full public/private corpus inventories **2,428 hooks across 246
targets and 14 apps**. There are **11 discrepancies**, versus seven at the start
of this review and three on main using main's own labels. Existing label changes
in the earlier branch commits mean label scores across main and this branch are
not directly interchangeable. No eval targets, labels, or scoring were modified
by this review.

Hook actions are unchanged by these fixes: 877/896 hook labels, 30/30 grouped
instructions, 471/471 labeled actionable precision, and 471/490 recall. Legend
practice matches are 100/109. The corpus command exits nonzero.

Four additional conservative withdrawals are all in Legend Music: OverlaySettings
line 28, PlaybackArea lines 29 and 31, and VisualizerWindow line 13. Their prop
expressions need stronger proofs for independent observable instances, unrelated
primitive conversions, or imported helpers. No application-name exception or
weakened purity assumption was introduced to recover these suggestions.

| Public app              | Action delta from main                                     | Delta from review start |
| ----------------------- | ---------------------------------------------------------- | ----------------------- |
| Legend Music            | move-use-value-down -1                                     | move-use-value-down -4  |
| Excalidraw              | 0                                                          | 0                       |
| Expensify               | 0                                                          | 0                       |
| Formbricks              | 0                                                          | 0                       |
| Outline                 | 0                                                          | 0                       |
| Open WebUI React Native | 0                                                          | 0                       |
| Hoalu                   | use-observable +1; review-state -1; move-use-value-down -1 | 0                       |

All seven private apps have zero action deltas in this review. Relative to main,
one private app has three withdrawn subscription suggestions; the other six are
unchanged. The local review artifact records every private app separately.

The PR remains a draft because the unchanged corpus is not green and the
conservative coverage gaps still need source-backed proofs.
