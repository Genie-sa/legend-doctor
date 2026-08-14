# Evaluation strategy

Legend Doctor is evaluated as an agent-triage system, not by snapshotting whatever it currently prints.

Each labeled hook records its expected action. Proven opportunities that are not implemented yet remain in the corpus
with `enforced: false`: they count against recall without breaking CI. The primary metric is precision among
non-review recommendations, with recall reported globally and per action so abstention cannot masquerade as accuracy.

Pinned repositories:

- `netzerosa/platform`: Tree Map and Tree Wallet
- `Radwan-Albahrani/memoria`
- `LegendApp/legend-music`
- `excalidraw/excalidraw`
- `Expensify/App`: focused address, controlled-form, async-status, Promise-chain, navigation-effect, animation-lifecycle, list-render, validation, task, workspace, payment-form, HR-sync, video-control, signer-document, Chronos, and domain targets
- `formbricks/formbricks`: focused controlled-form, draft, chart-form, element-editor, webhook, billing, segment, tag, integration, async-status, and survey-URL targets
- `outline/outline`: focused API-key, controlled-form, document-copy, export-form, and icon-picker targets

Repository source is not copied into this project. Corpus entries pin a commit and source location, then a local eval
runner scans checked-out repositories. A recommendation is added to the golden corpus only after manual review.

Acceptance targets for the first useful release:

- inventory every direct React `useState` and `useEffect` call;
- at least 90% precision for non-review actions in the labeled corpus;
- zero certain recommendations that change effect phase, cleanup ownership, or Strict Mode behavior;
- deterministic output across repeated runs;
- every bug fix adds a minimal fixture and, when possible, a pinned real-world corpus entry.

## Current baseline

At the pinned commits, the analyzer inventories 1,914 hooks across 133 source roots. The corpus currently contains
590 manual hook labels, including 22 non-enforced opportunities, plus twelve
grouped-instruction labels that verify exact cluster membership, thirty-three real Legend transaction labels, eleven direct
`useValue` labels, seven lowest-path subscription labels, eleven non-tracking snapshot labels, and five narrow child-write
labels. One additional real label verifies the documented `useSelector`/`use$` to `useValue` migration. Run the eval for
the current precision/recall table. If the root README publishes those metrics, update them only
from a fresh full eval so the numbers stay synchronized as known misses are added.

