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

At the pinned commits, the analyzer inventories 2,356 hooks across 225 source roots. The corpus currently contains
804 manual hook labels with no known misses, plus eighteen
grouped-instruction labels that verify exact cluster membership, thirty-seven real Legend transaction labels, twelve direct
`useValue` labels, sixteen lowest-path subscription labels, fifteen non-tracking snapshot labels, and eight narrow observable-write
labels. Three boolean-toggle labels require the direct `.toggle()` operation. One additional real label verifies the documented
`useSelector`/`use$` to `useValue` migration. Five split-leaf labels verify that divergent static reads of one broad
`useValue(parent$)` subscription become per-leaf subscriptions across three app roots. Nine leaf-boundary labels verify
that a transported `useValue` subscription can leave a broad owner without changing observable ownership or child APIs.
Two replace a complete conditional child slot with an always-mounted subscriber while preserving the selected child's mount behavior. Run
the eval for the current precision/recall table. If the root README publishes those metrics, update them only
from a fresh full eval so the numbers stay synchronized as known misses are added.

Two Legend Music labels verify that a measured scalar can cross a bounded chain of immutable pure projections and
subscribe in one uniquely selected repeated branch. The receiver must be structurally deduplicated, the switch literal
must match the leaf key, and any later filter must be read-only. Duplicate rows, mutable aliases, shadowed globals,
arbitrary calls, receiver mutation, fallthrough, and unstable keys abstain.

One Legend Music snapshot label verifies a callback passed across files and invoked directly only inside an imported
React layout effect. Component resolution accepts immutable aliases of imported `memo` and `forwardRef`; names are not
proof. Render-time use, forwarding from the effect to unknown code, nested callbacks, unresolved wrappers, and other
callback references abstain, because those paths may establish a Legend tracking context.

One Legend Music snapshot label verifies a direct read inside imported Legend `useMount`. Direct imported React layout
and insertion effects plus Legend mount and unmount callbacks are non-tracking lifecycle boundaries. The nearest callback
must own the read, so nested registrations and tracking callbacks abstain. A dynamic `const` alias qualifies only when it
is rooted in a proven observable and passed directly to imported `useValue`; mutable aliases, optional access, reserved
members, unrelated hook imports, and unproven roots abstain.

Two Legend Music snapshot labels verify inline callbacks passed as the only argument to `onChange` on a proven Legend
observable. Legend registers and dispatches those listeners without opening an observing context. Listener options are
excluded because `initial: true` can run synchronously inside an outer observer. Named callbacks, nested callbacks,
optional or dynamic receivers, unrelated `onChange` methods, and tracking APIs also abstain.

The Formbricks tag-merger label verifies deletion of a self-contained state cycle: the current value is read only inside
an evaluation-inert argument to its own setter, and neither the current nor assigned value reaches rendering or another
command. Fixtures require an inert initializer and reject calls, mutations, coercions, functional updaters, shadowed
bindings, effect writes, and external reads. Property access in otherwise unused setter arguments retains its evaluation
at the original statement position.

Six effect-written presentation labels across three app roots verify that owner-lifetime observable storage can remove a
broad owner render while the original `useEffect`, cleanup, dependencies, and write order stay intact. Every setter call
must be lexically inside a direct imported React `useEffect`; named callbacks and other lifecycle hooks abstain. The value
may flow through pure immutable projections, one safe raw-value transport inside the same bounded gate, an imported
unshadowed `clsx` call, or a stable-keyed repeated render. Effect reads, previous-value updaters, companion writes,
callback escape, unkeyed lists, and large or disjoint render surfaces remain review findings.
Compact owners below twelve JSX elements additionally require the leaf boundary to exclude at least five elements; a
four-element saving is an enforced hard negative. The Open WebUI archived-search screen is pinned as its own target so
the cross-app proof is evaluated rather than inferred from an unsampled repository file.
One additional Excalidraw label verifies the narrow memoized-command extension: every setter is enclosed by one imported
React `useMemo` factory, the resulting binding is invoked only from direct React effects, and its other references are
effect dependencies or method cleanup calls. The command may not escape to JSX or any other callback surface. This keeps
the throttle, effects, cleanup, dependencies, and statement order unchanged while moving only the presentation storage
and `<StatsRows>` subscription.

Four Legend Music labels verify co-written editable drafts. Each cluster contains one nullable cursor and one
empty-string name; every direct cursor and name mutation is paired in the same straight-line block or switch case, while
additional name writes must be the matching controlled `value` handler. The recommendation keeps one owner-lifetime
observable object, uses atomic assignments for paired transitions, and moves subscriptions to row or control leaves.
Independent cursor writes, effects, functional updaters, non-controlled setter references, and escapes are hard negatives.

