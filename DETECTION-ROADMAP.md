# Detection and review research

Implementation priorities are now narrowed in [OPTIMIZATION-STRATEGY.md](OPTIMIZATION-STRATEGY.md).
This document preserves the broader investigation and backlog.

Audited 2026-09-08 against the public repositories and commits in `evals/corpus/*/repository.ts`.
These are measured findings and proposed proof work, not a claim that the remaining migrations are safe.

## What the baseline actually says

The full public corpus inventories 1,236 hooks across 237 targets. It has 667 abstentions, including
525 state reviews. Of those state reviews, 328 carry a question and 197 have no supported question.
The baseline matches 507/523 manually labeled hooks, with 16 explicitly non-enforced misses.
Labeled actionable precision is 100% (230/230), and recall is 93.5% (230/246). Practice precision is
100% (71/71). There are also 31 unlabeled change findings, so the labeled precision number does not
establish precision for every recommendation.

| App                     | State hooks | State reviews | Reviews with questions | Reviews without questions |
| ----------------------- | ----------: | ------------: | ---------------------: | ------------------------: |
| legend-music            |          32 |            15 |                      1 |                        14 |
| excalidraw              |          82 |            59 |                     25 |                        34 |
| expensify               |         213 |           135 |                     61 |                        74 |
| formbricks              |         343 |           211 |                    175 |                        36 |
| outline                 |          82 |            59 |                     32 |                        27 |
| open-webui-react-native |           4 |             1 |                      1 |                         0 |
| hoalu                   |          53 |            45 |                     33 |                        12 |

The largest abstention reasons across state and effect findings are atomic transitions (208), effect
write ownership (115), render cuts (78), child contracts (65), effect causal ownership (59), unresolved
value/setter flow (46), mount identity (34), and callback timing (19). These counts are primary reasons:
one state may have more than one missing proof, so they must not be added as independent opportunities.

## Implemented in this investigation

1. A structural event contract for Base UI `mergeProps` feeding a directly returned `useRender` with
   a default DOM tag. The imports must resolve syntactically to the actual utility exports. Only event
   fields qualify. Render overrides, unknown caller spreads, eager merge functions, escaped props,
   shadowing, mutable defaults, and unsupported options cannot borrow the contract.
2. A distinct `async-command-origin-unresolved` reason. Previously an async pending interval with no
   deferred reads could get a question about taking `.peek()` snapshots of nonexistent deferred reads.
   Eligible commands now ask about the actual JSX callback origins. A known direct render invocation
   cannot receive that question. A confirmed answer uses the existing proven async-status instruction.
3. Structured review guidance: `confirm`, `recheck`, `declined`, `dependency`, `unsupported`,
   `no-proven-benefit`, and `investigate`, each with known blockers and a next step. This does not
   upgrade dispositions or invent confidence percentages.

4. Workspace implementation closure. The scanner discovers declared workspace members, emulates
   missing same-name `workspace:*` links in memory, and lets TypeScript resolve their public exports.
   Only reachable implementation source enters the proof context; dependency hooks are not reported.
   Existing installed packages take precedence, duplicate package identities are ambiguous, declarations
   are excluded, parser-error files cannot supply contracts, and NodeNext export conditions follow
   the importing file's module mode.

The follow-up closes the package-source gap for `ReceiptScanner.isEncoding` in Hoalu. Its pinned app
manifest declares `@hoalu/ui: workspace:*`; the UI package exports `./button` to the audited TypeScript
implementation. The finding now becomes `use-observable`, and its manually audited label is enforced.
No app/component-name exception or relaxation of event timing was added.

Both detector phases were run against all seven pinned apps. Neither phase changes any hook or practice
action in the corpus. Phase two corrects the reason for 15 async reviews. The queue loses unsupported
generic questions and gains a precise question for an Outline submission status that previously had none:

