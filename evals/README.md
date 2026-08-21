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
- `Expensify/App`: focused address, controlled-form, async-status, Promise-chain, navigation-effect, animation-lifecycle, list-render, validation, task, workspace, payment-form, HR-sync, video-control, signer-document, Chronos, domain, report-access, and callback-resource targets
- `formbricks/formbricks`: focused controlled-form, draft, chart-form, element-editor, webhook, billing, segment, tag, integration, async-status, and survey-URL targets
- `outline/outline`: focused API-key, controlled-form, document-copy, export-form, icon-picker, split-history, and collection-routing targets
- `Genie-sa/genie-courses`: private full-repository effect-policy and Legend-transaction holdout
- `RonasIT/open-webui-react-native`: focused observable-array append and attachment-reset holdout

Repository source is not copied into this project. Corpus entries pin a commit and source location, then a local eval
runner scans checked-out repositories. A recommendation is added to the golden corpus only after manual review.

Acceptance targets for the first useful release:

- inventory every direct React `useState` and `useEffect` call;
- at least 90% precision for non-review actions in the labeled corpus;
- zero certain recommendations that change effect phase, cleanup ownership, or Strict Mode behavior;
- deterministic output across repeated runs;
- every bug fix adds a minimal fixture and, when possible, a pinned real-world corpus entry.

## Current baseline

At the pinned commits, the analyzer inventories 2,336 hooks across 220 source roots. The corpus currently contains
778 manual hook labels, including 19 non-enforced opportunities, plus fourteen
grouped-instruction labels that verify exact cluster membership, thirty-seven real Legend transaction labels, eleven direct
`useValue` labels, six lowest-path subscription labels, eleven non-tracking snapshot labels, and eight narrow observable-write
labels. Three boolean-toggle labels require the direct `.toggle()` operation. One additional real label verifies the documented
`useSelector`/`use$` to `useValue` migration. Five split-leaf labels verify that divergent static reads of one broad
`useValue(parent$)` subscription become per-leaf subscriptions across three app roots. Seven stable leaf-boundary labels verify
that a transported `useValue` subscription can leave a broad owner without changing observable ownership or child APIs. Run
the eval for the current precision/recall table. If the root README publishes those metrics, update them only
from a fresh full eval so the numbers stay synchronized as known misses are added.

