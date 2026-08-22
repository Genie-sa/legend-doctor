# Next phase

## Current verified baseline

| Measure | Result |
| --- | ---: |
| App roots | 12 |
| Source targets | 221 |
| Hooks analyzed | 2,338 |
| Manual hook labels | 789 |
| Known misses | 4 |
| State groups | 18/18 |
| Legend practices | 89/89 |
| Actionable precision | 100% (423/423) |
| Actionable recall | 99.1% (423/427) |
| Unit tests | 505/505 |

The latest phase proves effect-owned custom-hook cursors whose only UI consumer is a stable-keyed list row. Against commit
`46d00ca`, the exact current 221-target action delta is:

- Legend Music: `highlightedIndex` in `components/JumpSearchMenuDropdown/hooks.ts` changes from `review-state` to
  `use-observable`.
- Tree Map, Tree Wallet, Memoria src, Memoria app, Excalidraw, Expensify, Formbricks, Outline, Genie Courses, Open
  WebUI React Native, and Hoalu have zero hook action changes.
- All 221 current targets have zero Legend practice action changes.

## Effect-owned keyed cursor proof

The state must be a numeric cursor owned by a JSX-free custom hook, returned with its setter, and written only inside
direct imported React effects. Every state read inside an effect must occur in a callback passed to a source-resolved
registration method that stores the callback in an owner array and removes the same callback from that array in its
returned cleanup. The call-site effect must retain and invoke that disposer. Synchronous callback calls, unresolved
registration sources, missing cleanup, shadowing, callable state, companion writes, and other transports abstain.

Across the project, exactly one production consumer may import the hook. It must destructure the cursor directly, compare
it with the repeated row index in one imported React `useCallback`, use that equality only in row JSX attributes, pass the
callback directly as one list's `renderItem`, provide an item-derived key that never uses the index, and broadcast the
cursor only through that list's `extraData`. Multiple consumers, index keys, conditional row mounting, dependency aliases,
and any other read abstain. The emitted migration keeps hook ownership, effects, cleanup, and write order; uses `peek()` in
registered commands; removes the cursor-only dependencies and list broadcast; and places `useValue` at the keyed row.

## Transitive command-callback proof

The state must have no render, effect, or transported value consumer. Its getter crosses one property of a direct custom
hook options object, and source resolution must prove every reference is deferred through imported project hooks into a
React effect. A callback stored in an imported React `useRef` qualifies only when one React effect refreshes the exact
same property and every invocation of that property remains in an effect-deferred callback.

The emitted instruction uses a ref, preserves all existing hooks, registration, cleanup, statement order, and callback
ownership, and adds no Legend subscriber because the value never renders. Render-time calls, initial-only stale ref
storage, aliasing, unresolved hooks, ref escape, and any UI read remain review findings.

## Memoized option-command proof

The boolean must be false-initialized, render through one stable leaf target in a broad owner, and use only literal setter
commands. Every non-JSX-event setter must be inside one statically named callback property of one imported React
`useMemo`. The memo result may be read through `.length` and must otherwise cross exactly one direct JSX prop without
transformation.

The receiving source component must resolve. Its array prop may be destructured directly or through one unaliased rest
props object. Callback-field invocations must be behind a stored callback, a host JSX event, or a custom-hook parameter
whose implementation structurally defers every reference into a React effect. Render-time calls, immediate React hooks,
synchronous array callbacks, unknown callback hooks, multiple transports, setter escape, effects, functional updates,
and nonliteral commands abstain. The recommendation keeps the memo and callback timing, replaces only storage and literal
commands, and subscribes at the existing stable modal leaf.

## Payload-gated timed-feedback proof

The cluster must contain exactly one null-initialized payload and one false-initialized feedback flag in an owner with at
least twelve JSX elements. Neither value may enter effects, transport, shadowing, escape, functional updates, or callable
state. Every payload render read must stay in one direct gate, and every feedback render read must share a nested leaf of
at most four JSX elements inside its true branch, including owners with only preceding null-return guards. The feedback
command must set true before a global, unshadowed `setTimeout` resets it, and a separate proven straight-line transition
must clear both payload and feedback.

The emitted group instruction keeps one component-lifetime observable model, preserves the timer and command positions,
batches the paired reset, uses `peek()` for payload command reads, subscribes at the stable payload-gated content boundary,
and subscribes again only in the nested feedback leaf. Feedback outside the gate, alternate JSX returns, split resets,
untimed feedback, effects, transport, and shadowed timers abstain.

## Filtered keyed-selection proof

The array state must flow through one immutable `filter(id => membershipSet.has(id))` alias and one immutable `Set`
normalization. The membership source must be uniquely bound and read only through `.has()`. The filtered array must have
exactly two consumers: that normalization and one direct prop on a non-repeated custom child whose controlled callback
receives the original setter. The normalized Set must only drive presentation membership inside a stable-keyed repeated
render. Existing event-rooted update, effect, mount-control, escape, and independent-write proofs still apply.

The emitted instruction keeps observable ownership at the current owner, preserves the filter in the row and aggregate
leaves, subscribes per stable row key, and keeps commands non-tracking. Extra summary consumers, command use, transformed
transport, missing setter pairing, mutable membership sources, opaque predicates, and membership-controlled row shape
abstain.

## Self-refreshing command snapshot proof

The state must have no render or transport consumer and exactly one direct setter call inside one imported React
`useCallback`. Every value read stays in that callback body or its dependency list. The command binding must be invoked
only by direct React effects or their nested listener callbacks; effect dependency references are the only other allowed
uses. A local setter helper is accepted only when it is uniquely bound and every reference is a direct call. Any helper
call lexically before a later snapshot read must be followed by an unconditional return from its branch, preventing a
ref write from changing a later same-invocation comparison.

The emitted instruction preserves the memoized command, all effects, listener registration and cleanup, and statement
order. It changes the comparison and write to `.current` and removes only the old state dependency. Async callbacks,
JSX escape, functional updates, effect writes, post-write reads, and other command consumers abstain.

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

Four opportunities remain non-enforced:

- one event-owned effect reset whose custom component callback timing is unresolved;
- one observable leaf migration spanning multiple drop surfaces;
- two ref migrations behind async confirmation or form callback contracts.

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
