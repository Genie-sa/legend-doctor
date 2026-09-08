# Optimize complete state flows

Historical planning baseline. See [the integrated implementation and validation](integrated-subscriptions.md)
for the delivered features, current scores, and remaining proof limits.

## Assessment

The recent work improved two subscription extraction shapes and closed safety gaps. It did not establish how much
useful optimization remains. Passing tests and preserving emitted findings demonstrate regression protection, not
that the tool finds the highest-value refactors.

The current public baseline has 1,236 React hooks, 523 manually labeled hooks, 16 known hook misses, and 73 Legend
practice findings. The saved full-corpus reports contain 689 candidate findings and 290 ranked review questions.
There are 31 emitted hook changes without labels; those changes are explicitly outside labeled precision scoring.
These counts describe the pinned corpus, not performance in a running application.

Important existing foundations should be reused:

- `src/analysis/model.ts` already separates render, deferred, effect, escaped, and transported state usage.
- `src/project/state-flow/` resolves cross-file state flow.
- `src/rules/child-contract/` proves how source-resolved children consume props.
- `src/rules/react-commit-sensitivity/` distinguishes lifecycle-sensitive React behavior.
- React state already has grouped edits, review questions, and runtime verification instructions.

Legend read rules are shallower. `identifiedUseValueDeclaration` recognizes a direct observable argument, while
`projectedValueReferences` rejects derived aliases and callbacks. Most unsuccessful practice proofs return null,
so the consumer cannot distinguish a useful unsupported opportunity from a correct subscription boundary.

## Priorities

| Order | Investment                             | Concrete outcome                                                                                                                                                                                     | Success criterion                                                                                                                       |
| ----- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Shared subscription data flow          | Follow a subscribed value through const aliases, pure derivations, memoized values, props, and every consumer. Classify each edge as render, event snapshot, effect, or unknown.                     | Implement the two audited visualizer opportunities without relaxing callback, identity, or lifetime proofs.                             |
| 2     | Coordinated owner-level refactor plans | Group overlapping recommendations and explicitly identify which subscriptions and derivations leave the parent, which handles stay owned there, and which inputs become ordinary props.              | Applying the whole plan leaves no residual parent subscription; conditional descendants and local drafts retain identity.               |
| 3     | Dependency-aware lifecycle proofs      | Reuse the React commit analysis for Legend relocations instead of independently treating every effect as blocking. Prove dependency stability and cleanup behavior before allowing a skipped render. | Accept a dependency-stable effect case while rejecting an every-commit effect, unstable dependency, or callback ref.                    |
| 4     | Impact and runtime evidence            | Separate static cost estimates from measured render counts. Rank complete plans with update/render evidence when available; avoid treating setter-site counts as actual update frequency.            | A selected interaction shows fewer owner/sibling renders while DOM state, callback snapshots, and atomic transitions remain equivalent. |
| 5     | Coverage and explicit misses           | Inventory unsuccessful Legend opportunities and preserve audited misses in evaluation. Eventually expose reasons in a versioned report, building on existing hook review questions.                  | Improvements increase labeled recall without increasing unexpected recommendations; report the unmeasured portion explicitly.           |

The next production slice should be const/defaulting derivations, followed by primitive `useMemo` projections.
Keep the first graph bounded to one owner and reuse source/binding utilities; extend cross-file traversal only when
a pinned case requires it. General selectors, list membership, and multiple-return lifetimes need their own proofs.
Ordinary child components defined outside their parent remain the default output strategy.

## Foundation implemented now

Practice labels can now represent an audited but unimplemented opportunity with `enforced: false`, as hook labels
already do. Such misses count against labeled recall. All previous labels remain enforced, and unexpected emitted
actions still fail. This adds visibility without enabling any new production recommendation.

Two new labels are audited against Legend Music at `59d02afc11d6b27bc53ddecf1a69501626f8487f`:

- `visualizer/VisualizerWindow.tsx:12`: move track and its memoized subtitle into the stable metadata child.
  The boundary contains three of nineteen JSX elements. The subtitle's conditional remains inside that child.
- `visualizer/VisualizerWindow.tsx:15`: move the defaulted bin-count read into two stable children around the
  preview and picker. Pass the selected preset component, picker options, and callbacks from the parent.
  These two elements currently invalidate the nineteen-element owner.

These are manual refactor conclusions, not static detector proofs or measured application speedups. The runtime
fixture for the second pattern validates nullish defaults, zero, two subscribing children, preserved input identity
and drafts, current parent props, and removal of owner renders in both StrictMode modes. The memoized metadata
pattern remains manually audited and has no new runtime fixture in this phase.

## Validation risks

| Risk                                                               | Evidence                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Hiding a missing opportunity improves apparent accuracy            | An unenforced missing label remains in the recall denominator and increments known misses. |
| Known misses suppress unrelated false positives                    | A different emitted action at the same location still fails.                               |
| New policy weakens old regression labels                           | Missing ordinary labels still fail; no existing label is made unenforced.                  |
| Skipped repositories depress reported recall                       | Unscanned targets contribute neither labels nor known misses.                              |
| Implemented opportunities remain counted as misses                 | An exact new match improves recall and clears its known-miss count automatically.          |
| Moving a derived read breaks defaults or retains the parent render | Runtime migration checks null, zero, updates to both consumers, and parent render counts.  |

Labeled recall is still not overall Legend State coverage. Two new labels expose two known gaps; they do not count
all opportunities in the corpus. The production read-only scanner and its JSON schema are unchanged in this phase.

## Results of this phase

All 237 pinned targets pass. Practice precision remains 73/73 (100%); labeled practice recall is now explicitly
73/75 (97.3%), with two known misses. The denominator change exposes missing capability; it is not a detector
regression. Hook labels and scores remain unchanged, and no old practice label was relaxed.

| Application             | Emitted action delta | New audited misses |
| ----------------------- | -------------------- | ------------------ |
| Legend Music            | 0                    | 2                  |
| Excalidraw              | 0                    | 0                  |
| Expensify               | 0                    | 0                  |
| Formbricks              | 0                    | 0                  |
| Outline                 | 0                    | 0                  |
| Open WebUI React Native | 0                    | 0                  |
| Hoalu                   | 0                    | 0                  |

All 844 tests pass, along with typecheck, lint, formatting, and Legend Doctor self-validation. The evaluation
regressions failed before implementation. Replacing the two derived-child subscriptions with `peek()` in temporary
compiled test output caused both StrictMode variants to fail; restoring subscriptions and rebuilding returned the
full suite to green. No application source was modified.
