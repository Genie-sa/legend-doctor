# Legend Doctor

Static analysis for React and Legend State. It tells coding agents what to change, where to subscribe, and when React
should stay in control.

```bash
npm install
npm run build
node dist/src/cli.js /path/to/app --json --actionable
```

## What you get

| Input | Output |
| --- | --- |
| `useState` | Keep, delete, move down, ref, `useValue`, or observable |
| `useEffect` | Keep, move to event, mount, unmount, or observable reaction |
| Explicit React-owned effect | `keep-effect`; no lifecycle rewrite |
| Latest-value `useRef` mirror | `keep-effect`; preserve post-commit timing |
| Committed previous-value guard | `keep-effect`; preserve skip-mount and transition timing |
| Coupled fields | One grouped model and one atomic migration |
| Payload-gated timed feedback | One owner observable, batched reset, nested leaf subscription |
| Effect-written presentation state | Preserve the effect; subscribe only in the proven leaf |
| Effect-owned custom-hook cursor in one stable-keyed list | Preserve effects and cleanup; remove the list broadcast and subscribe per row |
| Lazy state in a child callback | One owner-lifetime observable and one nested leaf subscriber |
| One unresolved JSX consumer | One local subscriber wrapper; no child contract required |
| Resolved leaf consumer with verified render-only contract | Owner observable plus one call-site subscriber; child API unchanged |
| Existing `useValue` transported to one stable small leaf | Move the subscription into a leaf wrapper; keep ownership and child APIs unchanged |
| Broad subscriptions | Lowest proven observable path |
| Divergent leaf reads from one broad `useValue(parent$)` | Per-leaf `useValue` subscriptions with one mechanical read rewrite |
| `useValue(leaf$.get())` | `useValue(leaf$)` with types and options preserved |
| Non-reactive `.get()` | `.peek()` in proven snapshots and commands |
| Whole-object clone writes | Direct child `.set()` on the changed path |
| Cloned array append | Direct `.push()` when exactly one safe value is appended |
| Boolean flip | Direct `.toggle()` on the proven observable |
| Multiple Legend writes | One `.assign()` or `batch()` transaction |
| Legacy `useSelector` / `use$` | `useValue`, narrowed when the selector is one direct `.get()` |
| Every finding | File, line, action, confidence, evidence, and boundary |

Measured on pinned real applications:

| Metric | Result |
| --- | ---: |
| App roots | 12 |
| Source targets | 221 |
| Hooks analyzed | 2,338 |
| Manual labels | 789 |
| Known misses | 4 |
| State groups | 18/18 |
| Unit tests | 505/505 |
| Actionable precision | 100% (423/423) |
| Actionable recall | 99.1% (423/427) |
| Legend practice precision | 100% (89/89) |

These are analyzer evals, not runtime benchmarks. The corpus includes Tree Map, Tree Wallet, Memoria, Legend Music,
Excalidraw, Expensify, Formbricks, Outline, Genie Courses, Open WebUI React Native, and Hoalu.

## Agent contract

Run Legend Doctor before and after every React state, effect, or Legend observable optimization.

1. Run it on the smallest app or feature root.
2. Apply `change` findings first.
3. Apply every grouped state finding as one transaction.
4. Inspect `candidate` findings; they are opportunities, not proven migrations.
5. Run app tests and Legend Doctor again.
6. Finish when every changed hook is accounted for and no unsafe finding appears.

`--actionable` returns `change` and `candidate`. Omit it to include intentional `keep` findings.

`--disposition <value>` keeps only findings and practices with that disposition (`change`, `candidate`, `keep`, or
`style`), so "apply the safe ones" is `--json --disposition change`. A `style` disposition marks a consistency change
with no runtime effect, such as renaming `use$` to `useValue` when the installed `@legendapp/state` exports them as
aliases of the same function; the finding's evidence names the resolved version.

For parser and analysis coverage, use `--json --coverage`. It reports every discovered supported source file and runtime
function, parser diagnostics, and whether parsing, semantic analysis, detectors, or bounded state-flow proofs ran, were
not requested, or encountered unsupported control flow.
The normal report stays unchanged.