One Legend Music label verifies an effect-owned numeric cursor returned by a custom hook and broadcast through one keyed
list. Cross-file source must prove that each state-reading registration stores its callback until an exact cleanup, while
the only consumer compares the cursor with the row index inside an imported React `useCallback`, passes that callback to
one list, supplies a stable item-derived key, and uses the cursor only as list `extraData`. The recommendation preserves
effects, cleanup, ownership, and write order; changes command reads to non-tracking snapshots; removes the cursor-only
dependencies and list broadcast; and subscribes only in the keyed row. Synchronous registrations, index keys, mount
control, multiple consumers, callback escape, and non-production consumers abstain.

One Legend Music label verifies a false-initialized, event-owned boolean whose render fanout is limited to class/style
projections and several conditional presentation leaves of at most four JSX elements each. Imported projection wrappers
qualify only when source resolution proves a single pure return composed from `clsx` or `tailwind-merge`; helper names are
not evidence. The recommendation keeps every event callback and write position, uses reactive props for class/style, uses
`Show` only at the bounded gates, and never subscribes the large owner. An enforced Tree Wallet review label and local
fixtures reject multiple owner returns, impure wrappers, broad gates, effects, transports, companion writes, functional
updaters, repeated output, and non-presentation props.

One Expensify label verifies an asynchronously loaded payload that never renders and is read only by an eventual confirm
command. The command may cross local `useCallback` calls, a single-return memoized options object, component rest/spread wrappers,
object destructuring, static `Object.assign` composition, a `React.memo` default export, React context with all imports and reader hooks
resolved, source-resolved custom hooks and higher-order callback guards, and nested promise callbacks. Every component and
hook path must end in an intrinsic or framework event, a recursively proven custom event component, or a structurally proven
deferred registration; eager invocation, unknown calls, extra publications, mutable aliases, missing dependencies, and
unresolved wrappers or context readers abstain. The migration
preserves the loading effect and callback timing, writes and reads one ref at the existing positions, and removes only the
payload from callback dependencies.

Direct callback props are also resolved across source components before a command-only state is converted to a ref.
Every callback reference must be a direct JSX publication, every publication must resolve, and every component chain must
terminate at an intrinsic or framework event. An enforced Expensify validation label remains `review-state` because the
resolved form provider also invokes validation from a child effect; a ref could replace that effect's render-captured
snapshot with a newer mutable value. Eager render calls, mixed publications, effects, and unresolved consumers abstain.

One Tree Map label keeps a controlled value and its call-free nullable ID projection in the same stable dialog leaf.
Every projected reference must stay inside that component opening. The owner keeps the observable lifetime, and the
subscriber derives all state-dependent props before forwarding the existing callback. Opaque calls and repeated output
abstain.

Command-only ref labels also preserve render-snapshot ordering. A returned or otherwise unproven command that reads and
writes the same state abstains because a ref exposes writes synchronously across invocations. Any write before a later read
also abstains, including reads in nested callbacks under that command. Read-before-write commands remain eligible only
when every read is proven event-rooted; the dedicated source-proven counter snapshot is the narrow functional-updater
exception. Expensify's file-validation guard and awaited domain-close decision are enforced `review-state` cases.

Two Tree Map labels and one exact group label verify a selection model whose false-initialized mode and empty ID array
enter and cancel together. Every mode write must pair with an empty-array reset, while independent collection writes must
be functional updaters. Render reads must stay in JSX attributes so header summaries and keyed rows can subscribe without
moving owner control flow. Partial mode transitions, effects, escapes, direct collection replacements, and small owners
abstain.

One Expensify status-bar label verifies a self-refreshing memoized command snapshot. The state has no render consumer;
its only setter and reads stay within one imported `useCallback`, the callback is invoked only by direct React effects or
their nested listeners, and the snapshot appears in that callback's dependency list. A local setter helper is accepted
only when all references are direct calls and any call before a later snapshot read exits first. JSX escape, async work,
post-write reads, and execution outside those effects abstain.

