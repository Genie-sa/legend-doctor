# Next Phase

Start here after the command-only state safety closeout. The current phase is complete; preserve its gates before adding
another rule.

## Current truth

| Measure | Verified result |
| --- | ---: |
| Full app roots | 12 |
| Full app hooks | 6,147 |
| Scored targets | 218 |
| Scored hooks | 2,325 |
| Manual hook labels | 772 |
| Known misses | 43 |
| State groups | 13/13 |
| Legend practices | 77/77 |
| Actionable precision | 100% (370/370) |
| Actionable recall | 90.7% (370/408) |
| Tests | 431/431 |

The full-app output currently contains 401 `use-observable`, 16 `move-state-down`, 39 `use-ref`, 97 `use-unmount`,
40 `use-mount`, six `use-observe-effect`, 2,855 `review-state`, and 1,256 `review-effect` findings.

## What this phase changed

`src/rules/command-only-state.ts` now owns command-only ref safety. It traces local state-reading callbacks and rejects a
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
