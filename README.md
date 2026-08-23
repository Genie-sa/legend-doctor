# Legend Doctor

Legend Doctor is a read-only analyzer for coding agents. It finds proven ways to remove owner
renders, post-commit updates, broad subscriptions, duplicate state, and fragmented observable writes.

The agent reads the evidence, makes one semantic change, runs the application's checks, and scans again. Findings that
lack timing or ownership proof stay as candidates.

## Agent prompt

```text
Run Legend Doctor on <absolute root> before editing. Apply proven change findings one semantic group at a time.
Preserve state lifetime, mount identity, effect timing, cleanup, dependencies, write order, keys, and atomic writes.
Inspect candidates and leave code unchanged unless source proves the missing fact. Run the app's formatter, typecheck,
and relevant tests, scan the same root again, and report the exact finding delta.
```

## Run it

```bash
npm install
npm run build
node dist/src/cli.js /absolute/path/to/app-or-feature --json --actionable
```

Scan the smallest complete root that contains the relevant components, hooks, imports, re-exports, and observables.
Legend Doctor resolves TypeScript configuration, component props, callback flow, barrels, and observable provenance across
files. A single-file scan can hide the proof needed for a safe result.

```bash
# Proven edits only
node dist/src/cli.js /absolute/path/to/root --json --disposition change

# Opportunities that need agent review
node dist/src/cli.js /absolute/path/to/root --json --disposition candidate

# Compact edit queue
node dist/src/cli.js /absolute/path/to/root --actionable

# Parsed files, functions, and skipped analysis stages
node dist/src/cli.js /absolute/path/to/root --json --coverage
```

`--actionable` includes `change` and `candidate` findings. It hides intentional `keep` findings.

## Agent loop

1. Scan before editing.
2. Apply one group of `change` findings.
3. Read every `candidate`. Edit only when the named source proves the missing fact.
4. Preserve lifecycle, mount identity, state ownership, command timing, keys, and atomic transitions.
5. Run the application's formatter, typecheck, and relevant tests.
6. Scan the same root again.
7. Report each added, removed, or changed finding, including a zero delta.
8. Stop when checks pass and every remaining finding is intentional.

Applied changes can expose a smaller subscription boundary, so the second scan is part of the edit, not optional cleanup.

## Output

Text output is a short edit queue:

```text
DocumentCopy.tsx:27:33 [use-observable] Replace async pending flag `copying` with a component-lifetime observable and wrap the stable pending-control call site in a leaf subscriber; preserve the event command's async completion boundary exactly.
DocumentCopy.tsx:29:38 [review-state] Legend-first restructuring candidate: replace `selectedPath` with observable ownership and move its subscription into the smallest rendered subtree; updates currently invalidate this owner with 12 JSX elements.
Scanned 1 files: 4 useState, 0 useEffect, 4 shown.
Re-run legend-doctor after applying change findings; applied changes can reveal new ones.
```

JSON is the agent interface. Each finding names the edit, proof, location, and required ownership boundary:

```json
{
  "action": "use-observable",
  "confidence": "probable",
  "disposition": "change",
  "evidence": [
    "owner: DocumentCopy, lines 22-118, JSX elements 12",
    "reads: render 2, effects 0, deferred 0, transported 0",
    "writes: setter calls 2, effect writes 0"
  ],
  "hook": "useState",
  "location": { "file": "DocumentCopy.tsx", "line": 27, "column": 33 },
  "message": "Replace async pending flag `copying` with a component-lifetime observable...",
  "name": "copying",
  "stateModel": {
    "ownership": "local-observable",
    "subscription": "leaf-use-value"
  }
}
```

| Disposition | Agent action |
| --- | --- |
| `change` | Apply the instruction. Structural proof is complete. |
| `candidate` | Inspect the named source. Resolve the missing timing, ownership, or type fact. |
| `keep` | Preserve the current React or lifecycle boundary. |
| `style` | Apply only when the installed Legend API supports the equivalent form. |

## Detected value