Generality is enforced with structural hard negatives rather than application allowlists. In particular, source-symbol
resolution is provenance rather than proof of leaf ownership; production migrations are not emitted for tests; state
cannot move into conditional, keyed, or repeated child instances; and an isolated observable conversion must actually
eliminate an owner render across its companion update cluster. Effect rules distinguish recognizable disposer protocols
from arbitrary returned calls and treat `useMount` as a probable lifecycle choice because it changes Strict Mode replay.
Deferred render-gate labels separately verify that scheduler effects and cleanup stay in React while only their
one-shot boolean sink moves to a leaf observable. Projection labels require one bounded call-site render surface and an
independent write path; reactive mutation lifecycles and custom-hook setter escapes are enforced hard negatives.
Effect-synchronized draft labels preserve the original React effect, guard, dependencies, and timing while moving only
a complete editable state cluster into one observable model. A migration also needs a structural render cut: raw JSX
count alone is not proof, root-level cohesive controls stay in React, and deferred commands snapshot the observable once at
command entry. One-hop immutable aliases are audited before promotion; aliases that feed hooks, queries, lifecycle,
list-data construction, or owner control flow remain review findings. Async work, cleanup, partial clusters, and
unproven edit paths also remain review findings.
Async pending labels require a literal-false flag whose pending transition in an event command reaches awaited work
before any owner-state write or early exit and renders through one proven runtime status leaf. The same leaf may consume
the flag through loading props and pure label or icon selection. A broad owner qualifies directly; a compact owner must
have independently rendered content outside the status leaf, while a cohesive one-control owner remains React state.
Non-mutating validation,
routing guards, and bounded synchronous command preparation may precede that boundary. Observable ownership stays above
state-independent conditional branches, while a local subscriber wraps the exact existing call site. The command, await
boundary, error handling, and
later close/reset writes stay unchanged; mutation-owned status, fanout, scheduled callbacks, nonliteral writes, and
cohesive small controls remain review findings.
Presentation-gate labels keep observable ownership above a condition and replace the complete controlling expression
with an always-mounted subscriber; this prevents dead subscriptions when the selected child starts hidden. Gate
conditions must be side-effect free, confined to one strict subtree, and independent of repeated-list shape or effects.
One immutable `const` projection may connect the state to that gate when every alias use is audited in the same bounded
render surface. Mutable aliases, opaque calls, hook consumers, disjoint large subtrees, and repeated-row broadcasts abstain.
Sibling producer/consumer labels require one stable event producer and one distinct stable presentation consumer.
The producer may only issue the state command, every consumer projection must be side-effect free, and any React
synchronization effect remains unchanged; opaque helpers, multiple consumers, repeated producers, and mount gates abstain.
Companion writes block per-state isolation even when another event independently opens the leaf: splitting a later
payload/visibility transition across React and Legend would lose the original atomic workflow transaction. Those cases
remain review until the complete state machine can be modeled and emitted as one grouped observable instruction.
Dependency-driven external effects stay in React when one standalone command follows non-state dependencies. Local-state
synchronization, observable snapshots, cleanup, timers, collection callbacks, local helpers, and multi-command effects do
not enter this rule.
Legend transaction labels require two or more consecutive `.set()` calls on distinct observable paths proven by a local
Legend factory/type or a resolved project export. Direct fields of one object use `.assign()` only when their values do
not read that observable and are not updater functions; multiple roots and ordering-sensitive values use `batch()`.
Existing batches, repeated or overlapping paths, awaited values,
unrelated statements, partial runs containing an unproven `.set()`, and test/story/demo files abstain. Adversarial
fixtures cover Maps, shadowed bindings, nested observable container types, aliases, barrels, and namespace imports;
full-app impact must remain zero in applications that do not import Legend State.
Direct-reactivity labels replace only an exact `useValue(() => observablePath.get())` selector with
`useValue(observablePath)`. The path must be statically addressed and proven as Legend State through a local declaration
or resolved export. Computed selectors, shallow reads, dynamic element access, and unproven getters abstain.
Legacy-hook labels replace calls imported as `useSelector` or `use$` from `@legendapp/state/react` with `useValue`.
An exact zero-argument `.get()` on a proven static observable path becomes the direct `useValue(path)` form; computed,
dynamic, and unproven selectors preserve their callback. Named aliases and namespace imports are resolved; unrelated and
shadowed functions abstain.
Non-tracking snapshot labels replace zero-argument `.get()` with `.peek()` only inside a direct React state initializer,
React effect, or uniquely event-rooted command. Render reads, Legend tracking callbacks, mixed-use handlers, nested
unknown callbacks, shallow reads, dynamic paths, and unproven getters abstain.
Controlled-input labels require one direct value/callback leaf and either no other render read or one complete pure
validation projection in a disjoint sibling leaf. A separate rendered sibling proves that the owner cut is material.
The observable stays at the owner across state-independent conditional branches; ref-backed validity, repeated
consumers, nested input/dialog ownership, multi-hop aliases, and opaque normalization remain hard negatives. A direct
controlled callsite may also live below state-independent early returns; ownership remains above every branch, while
stored JSX, state-controlled returns, and value transport to alternate branches remain review findings.
An exact call-free controlled edit may prove an independent high-frequency path even when a separate reset or close
command co-writes sibling state. Direct setter transport for coupled range fields, normalization calls, scheduled work,
and callbacks that issue any second command remain hard negatives so atomic workflows are not split opportunistically.
A parent-owned visibility flag may still isolate one dialog or popover when that exact child exposes a direct
`onOpenChange` callback or a paired `open`/`setOpen` API. Parent payload transactions keep their ordering, the observable
keeps the parent's lifetime, and only the child wrapper subscribes. Self-gates and arbitrary setter props remain review.
A resolved custom controlled leaf may use a descriptive value-transition callback such as `onInputChange`,
`onSelectCover`, or `onOpenChange`. This broader callback grammar applies only when one stable call site owns the
complete value surface and existing command, companion-write, effect, and render-cut proofs pass. State wholly confined
to that leaf stays React state and moves down; owner commands keep observable ownership above a leaf subscriber.
Call-site-owned state below alternate returns or state-independent conditional mounts also keeps observable ownership at
the owner, because moving React state down would change reset lifetime. Direct `setValue`-style child APIs count as value
transitions; arbitrary callbacks, shared validation projections, repeated children, and unresolved normalization remain
review findings.
Dependency-driven browser-storage effects stay in React when their bodies contain only guards, storage mutations, and
bounded `JSON`/`Object`/`Array` serialization helpers. Hydration reads, React setters, timers, async work, cleanup,
shadowed globals, and arbitrary helpers do not enter this rule.
Keyed-selection labels require stable item-derived row keys, membership that changes row presentation rather than row
existence, and independently placed summary subscribers. Array-backed selection may use one immutable local `Set`
normalization; filtered intersections, cross-file normalization, mutable/escaped aliases, aggregate broadcasts, and
selection-driven list shape remain explicit recall cases rather than widening the detector without proof.
Scalar row-selection labels additionally require strict equality to the current repeated item key or index, pure setter
arguments, and event-only command reads. Derived row discriminators, effects, unstable keys, broadcasts, and selectors
that control row existence remain review findings. A keyed row command may also feed one separate footer or detail leaf
when every secondary read resolves through one immutable projection, the leaf is at most 40% of the owner, and list shape
is independent of the selection. Impure lookups, opaque render callbacks, fixed-key producers, and owner-wide fanout abstain.

State-cluster evals score the unit the coding agent actually receives: one anchor plus the exact member set. Co-writing
alone is insufficient. A grouped change requires compatible mutation paths, one payload plus visibility modes, resolved
consumer leaves, and no unresolved payload-controlled parent mount boundary. Member findings remain available in JSON,
while agent text emits only the primary grouped instruction.