When project knowledge says an effect must keep React lifecycle semantics, place a directive immediately above it:

```tsx
// legend-doctor keep-react-effect: the SDK requires post-commit timing.
useEffect(() => syncSdk(identity), [identity]);
```

The effect remains inventoried and is reported as `keep-effect`. Detached comments do not apply. Existing
`react-effect-allow ...` comments are also recognized.

Exact latest-value ref mirrors also stay in React because the write intentionally happens after commit:

```tsx
const latestValue = useRef(value);
useEffect(() => {
  latestValue.current = value;
}, [value]);
```

The rule requires one imported React `useRef` and one exact assignment. It accepts either no dependency array, meaning
the mirror runs after every commit, or one dependency that exactly matches the assigned value. Extra work, cleanup,
calls, mutations, shadowed hooks, `[]`, mismatched dependencies, or a different source remain under review.

An effect guarded by an exact committed previous value also stays in React:

```tsx
const previousValue = useRef(value);
useEffect(() => {
  if (previousValue.current === value) return;
  previousValue.current = value;
  synchronize(value);
}, [value]);
```

This proof requires one immutable local ref initialized from the sole dependency, the equality-return guard as the first
statement, and the matching ref assignment immediately after it. Async callbacks and reordered, mismatched, or
pre-guard work remain under review.

```json
{
  "action": "use-observable",
  "disposition": "change",
  "confidence": "probable",
  "location": { "file": "accounts-page.tsx", "line": 18, "column": 35 },
  "name": "deleteTarget",
  "stateModel": {
    "ownership": "local-observable",
    "subscription": "leaf-use-value"
  }
}
```

## Before and after

### 1. Page state → dialog subscriber

Before: opening a dialog invalidates the page and table.

```tsx
function AccountsPage() {
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);

  return (
    <>
      <AccountsTable onDelete={setDeleteTarget} />
      <DeleteDialog
        account={deleteTarget}
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
```

Output:

```text
accounts-page.tsx:18 [use-observable] Keep `deleteTarget` in a component-lifetime
observable and subscribe at the single dialog call site.
```

After: only the dialog wrapper subscribes.

```tsx
function AccountsPage() {
  const deleteTarget$ = useObservable<Account | null>(null);
  return (
    <>
      <AccountsTable onDelete={account => deleteTarget$.set(account)} />
      <DeleteDialogState deleteTarget$={deleteTarget$} />
    </>
  );
}

function DeleteDialogState({ deleteTarget$ }) {
  const account = useValue(deleteTarget$);
  return (
    <DeleteDialog
      account={account}
      open={account !== null}
      onClose={() => deleteTarget$.set(null)}
    />
  );
}
```

Lazy initializers stay one-shot. The tool does not turn `useState(() => initialValue)` into
`useObservable(() => initialValue)`, because Legend treats that function as a computed value. It keeps the observable at
the proven owner lifetime, creates it once from the existing initializer, and subscribes only in the nested leaf.

A direct React transition may receive one immutable named callback without making every owner state transition-sensitive.
The tool follows that callback only when the exact transition call is event-rooted and the callback does not delegate to
another local helper. A controlled leaf updated outside the transition can then move to an observable. Its command reads
are snapshotted once at callback entry so nested deferred work keeps React's original render-snapshot semantics. Mutable
callbacks, effect-rooted transitions, and state setters inside the transition stay under review.

### 2. Effect draft → one atomic model

Before: one synchronization causes three React state writes.

```tsx
const [name, setName] = useState("");
const [color, setColor] = useState("");
const [anchor, setAnchor] = useState<string | null>(null);

useEffect(() => {
  setName(session.name);
  setColor(session.color);
  setAnchor(session.anchor);
}, [session]);
```

Output:

```text
SessionSheet.tsx:44 [use-observable] Replace (`name`, `color`, `anchor`) with one
observable draft. Preserve the React effect and assign the draft atomically.
```

After: the effect keeps its timing and performs one write.