| Finding | Proven cost removed |
| --- | --- |
| `delete-unused-state` | Unused state cell and its updates |
| `delete-derived-state` | Post-commit synchronization and second render |
| `delete-effect` | Empty lifecycle left by deleted derived state |
| `move-state-down` | Parent render caused by one child's local edit |
| `use-observable` | Broad owner render while preserving owner lifetime |
| `use-ref` | Render caused by a value used only in commands or cleanup |
| `use-value` | Duplicate React ownership of a Legend value |
| `move-to-event` | Effect-driven second transition after an event |
| `use-observe-effect` | Component subscription used only by an external side effect |
| `use-mount`, `use-unmount` | Equivalent setup or teardown expressed with Legend lifecycle APIs |
| `narrow-use-value-subscription` | Updates to unread sibling observable fields |
| `split-use-value-leaves` | One broad subscription invalidating independent leaves |
| `move-use-value-down` | Observable updates rendering a broad parent |
| `pass-observable-to-use-value` | Redundant selector execution |
| `replace-legacy-use-value` | Legacy `useSelector` or `use$` call |
| `use-peek-for-snapshot` | Tracking read in a proven non-tracking command |
| `narrow-observable-write` | Parent clone and broad observable publication |
| `toggle-observable` | Boolean updater ceremony |
| `assign-observable-fields` | Several publications to sibling fields |
| `batch-observable-writes` | Several publications across related observable roots |
| `review-state`, `review-effect` | Unsafe guesses, surfaced with the exact missing proof |

## React state examples

### Delete unused state

```tsx
// before
const [, setTick] = useState(0);
const refresh = () => setTick(loadVersion());

// after, preserve argument evaluation
const refresh = () => { loadVersion(); };
```

### Calculate during render

```tsx
// before, commits once with stale data and again from the effect
const [total, setTotal] = useState(0);
useEffect(() => setTotal(price * quantity), [price, quantity]);

// after
const total = price * quantity;
```

### Move state into its only child

```tsx
// before
function Page() {
  const [query, setQuery] = useState("");
  return <><Dashboard /><SearchBox query={query} onChange={setQuery} /></>;
}

// after
function Page() {
  return <><Dashboard /><SearchBox /></>;
}
function SearchBox() {
  const [query, setQuery] = useState("");
  return <input value={query} onChange={event => setQuery(event.target.value)} />;
}
```

### Keep ownership above a dialog and subscribe in the leaf

```tsx
// before, selecting an account rerenders Accounts
const [target, setTarget] = useState<Account | null>(null);
return <><Accounts onDelete={setTarget} /><DeleteDialog account={target} /></>;

// after
const target$ = useObservable<Account | null>(null);
return <><Accounts onDelete={value => target$.set(value)} /><DeleteDialogState target$={target$} /></>;

function DeleteDialogState({ target$ }: { target$: Observable<Account | null> }) {
  return <DeleteDialog account={useValue(target$)} />;
}
```

### Preserve a conditional child's mount identity

```tsx
// before
const [open, setOpen] = useState(false);
return <><Canvas /><button onClick={() => setOpen(true)}>Open</button>{open && <Panel />}</>;

// after, PanelGate stays mounted while Panel keeps its conditional mount
const open$ = useObservable(false);
return <><Canvas /><button onClick={() => open$.set(true)}>Open</button><PanelGate open$={open$} /></>;

function PanelGate({ open$ }: { open$: Observable<boolean> }) {
  return useValue(open$) ? <Panel /> : null;
}
```

A gate may call an immutable local JSX factory. Legend Doctor resolves it only when the factory takes no arguments and
has one direct JSX return. Mutable bindings, wrapper factories, parameters, and multiple returns stay under review.

### Isolate event-computed overlay state

```tsx
// before, every scroll renders the page owner
const [scrolled, setScrolled] = useState(false);
const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
  const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
  setScrolled(scrollTop + clientHeight >= scrollHeight);
};
return <section>
  <div onScroll={onScroll}><Content /></div>
  {!scrolled && <Fade />}
  {!scrolled && <ScrollHint />}
  <Dashboard />
</section>;

// after, one stable leaf subscribes for both overlays
const scrolled$ = useObservable(false);
const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
  const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
  scrolled$.set(scrollTop + clientHeight >= scrollHeight);
};
return <section>
  <div onScroll={onScroll}><Content /></div>
  <ScrollPresentation scrolled$={scrolled$} />
  <Dashboard />
</section>;

function ScrollPresentation({ scrolled$ }: { scrolled$: Observable<boolean> }) {
  const scrolled = useValue(scrolled$);
  return <>{!scrolled && <Fade />}{!scrolled && <ScrollHint />}</>;
}
```

