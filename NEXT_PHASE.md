# Next Phase

Start here after the command-only state safety closeout. The current phase is complete; preserve its gates before adding
another rule.

## Current truth

| Measure | Verified result |
| --- | ---: |
| Full app roots | 12 |
| Full app hooks | 6,147 |
| Scored targets | 220 |
| Scored hooks | 2,336 |
| Manual hook labels | 774 |
| Known misses | 41 |
| State groups | 13/13 |
| Legend practices | 89/89 |
| Actionable precision | 100% (374/374) |
| Actionable recall | 91.2% (374/410) |
| Tests | 465/465 |

The full-app output currently contains 401 `use-observable`, 16 `move-state-down`, 39 `use-ref`, 97 `use-unmount`,
40 `use-mount`, six `use-observe-effect`, 2,855 `review-state`, and 1,256 `review-effect` findings. Commit `69c38f4`
had additionally demoted twenty owners to `keep-state`; the demotion now emits those as evidence-bearing
`review-state` findings instead, so the twelve-root delta against `69c38f4` is exactly twenty `keep-state` →
`review-state` restorations (hoalu five, Legend Music nine, Memoria src six) with zero Legend practice action changes.

## Release-integrity audit (this phase)

The analyzer was audited against its own reliability contract across every pinned repository:

| Measure | Result |
| --- | ---: |
| Files inventoried | 45,216 |
| Parser diagnostics | 0 |
| Crashes or unaccounted files | 0 |
| Unsupported stage outcomes | 0 |
| Uncertain bounded-flow outcomes | 179 of 45,216 (0.4%), all `lowering:bounded-flow-uncertain`, reported not guessed |
| Determinism | byte-identical repeated full-app runs |
| Non-Legend applications | zero practice findings in Tree Map, Tree Wallet, Excalidraw, Expensify, Formbricks, and Outline |

The 41 known misses were re-inventoried against emitted output. Each one needs a proof family the local analysis
deliberately does not fake: child prop contracts and lifetime resets (dialog, delete, and submit flags), keyed selection
models with bounded summaries, stable-listener ref contracts
(Expensify ImageView family), custom-hook command contracts, timer-deferred async status cohesion
(`FilledButton.isLoading` requires tracing through a reassigned projection), and four distinct effect-keep shapes.
No family currently has five equivalent positives across three app roots, so none may reopen under the gate. Forcing
these labels would trade the 100% actionable precision for score; they remain explicit non-enforced opportunities.

## What this phase changed

`src/rules/child-contract.ts` adds the first cross-file structural proof. When one transport target resolves through
the source index, the analyzer opens the child's declaration (including `forwardRef`/`memo` wrappers with React import
provenance) and proves the prop is a pure render consumer: every read lands in host-element attributes, JSX children,
or bounded immutable projections; hooks, callbacks, writes, forwarding to other components, and calls abstain. The
promotion then emits `use-observable` with a call-site subscriber wrapper that leaves the child API unchanged. Gates
mirror the audited call-site rules: stable owner-level call site, non-keyed, no repeated transport, event-safe literal
setter commands, no companion writes or reactive mutation paths.

Because the verified contract proves exclusive leaf readership (single target, zero local/effect/deferred reads),
companion React writes cannot tear any observer: no subscriber reads the isolated value together with its siblings.
The promotion therefore does not block on companion writes and still blocks reactive-mutation-owned pending flags.
The twelve-root delta is exactly three promotions, each pinned as an enforced label: Formbricks
`GoogleSheetWrapper.showReconnectButton`, Formbricks `SlackWrapper.showReconnectButton`, and Excalidraw
`PublishLibrary.isSubmitting`. Expensify's layout-measurement pair stays review through the commit-sensitivity
override, which correctly outranks the transport promotion.

`src/rules/observable-reads.ts` now emits `split-use-value-leaves`: when every read of a broad
`useValue(parent$)` binding resolves through static leaf paths but no single path is shared, the rule replaces one
whole-object subscription with per-leaf `useValue` subscriptions and prescribes the exact read rewrite. Whole-value
escapes, calls, writes, dynamic or optional access, reserved members, and proposed-name collisions abstain. The
five-positive/three-app gate is met by Memoria (DataScreen, SpotlightScreen), Legend Music (JumpSearchMenuDropdown,
LibrarySettings), and Genie Courses (quiz-builder); all five sites were manually audited. Optional-chaining consumers
such as Hoalu's `customRange?.from` remain correct abstentions.

The same phase restored the `review-state` demotion from commit `69c38f4` to an evidence-bearing review: update
frequency cannot be proven statically, so findings name the owner's competing observable subscriptions instead of
suppressing the opportunity.

`src/rules/command-only-state.ts` owns command-only ref safety. It traces local state-reading callbacks and rejects a
ref rewrite when React state republishes that callback through rendering, Context, a lifecycle hook, or an imperative
handle. It also preserves the old render snapshot when a functional updater is followed by a state read.

The 12-root delta from commit `91b71da` is exactly seventeen `use-ref` → `review-state` changes:

- Legend Music: `DropdownMenu.isOpen`.
- Expensify: `attachmentErrors`, `attachmentLoaded`, `reportRHPWidthHints`, both map interaction flags, the import-tags
  focus latch, two Context Menu imperative snapshots, five ImageView pointer snapshots, status-bar style, description,
  and merchant command snapshots.
- Every other app root: zero hook action changes.
- All twelve app roots: zero Legend practice action changes.

Every delta has a real-app label. Eight wider ref migrations remain `enforced: false`: five ImageView pointer snapshots,
status-bar style, description, and merchant. They need stable-listener or custom-hook contract rewrites; local ref replacement
alone is not proven equivalent.

