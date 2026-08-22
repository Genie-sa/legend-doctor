# Next phase

## Current verified baseline

| Measure | Result |
| --- | ---: |
| App roots | 12 |
| Source targets | 221 |
| Hooks analyzed | 2,338 |
| Manual hook labels | 788 |
| Known misses | 13 |
| State groups | 17/17 |
| Legend practices | 89/89 |
| Actionable precision | 100% (413/413) |
| Actionable recall | 96.9% (413/426) |
| Unit tests | 495/495 |

The latest phase detects a complete selection-mode model. Against commit `6566623`, the exact current 221-target delta
is:

- Tree Map: `isSelectionMode` and `selectedCompanyIds` in
  `components/companies/companies-grid-view-container.tsx` change from `review-state` to `use-observable` and are emitted
  as one exact state group.
- The other 220 current targets have zero hook action changes.
- All 221 current targets have zero Legend practice action changes.

## Selection-mode proof

The mutation component must contain exactly one literal-false mode and one empty-array selection. The owner spans at
least 100 lines and eight JSX elements, and every render read stays in JSX attributes. Every mode write must pair with an
empty-array reset in the same proven execution path or an adjacent straight-line block or switch case. Both true and
false mode transitions are required. Independent collection edits must be functional updaters. Effects, setter escape,
callable values, owner control-flow reads, direct independent collection replacements, and partial mode transitions
abstain.

The emitted group instruction keeps one owner-lifetime observable selection model, uses atomic `assign` for enter/cancel,
uses `peek()` in commands, and subscribes only in header, control, and stable-key row leaves.

## Co-written editable draft proof

The owner must be large enough to justify a render cut, and the mutation component must contain exactly one
null-initialized cursor plus one empty-string draft. Every cursor write and every direct draft write must be co-executing
or adjacent in the same block or switch case. The cursor must have both an opening and a reset; the draft must have an
empty reset. Additional draft setter references are accepted only as direct JSX handlers on the same element that
receives the draft through `value`. Effects, functional updaters, callable values, shadowing, escape, partial cursor
transitions, and unmatched controlled writes abstain.

The emitted group instruction uses one owner-lifetime observable object, atomic `assign` for paired transitions,
non-tracking `peek()` snapshots in commands, and `useValue` only in rendered row or control leaves.

## Effect-written presentation proof

Every setter call must be lexically inside a direct imported React `useEffect`, with no state read in any effect, no
previous-value updater, no callback escape, no companion state write, and no transported command surface. The state may
flow through immutable one-hop aliases only when all downstream reads fit one bounded render boundary. Raw value
transport is limited to one safe prop target inside that same boundary; repeated output needs a stable item-derived key;
and `clsx` is accepted only from the real package import without owner shadowing. The recommendation preserves the effect,
cleanup, dependency list, statement order, and owner lifetime, changing only storage and the leaf subscription.
Owners with twelve or more JSX elements keep the existing 40% subtree ceiling. Smaller owners qualify only when at least
five JSX elements remain outside the subscriber; four or fewer is an enforced abstention.

A narrow extension accepts setters enclosed by one imported React `useMemo` factory only when the resulting command
binding is invoked exclusively by direct React effects. Exact effect dependency references and method cleanup calls are
allowed; JSX transport and every other escape abstain. The recommendation preserves the memoized command, effect and
cleanup, dependencies, statement order, and owner lifetime, and moves only storage plus the bounded leaf subscription.

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

Thirteen opportunities remain non-enforced:

- one event-owned effect reset whose custom component callback timing is unresolved;
- seven observable leaf migrations covering keyed selection, repeated rows, timed feedback, and three
  download-failure callbacks;
- five ref migrations behind async confirmation, form callback, or status-listener contracts.

Keep these as review findings until a structural proof covers their full ownership and timing. Component names, file paths,
and app-specific allowlists are not proof.

## Next work

1. Audit Legend-native reads and writes across every pinned app. Prefer exact `.peek()`, child `.set()`, `.toggle()`,
   `.assign()`, `batch()`, and lowest-path `useValue` improvements because they preserve ownership.
2. Revisit hook recall only when one existing proof can be extended without weakening cleanup, mount identity, callback
   publication, or atomic transitions.
3. For each detector phase, add the adversarial fixture and audited label first. Then run typecheck, the full unit suite,
   the full pinned corpus, the self-scan, and an exact target-by-target comparison against the accepted commit.

The repository pins and evaluation policy live in [evals/README.md](evals/README.md). Rejected prototypes and unresolved
families live in [remaining-five-percent-audit.md](remaining-five-percent-audit.md).