| App                     | Phase 1 action delta | Phase 2 action delta | Corrected async reasons | Open question ids before → after |
| ----------------------- | -------------------: | -------------------: | ----------------------: | -------------------------------: |
| legend-music            |                    0 |                    0 |                       0 |                            1 → 1 |
| excalidraw              |                    0 |                    0 |                       0 |                          27 → 27 |
| expensify               |                    0 |                    0 |                       4 |                          55 → 54 |
| formbricks              |                    0 |                    0 |                       6 |                        141 → 138 |
| outline                 |                    0 |                    0 |                       4 |                          33 → 34 |
| open-webui-react-native |                    0 |                    0 |                       0 |                            1 → 1 |
| hoalu                   |                    0 |                    0 |                       1 |                          32 → 32 |

Question ids are deduplicated within each target and include effect questions; they are not the same
metric as state findings carrying an assumption. Before the workspace follow-up, review guidance covered all 667 reviews: 337
confirmable findings, 58 dependent findings, 252 requiring further investigation, 14 without proven
benefit, and 6 unsupported shapes. Recheck and declined states appear when users supply stale or
negative answers; the baseline corpus supplies no answers.

## Highest-value proof work

| Priority | Improvement                                         | Concrete evidence and proof needed                                                                                                                                                                           | Must reject                                                                                                                                       |
| -------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Workspace package source loading (implemented core) | Hoalu's declared `workspace:*` dependency and public export now resolve. Extend remaining workspace protocols only with explicit version/alias semantics.                                                    | Ambiguous packages, conditional exports selecting different code, out-of-workspace paths, declaration-only dependencies, arbitrary name matching. |
| 2        | Resolution diagnostics                              | Explain whether a child is outside the root, unresolved by TypeScript, external, declaration-only, cyclic, or beyond a budget.                                                                               | Reporting a failed resolution as a semantic contradiction.                                                                                        |
| 3        | Atomic transition segments                          | The largest blocker is co-written state. Split commands at await/Promise boundaries; prove every member and synchronous publication segment.                                                                 | Batching across await, moving writes across throws, dropping catch/finally states, assuming two same-handler writes are always atomic.            |
| 4        | Event wrappers with selected branches               | Outline's Button forwards into ActionButton, which has an action-dependent fallback and nested handlers. Trace prop presence and only branches proven reachable for this invocation.                         | Unknown `as`/`render`/action overrides, earlier spread overrides, callback invocation during render, hidden hook registrations.                   |
| 5        | Independent refresh witnesses                       | Several non-enforced `use-ref` labels are blocked because owner rendering reads mutable refs or imperative state. Prove an independent update refreshes each affected rendered value on every relevant path. | Merely finding another setter somewhere in the component, assuming all callbacks or exception paths co-write.                                     |
| 6        | Hook consumer closure                               | A zero-JSX custom hook can still invalidate a large caller. Follow every returned value and setter to consuming leaves and preserve one lifetime per hook invocation.                                        | Public consumers outside the analysis closure, cached shared ownership, conditional hook instances, hidden consumers.                             |
| 7        | Effect producer versus consumer graphs              | Keep detached producer effects with unchanged dependencies while moving only the target state. Track render, event, and effect edges separately.                                                             | Replacing state dependencies with `.peek()` while silently stopping effect rescheduling.                                                          |
| 8        | Bounded pure projection propagation                 | Follow immutable derived bindings into leaf sites, with actual callee provenance and explicit budgets.                                                                                                       | Assuming a method named `get`, `map`, or `toString` is pure solely because of its name; getters, mutable aliases, identity-sensitive consumers.   |

## More Legend-specific detection ideas

These are proposed extensions. Existing detectors already cover portions of several families; extend
their proof inputs instead of introducing competing recommendations for the same source.

9. **Subscription ownership across custom hooks.** Follow hooks returning `useValue` snapshots into
   broad owners. Recommend returning the observable only when all consumers can subscribe at their
   actual leaves and no API consumer depends on the snapshot return type or render timing.
10. **Selector field sets.** Derive the exact static fields used from a `useValue` result, including
    transparent aliases and destructuring. Keep a whole-object subscription when rest, serialization,
    identity comparisons, or unknown consumers observe more than those fields.
11. **List membership versus item content.** Distinguish writes that insert/reorder/delete rows from
    writes to one item field. An eventual `For` recommendation needs stable item identity, key mapping,
    and proof that callbacks do not capture an obsolete array index.