This proof requires one call-free boolean expression and adjacent bounded gates. The write may come from an intrinsic
event or directly from a React effect; an effect migration changes only the storage write and leaves the effect,
dependencies, cleanup, measurement, and statement position intact. Opaque calls, custom component callbacks, mixed
event/effect ownership, companion React writes, repeated output, and separated surfaces stay under review.

### Isolate a controlled value and its validation

```tsx
// before, each key renders the form owner
const [name, setName] = useState("");
return <><FormHelp /><NameInput value={name} onChange={setName} /><Save disabled={!name.trim()} /></>;

// after, the input and validation subscribe independently
const name$ = useObservable("");
return <><FormHelp /><NameState name$={name$} /><SaveState name$={name$} /></>;
```

### Derive controlled props inside one leaf

```tsx
// before, opening the dialog renders the page owner
const [open, setOpen] = useState(false);
return <><Dashboard /><DetailDialog id={open ? id : null} open={open} onOpenChange={setOpen} /></>;

// after, one subscriber derives every state-dependent dialog prop
const open$ = useObservable(false);
return <><Dashboard /><DetailDialogState id={id} open$={open$} /></>;

function DetailDialogState({ id, open$ }: Props) {
  const open = useValue(open$);
  return <DetailDialog id={open ? id : null} open={open} onOpenChange={value => open$.set(value)} />;
}
```

Opaque calls, repeated children, sibling consumers, and effect reads remain candidates.

### Isolate a compact transported boolean

```tsx
// before, opening the native menu also renders the toolbar and press target
const [expanded, setExpanded] = useState(false);
const open = () => setExpanded(true);
const dismiss = () => setExpanded(false);
return <><Toolbar /><PressTarget onPress={open} /><NativeMenu expanded={expanded} onDismiss={dismiss} /></>;

// after, the owner keeps the lifetime and the menu owns the subscription
const expanded$ = useObservable(false);
const open = () => expanded$.set(true);
const dismiss = () => expanded$.set(false);
return <><Toolbar /><PressTarget onPress={open} /><NativeMenuState expanded$={expanded$} onDismiss={dismiss} /></>;

function NativeMenuState({ expanded$, onDismiss }: Props) {
  return <NativeMenu expanded={useValue(expanded$)} onDismiss={onDismiss} />;
}
```

The compact-owner proof requires an independent rendered sibling and terminal local boolean writes. Setter forwarding,
companion state writes, reactive mutations, or work after a setter keep the finding under review.

### Leave an existing leaf alone

```tsx
// already the smallest useful React owner
function Field() {
  const [value, setValue] = useState("");
  return <Input value={value} onChange={setValue} />;
}
```

Legend Doctor reports `keep-state` here. An observable wrapper would rebuild the same child and add machinery without
narrowing the render boundary.

### Isolate an exact array membership control

```tsx
// before, every checkbox renders the settings page
const [selected, setSelected] = useState(initial);
const toggle = (value: string) => setSelected(previous =>
  previous.includes(value) ? previous.filter(item => item !== value) : [...previous, value]
);
const submit = () => save(selected);
return <form onSubmit={handleSubmit(submit)}>
  <SettingsHelp />
  <TriggerCheckboxGroup selected={selected} onSelectionChange={toggle} />
</form>;

// after, keep one owner handle and snapshot once when submitting
const selected$ = useObservable(initial);
const toggle = (value: string) => selected$.set(previous =>
  previous.includes(value) ? previous.filter(item => item !== value) : [...previous, value]
);
const submit = () => save(selected$.peek());
return <form onSubmit={handleSubmit(submit)}>
  <SettingsHelp />
  <TriggerCheckboxGroupState selected$={selected$} onSelectionChange={toggle} />
</form>;

function TriggerCheckboxGroupState({ selected$, onSelectionChange }: Props) {
  return <TriggerCheckboxGroup selected={useValue(selected$)} onSelectionChange={onSelectionChange} />;
}
```

Legend Doctor accepts the exact immutable membership toggle and imported React Hook Form `handleSubmit`. Opaque
reconcilers, extra updater work, unresolved adapters, and coupled state changes remain candidates.

### Isolate one record entry per row

