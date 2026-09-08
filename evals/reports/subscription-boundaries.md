# Subscription boundary evaluation

This change extends `move-use-value-down` while preferring ordinary child components defined outside their
parent. It does not introduce automatic application edits or lower materiality thresholds.

## Implemented

1. When one small common subtree cannot contain every read, find disjoint stable boundaries and issue one
   instruction to move all reads together. Their combined JSX share must remain within the existing 40% limit,
   and the owner must have at least 12 JSX elements. Prefer one cohesive child when it already qualifies.
2. Analyze a render read within its nearest JSX element, including elements embedded in a `control` prop.
   An unrelated neighboring event handler no longer blocks the proof. Reads inside nested callbacks are rejected,
   including callbacks that merely return the value without calling anything.
3. Check owner commit work before choosing either a cohesive child or separate children. Previously, a small
   common subtree bypassed the effect/ref/snapshot check. Direct property and bracket reads of `current` now
   also prevent extraction, while reads deferred inside event handlers remain eligible.
4. Reuse that owner-work check for `move-use-value-into-child`. A source-resolved primitive child contract alone
   does not prove that skipping its parent's render is safe. Both relocation rules now share the same check.

Observable ownership stays in place. Other inputs and callbacks remain parent-evaluated props. Complete conditional
slots retain always-mounted subscriber children, with conditional descendants inside them. The new multi-boundary
fallback additionally checks mutable render aliases. Both paths abstain on owner effects, JSX refs, direct
imperative render snapshots, and unsupported lifetime paths.

## Audited application opportunities

Both cases are in Legend Music at `59d02afc11d6b27bc53ddecf1a69501626f8487f`:

- `settings/OverlaySettings.tsx:28`: move the enabled subscription into children around the two Select controls
  at lines 76 and 84. The affected JSX comprises 2 of the owner's 12 elements. The linked duration observable
  remains owned by the page. The controls are unkeyed, and SettingsRow renders its supplied control unchanged.
- `settings/GeneralSettings.tsx:16`: move the hotkey error subscription into a child owning the complete control
  View, including the border and conditional error text. That subtree comprises 5 of the owner's 20 JSX elements.
  Pass the hotkey values and the parent-owned command callback as props.
  The phase 3 audit also confirms this owner contains no effects, JSX refs, or imperative render snapshots;
  its existing positive label retains the opportunity under the stricter check.

Phase 4 reaudits Hoalu's `components/providers/workspace-action-provider.tsx:32` at its pinned corpus commit.
The `useEffect` import is unused; there are no React effect calls, JSX refs, or direct imperative render snapshots.
The existing CommandPalette child remains a valid target. This protects against confusing an import with a hook call.

These element counts describe static extraction boundaries, not measured application timings. Runtime validation
uses representative executable migrations; the pinned applications themselves were not run interactively.

## Action deltas

All 237 public targets were evaluated at their pinned commits after each detector phase.

| Application             | Phase 1                | Phase 2                | Phase 3 | Total      |
| ----------------------- | ---------------------- | ---------------------- | ------- | ---------- |
| Legend Music            | +1 move-use-value-down | +1 move-use-value-down | 0       | +2 (5 → 7) |
| Excalidraw              | 0                      | 0                      | 0       | 0          |
| Expensify               | 0                      | 0                      | 0       | 0          |
| Formbricks              | 0                      | 0                      | 0       | 0          |
| Outline                 | 0                      | 0                      | 0       | 0          |
| Open WebUI React Native | 0                      | 0                      | 0       | 0          |
| Hoalu                   | 0                      | 0                      | 0       | 0          |

Phase 4 changes no action counts for any app: Legend Music 0, Excalidraw 0, Expensify 0, Formbricks 0,
Outline 0, Open WebUI React Native 0, and Hoalu 0. All 237 pinned targets pass, all 73 practice findings retain
their audited labels, and all 837 unit/runtime tests pass. Typecheck, lint, formatting, and the post-validation
Legend Doctor self-scan pass as well.

Every other action count is unchanged. Emitted practice findings increase from 71 to 72 to 73, all matched by
audited labels. Hook inventory remains 1,236, with 507/523 labels matched and the same 16 known unenforced misses.
Labeled-hook actionable precision remains 230/230 and recall 230/246. The 31 unlabeled hook changes remain outside
precision scoring; this work does not claim they have been audited. All 10 grouped instructions and four labeled
review questions match.

## Risk coverage

| Risk                                                        | Protection                                             | Evidence                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Partial migration leaves the parent subscribed              | One finding covers every read and names all boundaries | Multiple-leaf positive fixture fails before implementation                          |
| Too many subscriptions for little render reduction          | Aggregate materiality gate; retain cohesive extraction | Broad-surface and cohesive-child fixtures                                           |
| Changed callback snapshots or commit behavior               | Reject nested callback reads and unproven owner work   | Callback-return regression fails before phase 2; effect/ref/snapshot fixtures       |
| Remounted input or lost local draft                         | Stable child declarations and original slots           | Runtime comparison retains input identity and local drafts in both StrictMode modes |
| Stale parent props or callbacks                             | Preserve ordinary parent inputs                        | Runtime updates labels and verifies the command uses the updated label              |
| Broken conditional display                                  | Extract the complete conditional boundary              | Runtime error appearance/clear sequence and conditional-slot detector fixture       |
| Unsupported keys, repeated rows, detached JSX, or shadowing | Abstain                                                | Adversarial detector fixtures                                                       |

Both runtime suites were also run with their child subscription temporarily replaced by a constant in compiled
test output. Both mutations failed, and restoring the subscriptions made the suites pass. Source files were not
modified by those mutations.

Phase 3's cohesive-child regression failed on the old detector: a render-driven effect still received a change
recommendation. The corrected detector rejects that extraction, aliased layout effects, namespace insertion effects,
callback refs, observable snapshots, and property/bracket ref snapshots. A positive event-handler case ensures
deferred ref and observable reads do not suppress a valid extraction. All 837 unit/runtime tests pass; all 237 pinned
targets retain their findings and scores. No additional opportunity is claimed by this safety correction.

Phase 4's cross-file regression reproduced five unsafe existing-child recommendations before the fix: passive and
aliased layout effects, callback refs, observable snapshots, and ref snapshots. The same fixture rejects all five
after the fix, while the positive fixture tolerates an unused effect import. The check remains deliberately limited
to direct owner work; arbitrary custom-hook and helper bodies still need separate source proofs.

## Remaining opportunities

These are not enforced by this change:

- General selector callbacks and render-derived aliases need captured-input and result-identity proofs.
- Repeated rows need list membership, key, and per-item subscription proofs.
- Multiple return branches need a subscription-lifetime proof; no thresholds or lifetime guards were relaxed.
- Broader effect/ref-bearing owners need proof that removing their render preserves commit behavior.

Validation includes typecheck, the unit/runtime suite, lint, formatting, pinned-corpus scoring, and Legend Doctor
self-scans before editing and after validation. No corpus scoring policy changed.