12. **Dynamic keyed reads.** Recognize record lookups driven by a separately subscribed key, preserving
    both the key subscription and the selected record subscription. Do not replace a changing key
    with a command-time snapshot.
13. **Computed versus once-only initialization.** Extend initializer analysis through source-resolved
    factories, distinguishing a computed function, a callable stored value, and a lazy owner snapshot.
    Installed Legend API behavior must remain part of the gate.
14. **Observable mirrors across helper boundaries.** Follow one authoritative observable through
    read/write helper pairs. Require equivalent write arguments, no independent React writes, and
    compatible subscription timing before deleting the mirror.
15. **Transactions hidden behind helpers.** Summarize source-resolved helpers' observable writes and
    make atomic recommendations for the complete affected group. Preserve order, exceptions, and
    parent/child path conflicts instead of merely counting adjacent calls.
16. **Snapshot consistency for commands.** Detect multiple `.peek()` reads separated by a write or
    await. A command-entry snapshot is appropriate only when its intended semantics require the same
    version; a polling or retry loop may deliberately require fresh values.
17. **Leaf extraction with parent inputs.** Distinguish static parent inputs from inputs that change
    independently of the observable. A wrapper must receive both correctly; moving a subscription
    must not freeze labels, permissions, locale, or a selected entity.
18. **React Compiler identity contracts.** Prove whether clone writes are protecting memoized object
    identity before proposing property writes or assignments. Compare behavior with compiler-enabled
    runtime fixtures; no global opt-out from identity preservation.
19. **Tracking-context propagation.** Classify calls reached from `observer`, `Computed`, selectors,
    `observe`, commands, and effects. `.get()` versus `.peek()` advice must follow the actual tracking
    context through helpers rather than the lexical location alone.
20. **External reaction cost proofs.** Recommend `useObserveEffect` only when the old subscription was
    used solely to trigger the reaction and the replacement preserves required commit ordering. If
    the same value renders elsewhere in the owner, moving the effect may remove no render.
21. **Persistent state migration contracts.** Connect persistence advice to successful state ownership
    migration, serialization semantics, hydration timing, and sync package availability. An effect
    that calls storage is not by itself evidence that `synced` is an equivalent replacement.
22. **Redundant observable construction.** Find equivalent per-render observable factories only when
    ownership and lifecycle prove one stable instance is intended. A global singleton is not a valid
    replacement for independent mounted editors or hook invocations.

## Make reviews progressively more useful

23. **Return all observed blockers from the proof pipeline.** The current field contains only reasons
    actually exposed by the verdict and its question. A future proof result should distinguish
    proven, contradicted, source-missing, unsupported, and budget-exhausted obligations, without
    pretending that rerunning one hypothetical establishes every other condition.
24. **Attach exact source edges.** Record the write, callback registration, forwarding prop, consumer,
    and final subscription site. For missing dependencies, name the unresolved import and requested
    analysis root rather than asking for a generic code review.
25. **Fingerprint the full proof dependency set.** Answers currently hash owner source. A changed child,
    callback helper, package version, or relevant config can invalidate an answer without changing
    that owner. Hash the exact dependencies a question researched; mark old answers stale on change.
26. **Progress through multi-fact questions.** Preserve separately researched facts and ask only the
    next unresolved obligation. Do not increase the current two-fact waiver cap to force a conversion.
    Group answers must keep per-member outcomes and atomic migration membership.
27. **Separate benefit, confidence, and review effort.** JSX size is a proxy for structural scope; setter
    site count is not runtime frequency. Show measured render savings separately from static cost,
    and rank research using transparent inputs rather than an invented probability of correctness.
28. **Group repeated missing contracts.** One audited button or hook contract may unblock many states.
    Group the research task by source dependency, but do not reuse an answer across distinct prop
    overrides, owner lifetimes, or callback argument paths.
29. **Explain retained boundaries.** Distinguish a proven useful React boundary from an analysis gap.
    Small controls, commit-sensitive effects, and state with same-value bailout do not become better
    because their owner changes to an observable.