```tsx
// before, one vote renders the entire message rail
const [feedback, setFeedback] = useState<Record<string, Verdict>>({});
const vote = async (message: Message, verdict: Verdict) => {
  setFeedback(previous => ({ ...previous, [message.id]: verdict }));
  try { await submit(message.id, verdict); }
  catch {
    setFeedback(previous => {
      const next = { ...previous };
      delete next[message.id];
      return next;
    });
  }
};
return messages.map(message =>
  <MessageRow key={message.id} active={feedback[message.id]} onVote={value => vote(message, value)} />
);

// after, only the voted row subscribes and the async boundary stays unchanged
const feedback$ = useObservable<Record<string, Verdict>>({});
const vote = async (message: Message, verdict: Verdict) => {
  feedback$[message.id].set(verdict);
  try { await submit(message.id, verdict); }
  catch { feedback$[message.id].delete(); }
};
return messages.map(message =>
  <MessageRowState key={message.id} feedback$={feedback$} message={message} onVote={vote} />
);

function MessageRowState({ feedback$, message, onVote }: Props) {
  return <MessageRow
    active={useValue(feedback$[message.id])}
    onVote={verdict => onVote(message, verdict)}
  />;
}
```

The record key must match the stable row key. Every read and exact clone write must target that same primitive entry.
Whole-record reads, resets, multi-key updates, entry-controlled row mounts, eager callbacks, and unresolved wrappers remain
candidates.

### Keep an inline editor inside its keyed row

```tsx
// before, opening, typing, and closing render the list owner
const [editingId, setEditingId] = useState<string | null>(null);
const [editText, setEditText] = useState("");

// after, paired opens stay atomic and typing reaches only the active row
const editor$ = useObservable({ id: null as string | null, text: "" });
const beginEdit = (row: Row) => editor$.assign({ id: row.id, text: row.name });
const closeEdit = () => editor$.id.set(null);
const saveEdit = () => save(editor$.text.peek());

function EditableRow({ editor$, row }: { editor$: Observable<{ id: string | null; text: string }>; row: Row }) {
  const editing = useValue(() => editor$.id.get() === row.id);
  return editing ? <InlineEditor editor$={editor$} /> : <RowView row={row} />;
}

function InlineEditor({ editor$ }: { editor$: Observable<{ id: string | null; text: string }> }) {
  return <Input value={useValue(editor$.text)} onChange={value => editor$.text.set(value)} />;
}
```

Legend Doctor permits a cursor-only close because the hidden draft already persists in React. Every non-null cursor
change must still assign its matching draft atomically; switching rows with stale text stays under review.

### Isolate async status

```tsx
// before, pending transitions render the editor
const [copying, setCopying] = useState(false);
const copy = async () => {
  setCopying(true);
  try { await duplicate(); } finally { setCopying(false); }
};
return <><Editor /><Button loading={copying} onClick={copy} /></>;

// after, the command boundary is unchanged
const copying$ = useObservable(false);
const copy = async () => {
  copying$.set(true);
  try { await duplicate(); } finally { copying$.set(false); }
};
return <><Editor /><ButtonState copying$={copying$} onClick={copy} /></>;
```

Pure props, labels, and icons may share one stable status leaf. Repeated controls, mount gates, impure projections, and
conditional first awaits remain candidates.

### Subscribe once per keyed row

```tsx
// before, selection renders the list owner
const [selectedId, setSelectedId] = useState<string | null>(null);
return rows.map(row => <Row key={row.id} selected={selectedId === row.id} />);

// after
const selectedId$ = useObservable<string | null>(null);
return rows.map(row => <RowState key={row.id} row={row} selectedId$={selectedId$} />);
```

The proof requires an item-derived stable key and per-row membership. Index keys and mount-control reads abstain.

### Replace render-free state with a ref

```tsx
// before
const [socket, setSocket] = useState<WebSocket | null>(null);
useEffect(() => { setSocket(connect()); }, []);
const send = () => socket?.send("ping");

// after
const socketRef = useRef<WebSocket | null>(null);
useEffect(() => { socketRef.current = connect(); }, []);
const send = () => socketRef.current?.send("ping");
```

### Remove a duplicate Legend mirror

```tsx
// before
const savedName = useSavedName();
const [name, setName] = useState(savedName);
const rename = (next: string) => { setName(next); writeName(next); };

// after
const name = useSavedName();
const rename = writeName;
```

## Effect examples

### Move an event-owned reset into the event

```tsx
// before, query commits and the effect commits page
useEffect(() => setPage(1), [query]);
const changeQuery = (next: string) => setQuery(next);

// after, one event owns one transition
const changeQuery = (next: string) => {
  setQuery(next);
  setPage(1);
};
```