## Architecture map

- `src/analyze-source.ts`: hook inventory, evidence, and rule orchestration.
- `src/rules/command-only-state.ts`: callback publication and command-only ref proof.
- `src/rules/state-proofs.ts`: shared React state and JSX proofs.
- `src/rules/effects.ts`: React effect ownership.
- `src/rules/effect-drafts.ts`: effect-synchronized observable drafts.
- `src/rules/async-leaf-status.ts`: event-owned async status leaves.
- `src/rules/deferred-reveal.ts`: scheduler-preserving reveal and gate rules.
- `src/rules/keyed-selection.ts`: scalar and collection row selection.
- `src/analyze-legend-practices.ts`: Legend practice orchestration.
- `src/rules/observable-reads.ts`, `observable-clone-writes.ts`, and `observable-toggle.ts`: Legend-native rewrites.
- `src/state-flow.ts`: bounded synchronous co-execution proof.
- `evals/corpus.ts`: pinned targets, manual actions, known misses, and group contracts.

### 0. Coupled co-write pairs (scouted, ready to implement)

Corpus mining found twenty-four adjacent co-write pairs across six app roots (Tree Map 6, Formbricks 13, Outline 3,
Tree Wallet 1, Legend Music 1): two useState members whose statement writes are always adjacent within the same
mutation region, with equal call counts, plus solo bare setter transports only as direct value-transition props
(`onChangeText={setName}`). Legend Music's audited Sidebar quartet (`tempPlaylistId`/`tempPlaylistName`,
`editingPlaylistId`/`editingPlaylistName`) is the reference shape: migrate each pair as one owner-lifetime
observable model written through batch or one model `.set`, subscribing at leaves. Candidate Tree Map
`alerts-modal` `[isEditing, editingAlert]` and Outline `DropToImport` `[isImporting, uploadProgress]` provide the
cross-app audit set. Implementation gates: adjacency proof both directions, equal counts, no functional updaters,
no effect reads, primitives only; adversarial negatives for solo command writes, crossed updaters, and hook-owned
pairs. Requires five audited positives across three roots before enforcement.

A prototype of this rule (adjacency plus equal counts, latch initializers, non-hook owners) fired on forty members
across seven roots in full-app scans, including hook-owned selector pairs (`useMultiSelect`, `usePersonalDetailSearchSelector`),
Context-provider states, layout-measurement height chains, and an address-form reset chain. None contradicted a
pinned label - precision stayed 100% - but none was audited either, so the emission was withdrawn and the analyzer
restored to the accepted baseline. Enforcement requires proving each member's consumers: local render reads plus
value-transition transports only, resolved leaves through the child-contract lane, and exclusion of shapes already
owned by the effect-drafts family. The prototype result bounds the family at roughly twenty audited pairs if all
survive consumer proofs.

A second prototype added per-member consumer proofs (resolved children with
verified render-only contracts, value-transition-only setter transports) and
still fired on thirty-six members across seven roots - and asymmetrically:
`alerts-modal.isEditing` promoted while its partner `editingAlert` abstained
because `AlertForm`'s contract could not be proven. Two experiments now show
adjacency plus consumer proofs cannot separate transaction latches (alerts,
playlist create-or-rename) from form-sync clusters (address fields, measured
heights, draft trios): both cohorts pair adjacently, reset together, and
reach host-input or resolvable consumers. The missing ingredient is
workflow-intent discrimination - one multi-region transaction versus
independent field synchronization - which needs cross-region data-flow
facts, not more local shape gates. The emission stays withdrawn; the analyzer
is restored to the accepted baseline.

## Next work, in order

### 1. Expand Legend-native value

Prefer this lane before another hook detector. Mine repeated, semantics-preserving cases for:

1. missing `batch()` or `.assign()` around proven multi-write transactions;
2. tracking `.get()` used where one command snapshot should use `.peek()`;
3. broad `useValue(parent$)` subscriptions that can subscribe to one proven child path;
4. eager `useValue(path$.get())` or one-get selectors that should receive `path$` directly;
5. whole-object replacement that can safely write one observable child.

Completion: one structural proof, evil fixtures for evaluation order and tracking, at least five equivalent real examples
across three app roots when the proof is not exact by construction, 100% enforced precision, and a recorded full-app delta.

### 2. Reopen hook recall only with cross-app proof

The current `use-ref` misses are not one family. A stable-listener proof has six examples in one app; custom-hook command
contracts have two more in the same app. Neither clears the three-app gate.

Completion: five equivalent positives across three app roots plus hard negatives for Context publication, returned getters,
effect/focus callbacks, `useImperativeHandle`, stale snapshots, cleanup, and listener registration cadence.

### 3. Prepare public distribution

Add a license, package allowlist, install smoke test, CI matrix, changelog policy, and release workflow. Keep the analyzer
metrics described as static-analysis evals, not runtime benchmarks.

Completion: a clean checkout can install, build, run tests, execute a fixture scan, and pack the exact public files in CI.

## Gates

Run `npm run typecheck`, `npm test`, and the complete pinned eval after every rule phase. Compare all twelve full-app JSON
reports against the previous accepted commit and account for every changed action.

Add a rule only when its correctness comes from program structure. Filenames, component names, state names, owner line count,
and app allowlists are never proof. Preserve React commit timing, cleanup, mount identity, callback publication, transaction
atomicity, and async snapshot timing.

The eval command and repository pins live in [evals/README.md](evals/README.md). Historical experiments and rejected
approaches live in [remaining-five-percent-audit.md](remaining-five-percent-audit.md).