30. **Expose filtered versus unsupported opportunities.** Report which reviews were hidden by
    `--actionable`, which APIs were disabled, and which sources were not loaded. These are different
    from a detector proving that no optimization exists.

## Evaluation improvements

31. Manually audit the 31 currently unlabeled actionable hook findings before interpreting the corpus's
    labeled precision as overall precision. Do not generate gold labels from current scanner output.
32. Track review-to-change yield per blocker and per missing dependency, including zero-change apps.
    A larger question queue without a stronger proof is not a recall improvement.
33. Add source-resolution fixtures for workspace exports, path aliases, re-export chains, package
    conditions, symlinks, and intentionally unavailable sources. A parser pass is not a resolution pass.
34. Add migration contracts for mount/unmount, StrictMode, async rejection, cancellation, rapid repeated
    events, transitions, key changes, and atomic reader visibility. Count owner and leaf renders
    separately and compare behavior after every event.
35. Keep a small mutation suite targeting proof guards: eager callbacks, render overrides, hidden
    writes, stale answer dependencies, key instability, and incomplete consumer closure. A positive
    fixture alone cannot establish detector precision.
36. Benchmark worst-case graph shapes as well as apps: cycles, diamond forwarding, long alias chains,
    high fan-out, and many identical queries. Publish cache hits and exhaustion reasons, not only wall time.

## Validation and remaining risks

The Base UI positive fixture failed before the implementation and passed afterward. Adversarial fixtures
protect custom render overrides, unknown caller spreads, incorrect import provenance, eager merge
functions, defaulted or reassigned render bindings, and escaped callback props. Review tests exercise
open/rejected/stale/confirmed transitions, preservation of the candidate disposition, and exclusion of
known eager owner calls from event-origin confirmation.
Four temporary mutations were detected: ignoring render overrides, ignoring import provenance,
allowing eager merge functions, and dropping unresolved/eager command references when building a
question. The compiled files were restored after each mutation; production source was not mutated.

| Risk                     | Protected contract                                                                    | Verification                                                       |
| ------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Event deferral           | Only proven default DOM paths become actionable.                                      | Cross-file positive and adversarial analyzer fixtures.             |
| Confirmation authority   | A question names the missing event origin and cannot waive a known eager owner call.  | Public findings and confirmation round trip.                       |
| Review state transitions | Rejected/stale answers remain candidates; confirmed changes carry no review guidance. | Source-analysis transition test.                                   |
| Dependency ordering      | A dependent effect points at its state's question.                                    | Public effect finding and waitsOn assertions.                      |
| No fabricated saving     | Same-value React bailout remains a no-benefit candidate.                              | Minimal state fixture.                                             |
| Missing consumer source  | Only declared reachable implementations can supply a callback proof.                  | Workspace adversarial fixtures, enforced Hoalu label, full corpus. |

The app checkouts were left unchanged. Runtime savings were measured in a controlled migration fixture,
using actual React 19.2.8, Base UI 1.7.0, and Legend State 3.0.0-beta.48. Across Strict Mode on/off and
successful/rejected work, the original owner rerenders at the pending transition while the migrated
owner does not. DOM snapshots, button identity, disabled-click suppression, and command event traces
match. This is evidence for the supported shape, not an application-wide performance measurement.

The initial investigation passed all 839 tests and the seven-app corpus with 507/523 hook labels.
The workspace follow-up's first full suite passed 856 tests. Final follow-up validation is recorded below.

## Follow-up source cross-validation

- Base UI 1.7.0: `useRender` delegates to `useRenderElement`; `evaluateRenderProp` directly calls a
  supplied render function, whereas its default tag path creates a DOM element. `mergeProps` invokes
  function inputs immediately but wraps event properties for deferred invocation. This explains both
  the supported default host and the rejected render/merge overrides. The runtime tests import the
  exact 1.7.0 package, including an eager merge-function counterexample.
