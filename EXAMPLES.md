# Legend Doctor examples

Use these examples after reading a finding. They show the shape of an edit, not permission to apply it.

- Apply `change` findings as written.
- Inspect `candidate` findings first.
- Preserve ownership, timing, mount identity, keys, cleanup, and atomic updates.
- Check the installed Legend State version and types.

The snippets assume these imports when needed:

```tsx
import { batch, type Observable } from "@legendapp/state";
import {
  Computed,
  useMount,
  useObservable,
  useObserveEffect,
  useUnmount,
  useValue,
} from "@legendapp/state/react";
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

`delete-derived-state` removes the stale first render and the effect-driven second render.

```tsx
// Before
const [total, setTotal] = useState(0);
useEffect(() => setTotal(price * quantity), [price, quantity]);

// After
const total = price * quantity;
```

If that was the effect's only work, `delete-effect` removes the empty effect too.

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

For a derived primitive, keep the comparison inside the selector:

```tsx
const selected = useValue(() => selectedId$.get() === id);
```

### Split unrelated leaves

`split-use-value-leaves` gives each leaf its own field subscription.

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

Use `pass-observable-to-use-value` for a direct value and `replace-legacy-use-value` for old APIs.

```tsx
useValue(() => profile$.name.get()); // Before
useValue(profile$.name); // After

useSelector(profile$.name); // Before
useValue(profile$.name); // After
```

Keep `useValue(() => ...)` when the selector derives a value from one or more observables.

### Compute a derived primitive as an observable

Use `derive-computed-observable` when every `useMemo` dependency is a `useValue` subscription read nowhere else and
every result is a primitive.

```tsx
// Before: any change to either field renders Header
const selectedView = useValue(library$.selectedView);
const selectedPlaylistId = useValue(library$.selectedPlaylistId);
const title = useMemo(
  () => (selectedView === "playlist" ? `playlist-${selectedPlaylistId}` : "Library"),
  [selectedView, selectedPlaylistId],
);

// After: the computed tracks both fields; Header renders only when the title string changes
const title$ = useObservable(() =>
  library$.selectedView.get() === "playlist"
    ? `playlist-${library$.selectedPlaylistId.get()}`
    : "Library",
);
const title = useValue(title$);
```

Keep the memo when it mixes props or component-local helpers with observable inputs, or when it returns an object or
array: a selector would recompute on every render, and a reference result renders on every input change either way.

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

`use-peek-for-snapshot` changes a proven command read.

```tsx
const save = () => persist(settings$.theme.get()); // Before
const save = () => persist(settings$.theme.peek()); // After
```

Render reads and reactive callbacks keep tracking reads.

## Track every render read

Legend tracks a `get()` only inside a tracking context: `useValue`, `observer`, a reactive component's selector, or
`observe`/`when`. These findings catch reads that fall outside one.

### Subscribe to a render read

`use-value-for-render-read` changes a `get()` that runs in a component's or custom hook's render, including
synchronous `.map`-style callbacks, with nothing tracking it.

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

A read inside a conditional, JSX, or iteration callback gets a hoisting instruction: add `const value =
useValue(path$)` at the top of the owner and read the binding there. The rule stays silent for `observer` and
`reactiveObserver` components, for paths a `useValue` in the same owner already covers (directly, through a selector,
or through a `const` alias), for hook-argument snapshots such as `useState(x$.get())`, for `key` reads, and for
`get(true)` or dynamically keyed paths.

### Pass the observable to a reactive input

`pass-observable-to-reactive-input` changes a `get()` or `peek()` handed to an input that tracks on its own.

```tsx
<Show if={ready$.get()}>{() => <Panel />}</Show>; // Before
<Show if={ready$}>{() => <Panel />}</Show>; // After

<For each={items$.get()}>{(item$) => <Row item$={item$} />}</For>; // Before
<For each={items$}>{(item$) => <Row item$={item$} />}</For>; // After

<Memo>{name$.get()}</Memo>; // Before
<Memo>{name$}</Memo>; // After

<$React.input $value={name$.get()} />; // Before
<$React.input $value={name$} />; // After

when(ready$.get(), start); // Before
when(ready$, start); // After
```

Covered inputs: `Show if`/`ifReady`, `Switch value`, `For each`, `Memo` and `Computed` children, `$`-prefixed props
on `$React`, native `$View`-style hosts and `reactive()` components, and the first argument of `observe`, `when`,
`whenReady`, `useObserve`, `useObserveEffect`, `useWhen`, and `useWhenReady`. The snapshot is evaluated once in the
parent's render, so the input only updates when the parent happens to re-render; `For` also calls `get()` on what it
receives, so a raw array breaks it. `useValue(x$.get())` stays with `pass-observable-to-use-value`.

### Split a selector that only builds a literal

`split-use-value-result` changes a destructured selector whose members are direct reads or inert expressions.

```tsx
const { a, b } = useValue(() => ({ a: state$.a.get(), b: state$.b.get() })); // Before
const a = useValue(state$.a); // After
const b = useValue(state$.b);
```

The selector returns a new object on every tracked change, so each destructured consumer sees a fresh identity.
Per-path subscriptions render on exactly the same changes and compare by value. Results used whole, block bodies,
spreads, defaults, rest elements, computed members, and calls stay as they are.

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

### React to an observable without rendering

Use `use-observe-effect` when a `useValue` result exists only to run an external side effect.

```tsx
// Before
const theme = useValue(settings$.theme);
useEffect(() => syncTheme(theme), [theme]);

// After
useObserveEffect(() => syncTheme(settings$.theme.get()));
```

Keep the React effect when the same value also renders. Moving it could change post-commit timing.

### Express proven lifecycle intent

Use `use-mount` and `use-unmount` only when lifecycle timing is proven equivalent.

```tsx
useEffect(() => start(), []); // Before
useMount(() => start()); // After

useEffect(() => () => stop(), []); // Before
useUnmount(() => stop()); // After
```

Keep the React effect when Strict Mode replay, setup work, or cleanup ownership could change.

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
React, or a prop drives the write, the effect is `keep-effect`. When the installed `@legendapp/state` has no `sync`
entry point, every such effect stays `keep-effect` and `capabilities.disabledRules` lists
`browser-storage-persistence` with reason `sync-export-missing`.

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

`toggle-observable` is a style finding. Check that the installed API supports `toggle()`.

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

### Snapshot an initial value instead of writing a computed

```tsx
const draft$ = useObservable(() => store$.user.name.get() || fallback); // Before
const draft$ = useObservable(store$.user.name.peek() || fallback); // After
draft$.set(event.target.value); // Unchanged
```

A function initializer with a tracked `get()` creates a computed observable, and a computed replaces any written
value on its next recomputation. The finding fires only when the owner also writes the observable; an initializer
that is never written stays a legitimate derivation, and a `linked` or `synced` body already declares its own setter.

## Final check

Before finishing:

1. Run the app's formatter, typecheck, and relevant tests.
2. Run Legend Doctor on the same root.
3. Compare reports from the same analyzer build.
4. Explain every finding that changed, including a zero delta.