Every source mutation must be structurally resolved. Unknown component callbacks stay candidates.

### React to Legend without rendering the component

```tsx
// before
const theme = useValue(settings$.theme);
useEffect(() => syncTheme(theme), [theme]);

// after
useObserveEffect(() => syncTheme(settings$.theme.get()));
```

### Express setup and teardown intent

```tsx
useEffect(() => start(), []);       // before
useMount(() => start());            // after

useEffect(() => () => stop(), []);  // before
useUnmount(() => stop());           // after
```

Strict Mode replay, setup work, and disposer ownership stay candidates unless the lifecycle is equivalent.

### Keep committed-ref work in React

```tsx
useEffect(() => {
  if (!listRef.current) return;
  const items = listRef.current.querySelectorAll("[role=option]");
  items[selectedIndex]?.scrollIntoView({ block: "nearest" });
}, [selectedIndex]);
```

Legend Doctor reports `keep-effect`. The DOM receiver may pass through immutable local aliases, but the command still
depends on React post-commit timing. Alias escape and unrelated nested calls remain candidates.

## Legend subscription examples

### Narrow to the field that renders

```tsx
const profile = useValue(profile$);           // before
const name = profile.contact.name;

const name = useValue(profile$.contact.name); // after
```

### Split unrelated leaves

```tsx
const user = useValue(user$); // before
return <><Name value={user.name} /><Avatar src={user.avatarUrl} /></>;

// after
return <><NameState name$={user$.name} /><AvatarState avatar$={user$.avatarUrl} /></>;
```

### Move a subscription into its only stable consumer

```tsx
const open = useValue(dialog$.open);                     // before
return <><Editor /><Dialog open={open} /></>;

return <><Editor /><DialogState open$={dialog$.open} /></>; // after
```

### Remove selector work and legacy APIs

```tsx
useValue(() => profile$.name.get());                 // before
useValue(profile$.name);                             // after

useValue(profile$.avatar.get(), { suspense: true }); // before
useValue(profile$.avatar, { suspense: true });       // after

useSelector(profile$.name);                          // before
useValue(profile$.name);                             // after
```

### Use a non-tracking command snapshot

```tsx
const save = () => persist(settings$.theme.get());  // before
const save = () => persist(settings$.theme.peek()); // after
```

Render reads, tracking callbacks, listener options, and unresolved callback chains keep `.get()`.

## Legend write examples

### Write the changed path

```tsx
profile$.set({ ...profile$.peek(), name });  // before
profile$.name.set(name);                     // after

rows$.set({ ...rows$.peek(), [id]: row });   // before
rows$[id].set(row);                          // after

items$.set(previous => [...previous, item]); // before
items$.push(item);                           // after
```

### Toggle directly

```tsx
menu$.open.set(value => !value); // before
menu$.open.toggle();             // after
```

### Publish sibling fields once

```tsx
draft$.name.set(name);          // before
draft$.color.set(color);

draft$.assign({ name, color }); // after
```

### Publish related roots once

```tsx
// before
session$.user.set(user);
router$.route.set("home");

// after
batch(() => {
  session$.user.set(user);
  router$.route.set("home");
});
```

Overlapping paths, awaits, order-sensitive reads, partial write runs, and unresolved value evaluation preserve the
original writes.

## Proof boundary

Legend Doctor emits `change` only when TypeScript structure proves the edit. Component names, paths, application
allowlists, disabled UI, and corpus expectations are not proof.

- Keep cohesive one-control state in React when an observable cannot remove an owner render.
- Keep observable ownership at the lifetime named in `stateModel`.
- Subscribe with `useValue` at the lowest proven stable render leaf.
- Use `.peek()` only in a proven non-tracking path.
- Apply grouped findings as one migration.
- Check the installed `@legendapp/state` version and types before changing APIs.

These rules follow the official
[Legend State best-practices skill](https://github.com/LegendApp/legend-skills/tree/main/legend-state-best-practices).

## Verified accuracy

The pinned corpus covers 2,356 hooks across 225 targets. It contains 812 manually audited hook labels, 18 state groups,
and 106 Legend practice labels.

| Check | Result |
| --- | ---: |
| Unit tests | 543/543 |
| Actionable precision | 438/438 |
| Actionable recall | 438/438 |
| Legend practice precision | 106/106 |

The corpus keeps known opportunities as non-enforced labels. A detector cannot improve its score by turning uncertain
code into a forced edit.