- TypeScript 5.9.3: inspected the installed resolver's `getConditions`, `loadModuleFromExports`, and
  `getImpliedNodeFormatForFile` paths. Tests distinguish ESM and CommonJS export branches, private and
  null exports, declaration-first conditions, barrels, cycles, registry dependencies, duplicate names,
  installed symlinks, malformed source, and existing installations. Discovery uses the installed manypkg 3.1.0 source and its documented API;
  package export semantics remain TypeScript's responsibility.
- Legend State: inspected the published beta.47 source used by Hoalu and the installed beta.48 source
  used by the runtime suite. Both retain the local observable in a React ref and export `useValue` as
  `useSelector`. The relevant no-dependencies initializer/lifetime path agrees; the versions are not
  otherwise asserted equivalent. The same five runtime cases also passed in an isolated beta.47
  installation with Base UI 1.7.0 and React 19.2.8. Hoalu's application itself was not migrated or
  runtime-benchmarked.

| App                     | Workspace follow-up action delta                                  |
| ----------------------- | ----------------------------------------------------------------- |
| legend-music            | 0                                                                 |
| excalidraw              | 0                                                                 |
| expensify               | 0                                                                 |
| formbricks              | 0                                                                 |
| outline                 | 0                                                                 |
| open-webui-react-native | 0                                                                 |
| hoalu                   | 1: `ReceiptScanner.isEncoding`, `review-state` → `use-observable` |

Remaining workspace limits are explicit: uninstalled numeric/aliased workspace ranges are not guessed,
declarations are not followed into guessed sibling implementations, and unavailable conditional/custom
render paths remain in review. Broader event summaries and proof provenance traces remain future work.

Sources for external API boundaries: [Base UI useRender](https://base-ui.com/react/utils/use-render),
[Base UI mergeProps](https://base-ui.com/react/utils/merge-props), and
[Legend State fine-grained reactivity](https://legendapp.com/open-source/state/v3/react/fine-grained-reactivity/).

Pinned implementation references: [Base UI 1.7.0 renderer](https://github.com/mui/base-ui/blob/v1.7.0/packages/react/src/internals/useRenderElement.tsx),
[Base UI 1.7.0 mergeProps](https://github.com/mui/base-ui/blob/v1.7.0/packages/react/src/merge-props/mergeProps.ts),
[TypeScript module resolution](https://www.typescriptlang.org/docs/handbook/modules/reference), and
[manypkg get-packages API](https://github.com/Thinkmill/manypkg/tree/main/packages/get-packages).

The workspace mutation tests killed four deliberately unsafe changes: treating registry versions as
workspace links, ignoring installed-package precedence, selecting the wrong NodeNext export branch,
and allowing declarations into implementation context. An additional adversarial source check exposed
a parser-recovery gap: a valid-looking Button followed by broken syntax could supply a proof. The
source index now excludes parser-error files; the fixture preserves that boundary.

## Final follow-up validation

- Lint, formatting, TypeScript, build, package dry run, and all **860 tests** passed. The full suite was
  rerun after excluding parser-error sources. Five runtime tests additionally passed against isolated
  Legend State beta.47; the project suite uses beta.48.
- The full public evaluation used the repository's pinned checkout inspection, label scorers, and
  summary functions: **1,236 hooks, 237 targets, 508/523 hook labels, 15 non-enforced misses,
  5/5 questions, 10/10 groups, 71/71 practices**. Labeled actionable precision is **100% (231/231)**;
  recall improves from **93.5% to 93.9% (231/246)**. Unlabeled actionable findings remain outside
  that precision claim.
- There are no removed findings. All action deltas are listed above, including all zero-change apps.
  Review guidance now covers **666 reviews**: 336 confirm, 58 dependency, 252 investigate,
  14 no-proven-benefit, and 6 unsupported. Recheck/declined remain covered by answer-transition tests.
- All **five workspace guard mutations** were killed, including removal of the parser-error guard.
  Compiled files were restored, and all 16 workspace fixtures passed again afterward. Together with
  the initial investigation, nine distinct proof-guard mutations have been checked.
- Legend Doctor self-scans before and after returned `status: ok` and zero practices. The hook inventory
  increased from six to seven only because the new runtime test contains a real baseline `useState`;
  all existing self-scan actions remain unchanged and the new fixture is correctly retained as React state.
