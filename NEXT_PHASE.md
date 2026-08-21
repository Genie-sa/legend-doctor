# Next phase

## Current verified baseline

| Measure | Result |
| --- | ---: |
| App roots | 12 |
| Source targets | 220 |
| Hooks analyzed | 2,336 |
| Manual hook labels | 778 |
| Known misses | 19 |
| State groups | 14/14 |
| Legend practices | 89/89 |
| Actionable precision | 100% (395/395) |
| Actionable recall | 95.4% (395/414) |
| Unit tests | 487/487 |

The latest phase converts five Expensify ImageView pointer snapshots from `review-state` to one grouped `use-ref`
instruction. Against commit `3205076`, the exact 220-target delta is:

- Expensify `src/components/ImageView/index.tsx`: `isMouseDown`, `initialScrollLeft`, `initialScrollTop`, `initialX`, and
  `initialY` changed from `review-state` to `use-ref`.
- The other 219 targets have zero hook action changes.
- All 220 targets have zero Legend practice action changes.

## Listener snapshot proof

`src/rules/listener-ref-state.ts` requires all of these facts:

- at least two primitive React states never render or leave their owner;
- their reads stay in synchronous event commands or imported React `useCallback` bindings;
- each memoized callback is referenced only by one or more exact add/remove listener pairs and their effect dependencies;
- listener registration target, event expression, callback, and cleanup match;
- one synchronous JSX event writes the complete candidate group, calls no other function, and writes no remaining React
  state, proving that the grouped ref migration removes an owner render;
- every member uses direct setter calls without functional updates, async gaps, shadowing, or escape.

The emitted instruction keeps the existing listener effects and cleanup. It changes the whole group to refs, rewrites
reads and writes through `.current`, and removes only those values from callback dependencies. Missing cleanup, direct
effect execution, async listener work, and render-coupled co-writes are hard negatives.

## Named transition command proof

Against commit `4d3854b`, the exact 220-target delta is five Tree Map controlled fields in
`landowner-create-modal.tsx`: `phone`, `logoUrl`, `planterName`, `planterEmail`, and `planterPhone` changed from
`review-state` to `use-observable`. The other 219 targets have zero hook action changes, and all 220 targets have zero
Legend practice action changes.

The proof resolves a direct callback passed to imported React `startTransition` or a setter from `useTransition`. Named
callbacks must be immutable local functions, and the exact transition call must be reached from a proven event command.
State setters inside the callback remain transition-sensitive. A controlled field written outside it can isolate, with
one command-entry observable snapshot preserving the render snapshot used by lexically nested deferred work. Mutable
callbacks, aliases, local helper chains, and effect-rooted transitions abstain.

## Remaining labeled opportunities

Nineteen opportunities remain non-enforced:

- one event-owned effect reset whose custom component callback timing is unresolved;
- twelve observable leaf migrations covering keyed selection, repeated rows, coupled playlist edits, timed feedback, and
  three download-failure callbacks;
- one state move into a throttled statistics leaf whose current child mount lifetime must remain stable;
- five ref migrations behind async confirmation, form callback, or status-listener contracts.

Keep these as review findings until a structural proof covers their full ownership and timing. Component names, file paths,
and app-specific allowlists are not proof.

## Next work

1. Audit Legend-native reads and writes across every pinned app. Prefer exact `.peek()`, child `.set()`, `.toggle()`,
   `.assign()`, `batch()`, and lowest-path `useValue` improvements because they preserve ownership.
2. Revisit hook recall only when one existing proof can be extended without weakening cleanup, mount identity, callback
   publication, or atomic transitions.
3. For each detector phase, add the adversarial fixture and audited label first. Then run typecheck, the full unit suite,
   the full pinned corpus, the self-scan, and an exact 220-target comparison against the accepted commit.

The repository pins and evaluation policy live in [evals/README.md](evals/README.md). Rejected prototypes and unresolved
families live in [remaining-five-percent-audit.md](remaining-five-percent-audit.md).