Generality is enforced with structural hard negatives rather than application allowlists. In particular, source-symbol
resolution is provenance rather than proof of leaf ownership; production migrations are not emitted for tests; state
cannot move into conditional, keyed, or repeated child instances; and an isolated observable conversion must actually
eliminate an owner render across its companion update cluster. Effect rules distinguish recognizable disposer protocols
from arbitrary returned calls and treat `useMount` as a probable lifecycle choice because it changes Strict Mode replay.
Derived-state deletion requires transparent inputs that match effect dependency paths and cannot create a fresh identity.
Mutation-site reset advice requires controlled value-transition callbacks or intrinsic element events; opaque component
callbacks remain review.
Observable reactions require synchronous `useValue` reads; timers, promises, subscriptions, async callbacks, and
registered helpers remain React effects.
Keyed collection advice is proven from event-rooted writes, stable row keys, per-row membership, and mount/cardinality
safety; state variable names are not evidence.
The Genie holdout verifies that an adjacent `legend-doctor keep-react-effect` or existing `react-effect-allow`
directive is an explicit React-lifecycle ownership decision. The effect remains inventoried as `keep-effect`; detached
comments and string literals do not apply. Conditional `useMount` and `useUnmount` advice remains visible without
claiming that once-only semantics are proven. Teardown-only `useUnmount` advice requires the empty-dependency effect to
return a function value. A returned call may perform setup or mount work before producing a disposer, so it stays under
React effect ownership.
An exact React `useRef` mirror also remains `keep-effect`: it synchronizes a committed ref after render. The proof
requires one imported, unshadowed React `useRef`, one exact `ref.current = value` assignment, and no cleanup or extra
work. The effect may run after every commit or list one dependency identical to the assigned value. `[]`, mismatched
dependencies, calls, mutations, shadowed/local lookalikes, and self-referential ref reads remain review findings.
Deferred render-gate labels separately verify that scheduler effects and cleanup stay in React while only their
one-shot boolean sink moves to a leaf observable. Projection labels require one bounded call-site render surface and an
independent write path; reactive mutation lifecycles and custom-hook setter escapes are enforced hard negatives.
Controlled-leaf and async-status labels may use an independent JSX component sibling as the render-cut witness even
when its source is unresolved; fragments, ancestors, dead JSX, and repeated or unstable consumers do not qualify.
One stable JSX call site may also receive an owner-scoped observable through a local subscriber wrapper without proving
the child prop contract. The wrapper passes the same plain value, while owner commands keep the stable observable handle.
When the value and every setter already belong to that call-site subtree, the state stays with the cohesive control.
Effect-synchronized draft labels preserve the original React effect, guard, dependencies, and timing while moving only
a complete editable state cluster into one observable model. A migration also needs a structural render cut: raw JSX
count alone is not proof, root-level cohesive controls stay in React, and deferred commands snapshot the observable once at
command entry. One-hop immutable aliases are audited before promotion; aliases that feed hooks, queries, lifecycle,
list-data construction, or owner control flow remain review findings. Async work, cleanup, partial clusters, and
unproven edit paths also remain review findings. An edit may forward the same freshly computed draft value to one
upstream command after the local write; unrelated calls, reversed ordering, and local helper-owned state still abstain.
Async pending labels require a literal-false flag whose pending transition in an event command reaches awaited work
before any owner-state write or early exit and renders through one proven runtime status leaf. The same leaf may consume
the flag through loading props and pure label or icon selection. A broad owner qualifies directly; a compact owner must
have independently rendered content outside the status leaf, while a cohesive one-control owner remains React state.
Non-mutating validation,
routing guards, and bounded synchronous command preparation may precede that boundary. Observable ownership stays above
state-independent conditional branches, while a local subscriber wraps the exact existing call site. The command, await
boundary, error handling, and
later close/reset writes stay unchanged; mutation-owned status, fanout, scheduled callbacks, and nonliteral writes
remain review findings. Exact async status in a cohesive control emits `keep-state` because no smaller subscription exists.
An exact delayed pending transition also emits `keep-state` in a cohesive control when its timer callback contains only
the `true` write and the same async command clears that timer immediately before the `false` write in `finally`.
React Hook Form's imported `handleSubmit` is a proven event adapter for this rule, including a uniquely resolved local
helper beneath that submit command. Arbitrary functions called while building an `onSubmit` prop remain unknown because
they may execute the callback during render. A Promise-chain command also abstains when later synchronous React state
work in the same callback already invalidates the owner before the Promise settles.
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
Dependency-driven external effects stay in React when one standalone integration follows non-state dependencies. The
effect may use one imported/module/global precondition, one command-argument builder, or one exact dependency collection
mapped through a call-free static item-property projection; finite membership/string queries
and a `Date` value are also accepted. A local translator is accepted only when it comes from `react-i18next`'s imported
`useTranslation` and is listed in the dependency array. Local-state synchronization, observable snapshots, cleanup,
timers, nested functions, subscriptions, arbitrary constructors or local builders, and multi-command effects remain
under review.
Legend transaction labels require two or more consecutive `.set()` calls on distinct observable paths proven by a local
Legend factory/type or a resolved project export. Direct fields of one object use `.assign()` only when their values do
not read that observable and are not updater functions; multiple roots and ordering-sensitive values use `batch()`.
Existing batches, repeated or overlapping paths, awaited values,
unrelated statements, partial runs containing an unproven `.set()`, and test/story/demo files abstain. Adversarial
fixtures cover Maps, shadowed bindings, nested observable container types, aliases, barrels, and namespace imports;
full-app impact must remain zero in applications that do not import Legend State.
Exact observable-array appends use `.push()` only when the target is locally proven to start as an array and the write is
exactly the previous entries followed by one evaluation-safe value. Prepend, sort, filter, multiple values, spread values,
calls, getters, tracking `.get()`, escaped snapshots, and imported or otherwise unproven array roots abstain.
Exact observable boolean flips use `.toggle()` only when the target is a proven static observable path and the write is either
the negation of that same path's untracked `peek()` or an exact one-expression previous-value updater. Tracked `get()` reads,
dynamic paths, mismatched paths, block or async updaters, shadowed roots, and unproven observables abstain.
The direct-reactivity rule replaces an eager `useValue(observablePath.get())` input or an exact
`useValue(() => observablePath.get())` selector with `useValue(observablePath)`. Explicit type arguments and the suspense
option are preserved. The path must be statically addressed and proven as Legend State through a local declaration or
resolved export. Computed selectors, optional or dynamic access, shallow reads, reserved members, shadowed hooks, and
unproven getters abstain.
Legacy-hook labels replace calls imported as `useSelector` or `use$` from `@legendapp/state/react` with `useValue`.
An exact zero-argument `.get()` on a proven static observable path becomes the direct `useValue(path)` form; computed,
dynamic, and unproven selectors preserve their callback. Named aliases and namespace imports are resolved; unrelated and
shadowed functions abstain.
Non-tracking snapshot labels replace zero-argument `.get()` with `.peek()` only inside a direct React state initializer,
React effect, or uniquely event-rooted command. Render reads, Legend tracking callbacks, mixed-use handlers, nested
unknown callbacks, shallow reads, dynamic paths, and unproven getters abstain.
Effect-written command cursors may become refs when one custom hook returns the sole synchronous reader, the cursor is
used only as a switch discriminant, and every branch issues exactly one imported command. One exact default fallback may
guard an imported command and bare return with an owner parameter before issuing its imported fallback command. Extra
reads, returned values, other conditional branch work, async callbacks, and any second consumer abstain.
Listener-only primitive snapshots may become one ref group when at least two members feed imported React `useCallback`
bindings that are paired by exact `addEventListener` and `removeEventListener` calls in the same React effect. One
synchronous JSX event must write the complete group and call no remaining React setter, which proves the migration removes
an owner render. Every callback reference, listener target, event, cleanup, and effect stays in place; only the grouped
storage and callback dependency reads change. Missing or mismatched cleanup, async work, callback escape, render transport,
functional updates, and partial event writes abstain.
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
React transition sensitivity is state-specific when an imported `startTransition` or `useTransition` command receives an
inline callback or one immutable local function directly. A named callback is an event-command root only when the exact
transition call is itself event-rooted. Controlled values written outside that callback may isolate; values written inside
it remain React state. Reads in nested functions lexically owned by that command require one non-tracking snapshot at
command entry. Mutable bindings, callback aliases, local helper chains, effect-rooted transitions, and unproven call sites
remain review findings.
Dependency-driven browser-storage effects stay in React when their bodies contain only guards, storage mutations, and
bounded `JSON`/`Object`/`Array` serialization helpers. Hydration reads, React setters, timers, async work, cleanup,
shadowed globals, and arbitrary helpers do not enter this rule.
Lazy-initialized state may isolate one resolved leaf inside a non-repeated JSX child callback when a separate returned
sibling proves the owner render cut. The observable retains the React owner's lifetime and is created exactly once from
the existing initializer; it is not converted into a Legend computed. Render props, repeated or conditional callback
owners, callable values, effect or deferred reads, and commands that also invalidate sibling React state abstain.
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