```tsx
const draft$ = useObservable({ name: "", color: "", anchor: null as string | null });

useEffect(() => {
  draft$.set({ name: session.name, color: session.color, anchor: session.anchor });
}, [session]);

function NameField({ draft$ }) {
  const name = useValue(draft$.name);
  return <Input value={name} onChangeText={next => draft$.name.set(next)} />;
}
```

A large owner can also replace an editable `{id, name}` pair with one observable object when every cursor transition is
co-written with the name and the only independent name writes come from matching controlled `value` handlers. The tool
requires complete open/reset transitions, preserves them with atomic `assign` calls, uses `peek()` for commands, and
subscribes only at the row or control leaves. Partial cursor writes, effects, functional updaters, and setter escapes
remain reviews.

Selection mode follows the same atomic rule when one boolean mode and one empty ID array always enter and cancel
together. Functional row toggles may update only the collection, but every mode transition must clear it in the same
straight-line block or switch case. The recommendation keeps one observable selection model, with header/control
selectors and per-key row subscriptions; partial mode transitions remain reviews.

Array selection may also pass through one exact `filter(id => visibleSet.has(id))` and immutable `Set` normalization
when the filtered array feeds one direct controlled summary leaf and the normalized membership feeds stable-keyed rows.
The membership source must remain read-only; split summaries, command escapes, transformed props, opaque predicates,
and selection-controlled row mounts remain reviews.

#### Effect-written presentation state

When every write is lexically inside one or more direct React `useEffect` callbacks and the value only controls one
small render boundary, the tool keeps the effect, cleanup, dependencies, statement order, and owner lifetime unchanged.
Only the storage becomes an owner-scoped observable, and an always-mounted leaf subscribes around the complete projection
or gate. Companion writes, effect reads, previous-value updaters, named effect callbacks, callback escape, broad render
surfaces, and unkeyed repeated output remain review findings.

The same storage-only migration applies when every setter is enclosed by one imported React `useMemo` command whose
binding is invoked only by direct React effects. Effect dependency references and method cleanup calls are allowed; any
JSX prop, callback, or other escape keeps the state under review. The recommendation still preserves the memoized
command, effect scheduling, cleanup, dependencies, and write order.

For compact owners below 12 JSX elements, the same proof emits an action only when the leaf boundary excludes at least
five elements. This retains the existing material-render-cut requirement without hiding useful deferred or frame-scheduled
leaves in smaller components.

### 3. Broad read → lowest observable path

Before: any `profile$` child can invalidate the component.

```tsx
const profile = useValue(profile$);
return <Name>{profile.name}</Name>;
```

Output:

```text
Profile.tsx:18 [narrow-use-value-subscription] Narrow `profile` from
`useValue(profile$)` to `useValue(profile$.name)`.
```

After: only `profile$.name` is observed.

```tsx
const name = useValue(profile$.name);
return <Name>{name}</Name>;
```

The rule follows nested children and selects the deepest static path shared by every read. Divergent fields, dynamic or
optional access, assertion boundaries, calls, writes, and raw object transport stay unchanged.

### Direct leaf → direct `useValue`

Before:

```tsx
const name = useValue(profile$.name.get());
const email = useValue(() => profile$.email.get());
```

Output:

```text
Profile.tsx:18 [pass-observable-to-use-value] Replace the eager read or
one-get selector with `useValue(profile$.name)`.
```

After:

```tsx
const name = useValue(profile$.name);
const email = useValue(profile$.email);
```

Keep a callback when it computes a value:

```tsx
const fullName = useValue(() => `${profile$.first.get()} ${profile$.last.get()}`);
```

### Legacy hook → `useValue`

