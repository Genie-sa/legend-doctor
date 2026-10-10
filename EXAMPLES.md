# Legend Doctor examples

Use these examples after reading a finding. They show the shape of an edit, not permission to apply it.

- Apply `change` findings as written.
- Inspect `candidate` findings first.
- Preserve ownership, timing, mount identity, keys, cleanup, and atomic updates.
- When a finding carries `edits`, apply those instead of retyping the example. See
  [REPORT.md](REPORT.md#machine-applicable-edits).

The snippets assume these imports when needed:

```tsx
import { batch, type Observable } from "@legendapp/state";
import { Computed, useObservable, useObserveEffect, useValue } from "@legendapp/state/react";
import { $React } from "@legendapp/state/react-web";
```

## Remove state that adds no value

### Delete unused state

`delete-unused-state` removes the state cell. It keeps any work done while calculating the discarded value.

```tsx
// Before
const [, setTick] = useState(0);
const refresh = () => setTick(loadVersion());

// After
const refresh = () => {
  loadVersion();
};
```

### Calculate derived values during render

`delete-derived-state` removes the render that shows a stale value after an input changes and the effect-driven
render that corrects it.

```tsx
// Before
const [total, setTotal] = useState(price * quantity);
useEffect(() => setTotal(price * quantity), [price, quantity]);

// After
const total = price * quantity;
```

If that was the effect's only work, `delete-effect` removes the empty effect too.

When the initializer differs from the value the effect writes, such as `useState(0)`, the first commit shows the
initializer. Calculating during render would change that first commit, so the finding is `keep-state`.

### Remove a React mirror

`use-value` keeps the Legend value as the only owner.

```tsx
// Before
const savedName = useSavedName();
const [name, setName] = useState(savedName);
const rename = (next: string) => {
  setName(next);
  writeName(next);
};

// After
const name = useSavedName();
const rename = writeName;
```

## Put state at the right owner

### Move local state into its only child

Use `move-state-down` when one child owns every read and write.

```tsx
// Before
function Page() {
  const [query, setQuery] = useState("");
  return (
    <>
      <Dashboard />
      <Search value={query} onChange={setQuery} />
    </>
  );
}

// After
function Page() {
  return (
    <>
      <Dashboard />
      <Search />
    </>
  );
}

function Search() {
  const [query, setQuery] = useState("");
  return <input value={query} onChange={(event) => setQuery(event.target.value)} />;
}
```

Keep state above conditional or repeated children when moving it would change its lifetime.

### Keep owner lifetime and subscribe in a leaf

Use `use-observable` when the owner still needs a stable handle but only a small leaf renders the value.

```tsx
// Before: typing renders Page
function Page() {
  const [query, setQuery] = useState("");
  const save = () => submit(query);
  return (
    <>
      <Dashboard />
      <input value={query} onChange={(event) => setQuery(event.target.value)} />
      <button onClick={save}>Save</button>
    </>
  );
}

// After: typing renders QueryInput
function Page() {
  const query$ = useObservable("");
  const save = () => submit(query$.peek());
  return (
    <>
      <Dashboard />
      <QueryInput query$={query$} />
      <button onClick={save}>Save</button>
    </>
  );
}

function QueryInput({ query$ }: { query$: Observable<string> }) {
  const query = useValue(query$);
  return <input value={query} onChange={(event) => query$.set(event.target.value)} />;
}
```

The owner creates the observable. The leaf creates the subscription. The save command uses a non-tracking snapshot.

### Publish hook-owned presentation state

The hook keeps its lifetime and write timing. Its consumers subscribe only at proven presentation sites.

```tsx
// hooks.ts
export function useUploadStatus() {
  const status$ = useObservable<"idle" | "pending" | "done">("idle");
  const upload = useCallback(() => {
    status$.set("pending");
    queueMicrotask(() => status$.set("done"));
  }, []);
  return { status$, upload };
}

// Broad.tsx: only the button subscribes
const { status$, upload } = useUploadStatus();
return (
  <Page>
    <ExpensiveContent />
    <Computed>{() => <UploadButton status={status$.get()} onClick={upload} />}</Computed>
  </Page>
);
```

The report must prove every indexed consumer independently. Keep plain values at existing child APIs; do not move
storage into those children. Internal hook reads, exposed setters, unsafe consumers, and commit-sensitive owners
remain reviews. Apply a closed co-written hook group as one observable object with atomic assignments.

### Keep small local state in React

`keep-state` means an observable would add machinery without making the render boundary smaller.

```tsx
function Search() {
  const [query, setQuery] = useState("");
  return <input value={query} onChange={(event) => setQuery(event.target.value)} />;
}
```

## Subscribe only where values render

### Narrow a field subscription

Use `narrow-use-value-subscription` when a component reads one field.

```tsx
// Before: any profile field can wake this component
const profile = useValue(profile$);
const name = profile.name;

// After: only name can wake it
const name = useValue(profile$.name);
```

The finding needs a production write that changes another field under the subscribed parent without touching the
read one. Otherwise nothing the narrow subscription skips ever changes, and the action abstains. That covers a parent
passed in as a prop, a parent that is only replaced whole, and a field only ever written together with the read one.

A single-property destructure such as `const { name } = useValue(profile$)` carries `edits` that produce
`const name = useValue(profile$.name)`. Renaming reads of a whole-value binding stays prose.

A map read at one key narrows the same way:

```tsx
// Before: a write to any area wakes this label
const allAreas = useValue(areas$);
return <span>{allAreas[areaId]?.name}</span>;

// After: only areas$[areaId] can wake it
const area = useValue(areas$[areaId]);
return <span>{area?.name}</span>;
```

Every read must index the value with the same key, and the key must be fixed for the render: a literal, a prop or
parameter, or a `const`. When that `const` comes after the subscription, the finding says to declare the narrowed
subscription after it, which holds only when nothing in between reads the value, returns, or throws. The finding
needs a production write that changes one entry without replacing the map, and no other subscription, observer
read, dependency-free effect, ref or `peek()` render read, or subscribing parent that renders the owner on the same
change.

For a derived primitive, keep the comparison inside the selector:

```tsx
const selected = useValue(() => selectedId$.get() === id);
```

### Drop a subscription no render reads

Use `peek-unrendered-use-value` when a `useValue` result feeds only a hook initial value or a synchronous event
handler. The subscription reruns the component on every update for a value its output never shows.

```tsx
// Before: every play or pause renders the whole playlist
const isPlaying = useValue(player$.isPlaying);
const wasPlayingRef = useRef(isPlaying);
const toggle = useCallback(() => setPlaying(!isPlaying), [isPlaying]);

// After: reads take a snapshot when they run
const wasPlayingRef = useRef(player$.isPlaying.peek());
const toggle = useCallback(() => setPlaying(!player$.isPlaying.peek()), []);
```

The path must be seeded with plain data or a module constant of a literal, so dropping the subscription never
delays a lazy `synced` or computed source. A persisted store is lazy: its first read starts the load, so it stays
out of scope. The result may sit behind `!`, a type assertion, or `?? fallback`; each rewritten read keeps the
fallback, which must be a literal or a module `const`. The action abstains when a render reads a ref, `peek()`,
or an untracked `get()` that could depend on the forced rerender, and when a read is awaited, deferred, or captured
by a callback that omits the value from its dependencies. A `path$.get()` directly inside the synchronous selector of
`useValue`, `use$`, or `useSelector` is tracked by that hook and does not block it.

Two more reads take a snapshot safely. A compare-and-set guard, `if (value !== next) path$.set(next)`, in an inline
handler or a bare owner-level callback skips only writes Legend drops anyway, since `set` notifies nothing when the
stored value is identical; `next` must be a literal or a local name, and the comparison must be the guard's last
condition with no `else`. The initializer of an owner-level `const` that nothing references, and that assigns
nothing, never reaches output, so its read becomes a `peek()` as well.

### Split unrelated leaves

`split-use-value-leaves` gives each leaf its own field subscription. It requires an object-literal initial value
that proves the field set, and a production write that changes an unread data field without touching a read one.
When every field that changes is already read, or the only unread fields are constants and functions, the split
removes no render and the action abstains.

Both actions count writes by synchronous stretch, not by line. Writes in the same function body before an `await`,
or inside one `batch` or array callback, land in one render, so an unread field written beside a read one proves
nothing. A write after an `await`, or in a separate handler or listener, is its own stretch. Writes in the
module body run while the module loads, before any importer renders, so they never count.

```tsx
function Profile() {
  return (
    <>
      <Name name$={profile$.name} />
      <Avatar url$={profile$.avatarUrl} />
    </>
  );
}

function Name({ name$ }: { name$: Observable<string> }) {
  return <span>{useValue(name$)}</span>;
}

function Avatar({ url$ }: { url$: Observable<string> }) {
  return <img src={useValue(url$)} />;
}
```

This also shows `move-use-value-down` and `move-use-value-into-child`: the parent passes observable references, not
rendered values.

### Move one subscription into several children

When one observable feeds separate small parts of a large owner, `move-use-value-down` can name several
boundaries in one instruction. Move every named read together so the parent no longer subscribes.

```tsx
function Settings({ enabled$ }: { enabled$: Observable<boolean> }) {
  return (
    <main>
      <UnrelatedSettings />
      <section>
        <EnabledInput enabled$={enabled$} label="Vertical" />
      </section>
      <aside>
        <EnabledInput enabled$={enabled$} label="Horizontal" />
      </aside>
    </main>
  );
}

function EnabledInput({ enabled$, label }: { enabled$: Observable<boolean>; label: string }) {
  const enabled = useValue(enabled$);
  return <input aria-label={label} disabled={!enabled} />;
}
```

Define the children outside the parent, keep observable ownership unchanged, and pass other inputs as ordinary
props. Keep the evaluation of those inputs in the parent. If a named boundary contains a conditional, keep the
whole condition inside its always-mounted child. Prefer one cohesive child when it already isolates the reads;
separate subscriptions add overhead and are justified only when their combined render work stays small.

### Remove selector work and legacy names

Use `pass-observable-to-use-value` for a direct value and `replace-legacy-use-value` for `use$` and `useSelector`,
which Legend State deprecates in favor of `useValue` and plans to remove.

```tsx
useValue(() => profile$.name.get()); // Before
useValue(profile$.name); // After

useSelector(profile$.name); // Before
useValue(profile$.name); // After
```

The same-node synchronous selector rewrite without options is `style`: it selects the same value, with no proven
render or lifecycle saving. Inside `observer`, direct input can use the enclosing observer's tracking instead of a
separate selector hook. Async selectors and calls with options remain unchanged because their Promise or tracking
contracts can differ. An eager `useValue(profile$.name.get())` is still `change`: direct input establishes tracking in
an ordinary component or avoids redundant selector hooks inside `observer`. Keep `useValue(() => ...)` when the
selector derives a value from one or more observables, including boolean projections and formatted computed values.

Both actions carry `edits`. A legacy migration renames every legacy call in the file and removes the legacy import
specifiers together, so each of those findings carries the same file-wide edit set.

### Select a derived primitive

This is a manual pattern; no action reports it on its own. When a `useMemo` derives a primitive from observable reads
that nothing else in the component reads, select the primitive instead.

```tsx
// Before: every write under habits$.streaks renders the component
const streaks = useValue(habits$.streaks);
const longest = useMemo(
  () => Math.max(0, ...Object.values(streaks).map((s) => s.longest)),
  [streaks],
);

// After: the selector reruns on each render, and a write renders only when the number changes
const longest = useValue(() =>
  Math.max(0, ...Object.values(habits$.streaks.get()).map((s) => s.longest)),
);
```

Keep the memo when an input is also read elsewhere in the component, since that read renders on every write anyway,
or when the result is an object or array, since `useValue` compares by reference and a new result always renders.
`snapshot-mutated-use-value` recommends this rewrite when an in-place write leaves such a memo stale.

### Update one host prop

A reactive host prop can update without rendering a heavy owner.

```tsx
// Before
const width = useValue(width$);
return (
  <div style={{ width }}>
    <LargeChart />
  </div>
);

// After
return (
  <$React.div $style={() => ({ width: width$.get() })}>
    <LargeChart />
  </$React.div>
);
```

Use this only when the report proves one small reactive boundary is cheaper than the owner render.

## Keep related state together

### Split an object draft by field

Each field subscribes to its own path. Submit reads one snapshot.

```tsx
type Draft = { name: string; email: string };

function Form() {
  const draft$ = useObservable<Draft>({ name: "", email: "" });
  const submitForm = () => save({ ...draft$.peek() });

  return (
    <>
      <TextField value$={draft$.name} />
      <TextField value$={draft$.email} />
      <button onClick={submitForm}>Save</button>
    </>
  );
}

function TextField({ value$ }: { value$: Observable<string> }) {
  const value = useValue(value$);
  return <input value={value} onChange={(event) => value$.set(event.target.value)} />;
}
```

### Publish one logical update

Use `assign-observable-fields` for sibling fields.

```tsx
dialog$.open.set(true);
dialog$.item.set(item); // Before

dialog$.assign({ open: true, item }); // After
```

Use `batch-observable-writes` across separate observable roots.

```tsx
batch(() => {
  session$.user.set(user);
  router$.route.set("home");
});
```

This preserves an atomic transition: subscribers see one completed update.

React already commits writes from one synchronous stretch in one render, so neither action saves a React render. Both
appear only when one non-React tracker in the same file reads two or more of the written paths: an `observe`,
`useObserve`, `useObserveEffect`, or `useComputed` body, or an `onChange` listener on a shared parent. Separate writes
rerun that tracker once per write, on torn state in between. `syncObservable` persistence queues changes until a
microtask, so it saves them together either way.

### Preserve a conditional child's mount behavior

Keep the observable at the owner. Put the condition in a stable leaf.

```tsx
function Page() {
  const open$ = useObservable(false);
  return (
    <>
      <Canvas />
      <button onClick={() => open$.set(true)}>Open</button>
      <PanelGate open$={open$} />
    </>
  );
}

function PanelGate({ open$ }: { open$: Observable<boolean> }) {
  return useValue(open$) ? <Panel /> : null;
}
```

`PanelGate` stays mounted. `Panel` keeps its original conditional mount.

### Subscribe once per keyed row

Keep the stable key on the subscriber.

```tsx
function RowState({ id, selectedId$ }: { id: string; selectedId$: Observable<string | null> }) {
  const selected = useValue(() => selectedId$.get() === id);
  return <Row selected={selected} />;
}

rows.map((row) => <RowState key={row.id} id={row.id} selectedId$={selectedId$} />);
```

Index keys and state-controlled row mounts need review.

## Keep command state out of renders

### Replace render-free state with a ref

Use `use-ref` when a value is never rendered.

```tsx
// Before
const [socket, setSocket] = useState<WebSocket | null>(null);
useEffect(() => {
  setSocket(connect());
}, []);
const send = () => socket?.send("ping");

// After
const socketRef = useRef<WebSocket | null>(null);
useEffect(() => {
  socketRef.current = connect();
}, []);
const send = () => socketRef.current?.send("ping");
```

### Use a non-tracking snapshot

`use-peek-for-snapshot` marks a read that needs a snapshot, not a dependency. Handlers, effects, and `onChange`
listeners run outside any tracker, where `get()` already reads without subscribing, so there the finding is style. It is
a change only for a `useState` initializer inside an `observer` render, where `get()` would subscribe the component.

```tsx
const save = () => persist(settings$.theme.get()); // Before
const save = () => persist(settings$.theme.peek()); // After
```

Render reads and reactive callbacks keep tracking reads. The finding's `edits` rename `get` to `peek`.

## Track every render read

Legend tracks a `get()` only inside a tracking context: `useValue`, `observer`, a reactive component's selector, or
`observe`/`when`. These findings catch reads that fall outside one, or whose change a memo hides. Legend State
discourages render-time `get()` even inside `observer`; read rendered values through `useValue`.

### Subscribe to a render read

`use-value-for-render-read` changes a `get()` that runs in a component's or custom hook's render, including
synchronous `.map`-style callbacks, with nothing tracking it. When the package's Babel config lists
`@legendapp/state/babel`, reads among the element children of `Computed`, `Memo`, and `Show` are tracked, because the
plugin wraps those children in a function.

```tsx
// Before: Counter renders the value once and never again
function Counter() {
  const value = state$.value.get();
  return <div>{value}</div>;
}

// After
function Counter() {
  const value = useValue(state$.value);
  return <div>{value}</div>;
}
```

The direct initializer form carries `edits`, including a `useValue` specifier beside an existing
`@legendapp/state/react` import. It carries none after an early return, where the new hook would be conditional.
A read inside a conditional, JSX, or iteration callback gets a hoisting instruction: add `const value =
useValue(path$)` at the top of the owner and read the binding there. Inside `observer` and `reactiveObserver`
components the read already tracks and `useValue(path$)` performs the same `get()`, so only the direct initializer
form is reported, as `style` with the same edit. The rule stays silent for paths a `useValue` in the same owner
already covers (directly, through a selector, or through a `const` alias), for hook-argument snapshots such as
`useState(x$.get())`, for reads handed to a Legend input that tracks on its own (`Show if`, `For each`, a `Memo`
child, a `$` prop, or `when`), for `key` reads, and for `get(true)` or dynamically keyed paths.

### Select a copy when a memo keys on a mutated value

`snapshot-mutated-use-value` changes a `useValue` whose raw result keys a `useMemo` while another write mutates that
value in place.

```tsx
// Elsewhere: library$.folders.push(folder), library$.folders[i].name.set(name), or counts$.assign({ b: 2 })

const folders = useValue(library$.folders); // Before
const folders = useValue(() => [...library$.folders.get()]); // After
const visible = useMemo(() => folders.filter((folder) => !folder.deleted), [folders]); // Unchanged
```

Legend applies child writes, array mutators, `assign`, and `delete` to the object it already holds, so `useValue`
rerenders the component with the same reference and the memo returns its previous result. A copy selected inside
`useValue` gets a new reference on every tracked change. If the derivation is cheap, computing it without `useMemo`
is equally correct. When that memo is the value's only reader and computes a primitive without side effects, the
finding instead recommends [selecting the primitive](#select-a-derived-primitive) and deleting both the memo and the
`useValue` binding.

The finding names each in-place write and fires only when the memo reads what the write changes: a membership write
against any element read, a field write against a read of that field. It is a `change` when every other dependency
keeps its identity across renders (module constants, refs, state setters, owned observables) and a `candidate` when
another dependency could change in the same update and recompute the memo. Writes that replace the value with
`set(next)`, writes to unread fields, `get(true)` reads, and bindings that are reassigned stay silent.

### Re-render a Memo child that reads parent values

`use-computed-for-parent-reads` changes a `<Memo>` whose child reads a value from its owner's render.

```tsx
const offset = useValue(feed$.offset);
const index = offset + position;

<Memo>{() => <Fork at={index} forks={forks$.get()} />}</Memo>; // Before
<Computed>{() => <Fork at={index} forks={forks$.get()} />}</Computed>; // After
```

`Memo` wraps `Computed` in `React.memo` with an equality check that ignores new children unless `scoped` is set, so
the owner's renders never reach the child. The child tracks the observables it reads, but every value it captures
from the owner stays at the Memo's first render. `Computed` re-renders with its parent and keeps the same tracking.

It is a `change` when a captured value changes whenever the owner re-renders for it: a `useValue`, `use$`, or
`useSelector` result, React state whose setter is used, a `useSyncExternalStore` result, or a value, callback, or
local render helper computed from one. It is a `candidate` when the child reads only props, context or custom-hook
results, or values computed from them, which may stay constant for the Memo's lifetime. Observables, including props
the component's type declares `Observable`, refs, state setters, owned observables, module values, and callbacks
memoized without changing dependencies keep their identity and stay silent, as do `scoped` Memos and values read
only inside event handlers.

## Keep effect timing correct

### Move event-owned work to the event

`move-to-event` removes an effect-driven second transition.

```tsx
// Before
useEffect(() => setPage(1), [query]);
const changeQuery = (next: string) => setQuery(next);

// After
const changeQuery = (next: string) => {
  setQuery(next);
  setPage(1);
};
```

Every query change must come through the proven event path.

### Reset state when an input changes

`reset-during-render` removes the stale commit an effect renders before it resets state for new props, params, or
loaded data.

```tsx
// Before
const [selected, setSelected] = useState(0);
useEffect(() => setSelected(0), [query]);

// After
const [selected, setSelected] = useState(0);
const [prevQuery, setPrevQuery] = useState(query);
if (!Object.is(query, prevQuery)) {
  setPrevQuery(query);
  setSelected(0);
}
```

The effect body must only set the owner's state from pure values, under at most one `if`, with no cleanup, and must
not read the state it resets. The effect's mount write must be a no-op so the first commit stays the same: each value
is the state's own initializer, or the `if` pins one input to literals, as in `kind === "a" || kind === "b"`, under
each of which the initializer evaluates to the written value. An effect that replaces a placeholder after mount keeps
its timing. The comparison settles only when each dependency keeps its identity while React reruns the owner. A state
value, a module binding, a `length` or other primitive constant, a memo that returns only such values, or a component
prop proves that, since React reruns a component after a render-phase update with the same props; a destructuring
default must be a primitive or a module binding. A custom hook's parameter qualifies when its declared type is a
string, number, bigint, boolean, literal, `null`, or `undefined`, which a pure caller recomputes to a value the
`Object.is` guard finds equal, even `NaN`. Any other value the owner computes, such as a hook result, leaves a review
that asks about it. A function, object, or array the owner rebuilds every render keeps the effect.

### React to an observable without rendering

Use `use-observe-effect` when a `useValue` result exists only to run an external side effect.

```tsx
// Before
const theme = useValue(settings$.theme);
useEffect(() => syncTheme(theme), [theme]);

// After
useObserveEffect(() => syncTheme(settings$.theme.get()));
```

Keep the React effect when the same value also renders. Moving it could change post-commit timing. Keep it as well
when every parent that renders the component subscribes to the same observable: the parent's render already reruns
the component on each change, so dropping `useValue` saves nothing. When a parent might rerender it, through an
ancestor subscription or a memoized child whose props may be stable, the finding is a review.

The observer tracks every `get()` it runs synchronously, including reads before the first `await` of an async
function it calls. A read of an observable that is not a dependency would become a new trigger, so the finding
names it and tells you to `peek()` it instead:

```tsx
// Before
const isPlaying = useValue(player$.isPlaying);
useEffect(() => {
  if (!isPlaying && window$.isOpen.get()) closeWindow();
}, [isPlaying]);

// After
useObserveEffect(() => {
  if (!player$.isPlaying.get() && window$.isOpen.peek()) closeWindow();
});
```

Reads after an unconditional `await` and reads inside timers or promise callbacks stay untracked, so they are left
alone. The finding becomes a review when a read runs in a callback of unknown timing, or calls `get()` on a receiver
that is not proven to be an observable.

A function the effect calls runs inside the observer's pass too, and its reads cannot be peeked from the effect. A
project function, local or imported, is followed up to its first unconditional `await`; if it reads an observable
there, the finding becomes a review that names the call. So does any call whose code is not followed: an import from a
module out of view, a method of an application object, a callback prop, a value a hook returns, or a function held in
a variable. Globals, packages, React setters and refs, built-in methods of constants, and observable writes stay
convertible.

```tsx
// Stays a React effect: loadThread reads mail$.errorId before its first await, so an observer
// would refetch every time a failed load records its error.
useEffect(() => {
  if (selectedId) void loadThread(selectedId);
}, [selectedId]);
```

### Keep empty-dependency lifecycle effects

Legend's `useMount(fn)` runs `useEffect(fn, [])` in production, and `useUnmount(fn)` is `useMount(() => fn)`. Rewriting
an empty-dependency effect with either removes no render or lifecycle cost, so the effect is `keep-effect`. Legend
State prefers `useMount` and `useUnmount` when writing new code; converting existing effects is optional.

```tsx
useEffect(() => {
  preload();
}, []);

useEffect(() => () => clearTimeout(timer.current), []);
```

The only difference is in development under Strict Mode: `useUnmount` skips the teardown of the simulated unmount. A
cleanup-free `useMount` setup still runs twice there, as the React effect does.

### Keep layout work before paint

A `useLayoutEffect` finding reports `hook: "useEffect"`. The effect runs after DOM mutation and before paint, so it
can only be deleted with its derived state, move its write into the event, wait on the state it writes, or stay
`keep-effect`. `use-observe-effect`, Legend persistence, and lifecycle aliases would run its work after the first paint.

```tsx
useLayoutEffect(() => {
  setHeight(ref.current?.offsetHeight ?? 0);
}, [label]);
```

### Persist an observable instead of writing storage

Use `persist-observable` when a dependency-driven effect only writes `localStorage` or `sessionStorage` and the value
it persists is an observable, or React state whose every member earns `use-observable`.

```tsx
// Before
const [filters, setFilters] = useState(defaultFilters);
useEffect(() => {
  localStorage.setItem("filters", JSON.stringify(filters));
}, [filters]);

// After, once `filters` migrates
const filters$ = useObservable(
  synced({
    initial: defaultFilters,
    persist: { name: "filters", plugin: ObservablePersistLocalStorage },
  }),
);
```

`synced` and `syncObservable` come from `@legendapp/state/sync`; the plugin matching the storage the effect wrote comes
from `@legendapp/state/persist-plugins/local-storage`. The finding stays a candidate because the storage key, the
serialized shape, and any mount effect that hydrates the same key need a manual check. While the persisted state stays
React, or a prop drives the write, the effect is `keep-effect`.

### Keep an effect while changing its storage

An effect may stay exactly where it is while its write target becomes observable.

```tsx
const ready$ = useObservable(false);

useEffect(() => {
  const id = subscribe(() => ready$.set(true));
  return () => unsubscribe(id);
}, [ready$]);
```

Preserve the dependency list, cleanup, statement order, and replay behavior unless the report proves another change.

## Simplify Legend writes

### Write the changed path

Use `narrow-observable-write` when container identity is not required.

```tsx
profile$.set({ ...profile$.peek(), name }); // Before
profile$.name.set(name); // After
```

```tsx
items$.set((previous) => [...previous, item]); // Before
items$.push(item); // After
```

The append form needs the observable path to start as an array literal. That proof resolves where the observable is
declared: in the current file, in the exporting module for an imported observable or a stable container member such as
`library.todos$`, and through `synced({ initial: [] })` when the initial value is a literal. A member that a later spread
or computed key could overwrite does not count.

React Compiler projects may need the new container identity. Follow the report's capability gate.

### Toggle directly

```tsx
menu$.open.set((value) => !value); // Before
menu$.open.toggle(); // After
```

`toggle-observable` is a style finding.

## Own observables once

### Reuse the observable you already have

```tsx
const user$ = useObservable(store$.user); // Before
const user$ = store$.user; // After
```

`observable()` and `useObservable()` return an observable argument unchanged, so the wrapper adds no ownership,
stability, or context. `useObservable` also deactivates the node it returns when the component unmounts, and that
node is the shared source. Nest one observable inside another only as an intentional link whose reads and writes
forward to the source.

## Final check

Before finishing:

1. Run the app's formatter, typecheck, and relevant tests.
2. Run Legend Doctor on the same root.
3. Compare reports from the same analyzer build.
4. Explain every finding that changed, including a zero delta.