Two Tree Map hook labels and one exact group label verify a nullable payload with nested timed feedback. All payload render
reads must stay in one direct gate, and all feedback reads must share a nested leaf of at most four JSX elements inside
the gate's true branch. Its true write must precede a global `setTimeout` false reset in the same command, and a separate
proven transition must clear payload and feedback together. The recommendation keeps one
component-lifetime observable model, preserves timer and command timing, batches the paired reset, snapshots command reads
with `peek()`, and places separate subscriptions at the payload branch and nested feedback leaf. Split resets, feedback
outside the gate, shadowed timers, effects, setter escape, transported values, and untimed flags abstain.

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
One Formbricks label proves an exact immutable array membership toggle owned by a resolved checkbox-group leaf. Imported
React Hook Form `handleSubmit` proves the submit callback is event-rooted, so the command can snapshot the observable
once without subscribing the forty-element owner. Opaque updater calls, extra updater work, unresolved form adapters,
additional consumers, and companion writes abstain.
One adjacent Formbricks command-only label uses the same imported adapter proof to replace a non-rendered webhook secret
with a ref. Reads precede writes in the shared async command; shadowed form factories and post-write snapshots abstain.
Effect-synchronized draft labels preserve the original React effect, guard, dependencies, and timing while moving only
a complete editable state cluster into one observable model. A migration also needs a structural render cut: raw JSX
count alone is not proof, root-level cohesive controls stay in React, and deferred commands snapshot the observable once at
command entry. One-hop immutable aliases are audited before promotion; aliases that feed hooks, queries, lifecycle,
list-data construction, or owner control flow remain review findings. Async work, cleanup, partial clusters, and
unproven edit paths also remain review findings. An edit may forward the same freshly computed draft value to one
upstream command after the local write; unrelated calls, reversed ordering, and local helper-owned state still abstain.
Async pending labels require a literal-false flag whose pending transition in an event command reaches awaited work
before any owner-state write or early exit and renders through one proven runtime status leaf. The same leaf may consume
the flag through loading props, pure label or icon selection, or one call-free JSX prop projection with state-independent
inputs. When the call site is inferred only from direct projections, its first await must be structurally unavoidable; a
conditional await can otherwise collapse the true-to-false transition into one synchronous command. The projection must
stay in one non-repeated call site and may not control that site's mount. A broad owner
qualifies directly; a compact owner must have independently rendered content outside the status leaf, while a cohesive
one-control owner remains React state.
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
resolved export. One selector-only dynamic segment is accepted when its key is an explicitly typed, immutable `string`
or `number` parameter of the owning component or hook. Computed selectors, optional access, mutable or call-derived keys,
shallow reads, reserved members, shadowed hooks, and unproven getters abstain.
Imported observable provenance also covers an exact controller member initialized by Legend `observable(...)` in a
`const` object literal or in the sole returned object literal of one local factory. The proof survives named aliases and
barrels without promoting the controller root or sibling methods. Spreads, computed or duplicate members, conditional
or multi-statement factories, shadowed Legend factories, unknown factories, and `$`-shaped names abstain. Qualified
`typeof` aliases are accepted only through the same proven member prefix. Reassigned factories, whole-controller escape,
optional controller access, and member replacement through any resolved source alias invalidate the provenance.
Broad `useValue(parent$)` bindings may narrow through optional raw-value chains when every read shares one static child
boundary. If the optional chain diverges, uses a dynamic key, or would move short-circuiting ahead of a remaining member
access or call, the broad subscription stays unchanged.
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
Command-only getters passed through a custom-hook options object may become refs when source resolution follows every
reference through imported project hooks to React effects. A hook may keep the latest callback in an imported React
`useRef` only when one React effect refreshes the same object property and all reads call that property from a proven
deferred callback. Render-time calls, stale initial-only storage, aliases, unresolved hooks, and ref escape abstain.
Two Expensify labels verify narrow state projections inside JSX child render callbacks. Observable ownership stays at
the original component, existing layout events, effects, promise continuations, and callback placement stay
unchanged, and one stable extracted leaf subscribes inside the callback's returned tree. JSX attribute callbacks remain
opaque; two additional labels reject setters published through a runtime-selected component alias or a platform wrapper
whose prop spread is unresolved. `key` projections, unkeyed repeated output, impure projections, consumers in different
callbacks, companion React writes, and non-material cuts also abstain.
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
When a unique owner return is itself the complete controlled subtree and every value and setter reference stays inside
it, the tool keeps React state. Wrapping the same subtree in an observable subscriber would not narrow rendering. A
separate sibling, alternate return, effect, deferred read, or state reference outside that root rejects this proof.
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
normalization. One exact filtered intersection is accepted when its read-only membership source feeds one immutable
`Set`, the filtered array is passed directly to one controlled summary leaf with its setter, and stable-keyed rows own
the membership reads. Split or transformed summaries, command escapes, opaque predicates, mutable membership sources,
cross-file normalization, aggregate broadcasts, and selection-driven list shape remain explicit abstentions.
Scalar row-selection labels additionally require strict equality to the current repeated item key or index, pure setter
arguments, and event-only command reads. Derived row discriminators, effects, unstable keys, broadcasts, and selectors
that control row existence remain review findings. A keyed row command may also feed one separate footer or detail leaf
when every secondary read resolves through one immutable projection, the leaf is at most 40% of the owner, and list shape
is independent of the selection. Impure lookups, opaque render callbacks, fixed-key producers, and owner-wide fanout abstain.

State-cluster evals score the unit the coding agent actually receives: one anchor plus the exact member set. Co-writing
alone is insufficient. A grouped change requires compatible mutation paths, one payload plus visibility modes, resolved
consumer leaves, and no unresolved payload-controlled parent mount boundary. Member findings remain available in JSON,
while agent text emits only the primary grouped instruction.