[Legend State recommends this migration](https://legendapp.com/open-source/state/v3/react/react-api/#usevalue).

Before:

```tsx
import { useSelector, use$ } from "@legendapp/state/react";
const name = useSelector(profile$.name);
const email = use$(() => profile$.email.get());
const fullName = use$(() => `${profile$.first.get()} ${profile$.last.get()}`);
```

Output:

```text
Profile.tsx:18 [replace-legacy-use-value] Replace `useSelector(...)` with
`useValue(profile$.name)`.
```

After:

```tsx
import { useValue } from "@legendapp/state/react";
const name = useValue(profile$.name);
const email = useValue(profile$.email);
const fullName = useValue(() => `${profile$.first.get()} ${profile$.last.get()}`);
```

Use the observable directly for its raw value. Use a callback only to compute a value.

### 4. Whole-object clone → direct child write

Before: one field update clones and replaces every sibling.

```ts
const current = profile$.peek();
profile$.set({ ...current, name });
```

Output:

```text
profile.ts:24 [narrow-observable-write] Replace the whole-object clone with
`profile$.name.set(name)`.
```

After:

```ts
profile$.name.set(name);
```

For keyed records, the same rule targets the changed entry:

```ts
records$[recordId].set(record);
```

For an exact one-item array append:

```ts
// Before
pages$.set(previous => [...previous, nextPage]);

// After
pages$.push(nextPage);
```

Prepend, sort, filter, multiple appended values, calls, getters, and unproven array roots stay unchanged.

The clone also stays when later code can still observe the old snapshot:

```ts
const current = profile$.peek();
const previous = current;
profile$.set({ ...current, name });
audit(previous.name);
```

Changing this to `profile$.name.set(name)` would mutate the object behind `previous`. The rule therefore checks later
reads, aliases, nested callbacks, and repeating loop conditions before recommending direct mutation.

### 5. Multiple writes → one publication

Before:

```ts
player$.error.set(message);
player$.isLoading.set(false);
player$.isPlaying.set(false);
```

Output:

```text
LocalAudioPlayer.tsx:257 [assign-observable-fields] Replace 3 `.set()` calls with one
`player$.assign(...)`; observers publish once.
```

After:

```ts
player$.assign({ error: message, isLoading: false, isPlaying: false });
```

The tool uses `batch()` when writes span observables or `.assign()` would change evaluation semantics.

### 6. Boolean flip → direct toggle

[Legend State provides `toggle()` for observable booleans](https://legendapp.com/open-source/state/v3/usage/observable/).

Before:

```ts
settings$.enabled.set(!settings$.enabled.peek());
```

Output:

```text
settings.ts:24 [toggle-observable] Replace the exact boolean flip with
`settings$.enabled.toggle()`.
```

After:

```ts
settings$.enabled.toggle();
```

The rule also recognizes `settings$.enabled.set(value => !value)`. It does not rewrite `.get()` because that read may
intentionally participate in Legend tracking. Dynamic paths, different source paths, and unproven observables stay unchanged.

### 7. Command read → non-tracking snapshot

Before:

```tsx
const onSave = () => save(profile$.name.get());
```

Output:

```text
Profile.tsx:24 [use-peek-for-snapshot] Replace `profile$.name.get()` with
`profile$.name.peek()`; this code path needs a snapshot, not a reactive dependency.
```

After:

```tsx
const onSave = () => save(profile$.name.peek());
```

The rule is limited to proven React snapshots and event commands. Render reads, Legend reactions, unknown callbacks,
dynamic paths, and shallow `get(true)` stay unchanged.

### 8. Teardown effect → explicit lifecycle

Before:

```tsx
useEffect(() => () => tooltip.hide(), []);
```

Output:

```text
Tooltip.tsx:93 [use-unmount] Replace this teardown-only empty-dependency effect with
`useUnmount` if once-only Legend lifecycle semantics are intended.
```

This is a `candidate`, never an automatic `change`: `useUnmount` suppresses React Strict Mode replay, so the agent must
verify project policy and lifetime intent first.

After:

```tsx
useUnmount(() => tooltip.hide());
```

### 9. Commit-sensitive state → review before moving

Before:

```tsx
const [bounds, setBounds] = useState<DOMRect | null>(null);
const measure = useCallback(() => setBounds(node.getBoundingClientRect()), [node]);
useLayoutEffect(measure, [measure]);
```

Output:

```text
Panel.tsx:18 [review-state] Review React state `bounds`; its value or setter
crosses a boundary this local analysis cannot prove safe.
```

The same safety model covers `useEffect`, `useLayoutEffect`, and `useInsertionEffect`, including imported aliases,
`React.*` calls, named functions, immutable callback aliases, and `useCallback` bindings. Local lookalikes are ignored.

When lifecycle-written state never renders and is read only by commands, the tool removes the wasted render while keeping
the hook:

```tsx
// Before
const [chartElements, setChartElements] = useState<Element[]>([]);
useLayoutEffect(() => setChartElements(buildChart(data)), [data]);
const insert = () => insertElements(chartElements);

// After
const chartElementsRef = useRef<Element[]>([]);
useLayoutEffect(() => {
  chartElementsRef.current = buildChart(data);
}, [data]);
const insert = () => insertElements(chartElementsRef.current);
```

The action is `use-ref`; the lifecycle hook, dependency list, and commit timing remain unchanged.

Pointer or listener snapshots can also move as one ref group when one synchronous event writes the complete group and
every read stays inside event commands or memoized callbacks owned by an exact add/remove listener effect. The tool emits
one grouped migration because converting only part of that snapshot would keep the original render and split its update.
Missing cleanup, async callbacks, callback escapes, rendered values, functional updates, and event regions that write any
remaining React state stay under review.

One previous-command snapshot inside an imported `useCallback` can also become a ref when that command is invoked only
from direct React effects and their nested listeners. The proof keeps every effect and cleanup, rejects callback escape
and post-write reads, and removes only the snapshot from the callback dependencies. This eliminates the state-driven
callback refresh and listener re-registration without moving lifecycle ownership.

A cohesive button that intentionally delays its pending flag stays on React state when the timer callback contains only
the `true` write and the same async command clears that timer immediately before the `false` write in `finally`.

A custom hook can also return one navigation command backed by a ref when the cursor's only read is the discriminant of
one synchronous switch and every branch issues exactly one imported command. One default branch may use an exact
parameter guard that issues an imported command and bare return before one imported fallback command. Returned getters,
extra reads, async work, other conditional branches, and callbacks consumed anywhere else remain reviews.

### 10. Render callbacks and old snapshots → review

Before: the state looks command-only unless the analyzer follows `renderItem`.

```tsx
const [highlighted, setHighlighted] = useState<Set<string> | null>(null);
const renderItem = ({ item }) => (
  <Row highlighted={highlighted?.has(item.id) ?? false} />
);
return <List renderItem={renderItem} />;
```

Output:

```text
BaseSelectionList.tsx:121 [review-state] Legend-first restructuring candidate:
replace `itemsToHighlight` with observable ownership and move its subscription
into the smallest rendered subtree.
```

A verified migration keeps observable ownership above the list and subscribes per row:

```tsx
const highlighted$ = useObservable<Set<string> | null>(null);

function HighlightedRow({ id, highlighted$ }) {
  const highlighted = useValue(() => highlighted$.get()?.has(id) ?? false);
  return <Row highlighted={highlighted} />;
}
```

Functional updates have a separate snapshot hazard:

```tsx
setMinutes(previous => previous + 1);
if (minutes >= refreshAfter) reload(); // reads the old render snapshot
```

The tool emits a ref migration only when source resolution proves that the custom-hook callback is exclusively deferred
through a React effect and the updater is one synchronous counter step. The recommendation snapshots
`minutesRef.current` before the write and keeps the later comparison on that snapshot. Mixed synchronous/deferred hooks,
async gaps, multiple writes, and non-counter updaters remain review findings.

The same source proof follows a getter passed in a custom-hook options object through imported project hooks. A getter
stored in a React ref qualifies only when the same property is refreshed by one React effect and every invocation remains
under a resolved effect-deferred callback. Render-time invocation, missing refresh, aliasing, ref escape, and unresolved
hooks abstain. This removes command-only React state without introducing an unnecessary observable or render subscriber.

### 11. Published getter → keep the notification boundary

Before: React state republishes a getter to render consumers.

```tsx
function AttachmentStateProvider({ children }) {
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const isLoaded = useCallback(id => loaded[id] === true, [loaded]);
  const value = useMemo(() => ({ isLoaded, setLoaded }), [isLoaded]);
  return <AttachmentState.Provider value={value}>{children}</AttachmentState.Provider>;
}
```

Output:

```text
AttachmentStateProvider.tsx:18 [review-state] The Context value publishes a
state-reading getter; React state currently refreshes its consumers.
```

A local `useRef` replacement is unsafe because ref writes do not publish a new Context value. A complete migration must
change the contract so each consumer subscribes to the observable leaf:

```tsx
function AttachmentRow({ id, loaded$ }) {
  const loaded = useValue(loaded$[id]);
  return <Status loaded={loaded === true} />;
}
```

The same boundary applies to returned custom-hook getters, effect/focus callbacks, and raw state snapshots exposed through
`useImperativeHandle`.

## Actions

| Disposition | Agent response |
| --- | --- |
| `change` | Proof is complete. Implement and verify. |
| `candidate` | Inspect the final ownership or subscription boundary. |
| `keep` | React already owns the correct state or lifecycle. |

Legend Doctor is Legend-first, not conversion-first. It keeps React when resource lifetime, commit timing, cleanup, or a
cohesive leaf makes React the better owner.

## Next steps

1. Legend-native value: expand proven batching, `peek()` versus `get()`, direct observable reads, narrow subscriptions, and child writes.
2. Hook recall: require five equivalent positives across three apps for a new proof family; a narrow extension to an
   existing family may instead use one pinned positive, adversarial escape negatives, and a zero-regression full-corpus delta.
3. Publish hardening: add a license, package files, install smoke test, and CI release workflow.

The current phase, exact deltas, deferred opportunities, and restart criteria are in [NEXT_PHASE.md](NEXT_PHASE.md).

## Next improvement loop

| Step | Done when |
| --- | --- |
| Pin evidence | A new app commit reproduces exact hook counts and includes both actionable cases and hard negatives. |
| Prove one family | A new family has five equivalent positives across three app roots; a narrow extension has a pinned positive, adversarial negatives, and zero unrelated corpus deltas. |
| Release the rule | Typecheck, every unit test, grouped migrations, and the complete pinned eval pass; the app-by-app action delta is recorded. |

Start from corpus evidence. Extend one existing proof family when possible. Keep unmatched lifecycle, cross-file ownership,
and state-machine cases as review findings until their boundary is explicit.

## Development

```bash
npm run typecheck
npm test
```

Rules are split so agents can work on one proof family at a time:

| File | Responsibility |
| --- | --- |
| `src/analyze-source.ts` | Hook inventory, evidence, orchestration |
| `src/rules/effects.ts` | Effect and lifecycle rules |
| `src/rules/effect-drafts.ts` | Effect-synchronized drafts |
| `src/rules/async-leaf-status.ts` | Event-owned async status leaves |
| `src/rules/command-only-state.ts` | Command-only state, callback publication, and ref safety |
| `src/rules/source-callback-contract.ts` | Cross-file custom-hook callback timing and ref-storage proofs |
| `src/rules/hook-keyed-cursor-contract.ts` | Cross-file stable-keyed row cursor consumers |
| `src/rules/deferred-reveal.ts` | Deferred reveal and render gates |
| `src/rules/keyed-selection.ts` | Row and collection selection |
| `src/rules/lazy-callback-leaf.ts` | Lazy owner state rendered in one nested callback leaf |
| `src/rules/observable-clone-writes.ts` | Narrow child and exact array-append writes |
| `src/rules/observable-reads.ts` | Direct and lowest-path reads |
| `src/rules/observable-toggle.ts` | Exact observable boolean flips |
| `src/rules/state-proofs.ts` | Shared state and JSX proofs |
| `src/state-flow.ts` | Bounded write ordering, structural exclusion, and synchronous transaction proofs |
| `src/analyze-legend-practices.ts` | Legend practice orchestration and write transactions |

Pinned repositories, labels, and acceptance gates live in [evals/README.md](evals/README.md).

The tool recommends changes. It does not edit application code.
