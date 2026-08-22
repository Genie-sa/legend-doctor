# Legend Doctor

Legend Doctor gives coding agents proven ways to remove React renders, post-commit updates, broad Legend subscriptions,
duplicate state, and intermediate observable publications. It is an analyzer, not an autofixer: the agent reads the
evidence, edits the application, validates it, and scans again.

## Run it

```bash
npm install
npm run build
node dist/src/cli.js /absolute/path/to/app-or-feature --json --actionable
```

Scan the smallest complete root containing the relevant components, hooks, imports, re-exports, and observable
definitions. Multi-file analysis resolves component props, callback contracts, observable provenance, TypeScript
configuration, and barrel exports. An isolated file can hide the proof required for a safe finding.

Useful commands:

```bash
# Proven changes only
node dist/src/cli.js /absolute/path/to/root --json --disposition change

# Opportunities that still need source proof
node dist/src/cli.js /absolute/path/to/root --json --disposition candidate

# Short terminal report for an edit loop
node dist/src/cli.js /absolute/path/to/root --actionable

# Analysis coverage and skipped files
node dist/src/cli.js /absolute/path/to/root --json --coverage
```

`--actionable` returns `change` and `candidate` findings. It hides intentional `keep` findings.

## Agent contract

1. Scan before editing.
2. Apply one semantic group of `change` findings.
3. Inspect each `candidate`. Change code only when source proves the missing timing, ownership, or type fact.
4. Preserve state lifetime, mount identity, effect timing, cleanup, dependencies, write order, keys, and atomic writes.
5. Run the application's formatter, typecheck, and relevant tests.
6. Scan the same root again. Report every added, removed, or changed finding.
7. Stop when checks pass and each remaining finding is intentional.

Give an agent this prompt:

```text
Run Legend Doctor on <absolute root> before editing. Apply proven change findings one semantic group at a time.
Preserve state lifetime, mount identity, effect timing, cleanup, dependencies, write order, keys, and atomic writes.
Inspect candidates and leave code unchanged unless source proves the missing fact. Run the app's checks, scan the same
root again, and report the exact finding delta.
```

## Read the output

Text output is an agent edit queue:

```text
DocumentCopy.tsx:27:33 [use-observable] Replace async pending flag `copying` with a component-lifetime observable and wrap the stable pending-control call site in a leaf subscriber; preserve the event command's async completion boundary exactly, changing only the true/false writes so pending transitions do not invalidate independent owner content.
DocumentCopy.tsx:29:38 [review-state] Legend-first restructuring candidate: replace `selectedPath` with observable ownership and move its subscription into the smallest rendered subtree; updates currently invalidate this owner with 12 JSX elements.
Scanned 1 files: 4 useState, 0 useEffect, 4 shown.
Re-run legend-doctor after applying change findings; applied changes can reveal new ones.
```

JSON is the preferred agent interface. It includes the action, disposition, evidence, location, message, and any group
or ownership details:

```json
{
  "action": "use-observable",
  "confidence": "probable",
  "disposition": "change",
  "evidence": [
    "owner: DocumentCopy, lines 22-118, JSX elements 12",
    "reads: render 2, effects 0, deferred 0, transported 0",
    "writes: setter calls 2, effect writes 0",
    "transport targets: none"
  ],
  "hook": "useState",
  "location": { "file": "DocumentCopy.tsx", "line": 27, "column": 33 },
  "message": "Replace async pending flag `copying` with a component-lifetime observable and wrap the stable pending-control call site in a leaf subscriber...",
  "name": "copying",
  "stateModel": { "ownership": "local-observable", "subscription": "leaf-use-value" }
}
```

| Disposition | Required agent behavior |
| --- | --- |
| `change` | Apply the instruction. Structural proof is complete. |
| `candidate` | Inspect the named source and resolve the uncertainty. |
| `keep` | Preserve the current ownership or lifecycle boundary. |
| `style` | Apply only when project policy requires the equivalent Legend API. |

## What it detects

| Finding | Example detected | Value |
| --- | --- | --- |
| `delete-unused-state` | `const [, setTick] = useState(0)` | Deletes an unused cell and its updates |
| `delete-derived-state` | `useEffect(() => setTotal(price * qty), [price, qty])` | Removes a stale commit and second render |
| `delete-effect` | An effect whose only work disappears with its derived state | Deletes the empty lifecycle |
| `move-state-down` | A value and setter used by one stable child | Stops local edits from rendering the parent |
| `use-observable` | Leaf-only input, dialog, pending, reveal, selection, or keyed-row state | Preserves owner lifetime while rerendering only subscribers |
| `use-ref` | State read only by event commands or cleanup | Removes renders for non-rendered values |
| `use-value` | React state mirroring a Legend value | Removes duplicate ownership and synchronization |
| `move-to-event` | An effect resets page state after a query event | Performs one event transition instead of two commits |
| `use-observe-effect` | `useValue` feeds only an external side effect | Stops the component from subscribing and rendering |
| `use-mount`, `use-unmount` | Proven equivalent empty-dependency setup or teardown | Expresses exact Legend lifecycle intent |
| `narrow-use-value-subscription` | `useValue(profile$)` reads only `profile.name` | Ignores unused sibling updates |
| `split-use-value-leaves` | One broad value feeds independent name and avatar leaves | Prevents one leaf from invalidating another |
| `move-use-value-down` | A subscription is read only by one stable descendant | Removes observable updates from the parent render |
| `pass-observable-to-use-value` | `useValue(() => name$.get())` | Removes a redundant selector |
| `replace-legacy-use-value` | `useSelector(name$)` or `use$(name$)` | Uses the installed current Legend API |
| `use-peek-for-snapshot` | An event command calls `settings$.get()` | Avoids accidental tracking |
| `narrow-observable-write` | `state$.set({ ...state$.peek(), name })` | Publishes only the changed path |
| `toggle-observable` | `open$.set(value => !value)` | Uses the direct boolean operation |
| `assign-observable-fields` | Consecutive writes to sibling fields | Publishes one coherent object update |
| `batch-observable-writes` | Consecutive writes across observable roots | Publishes one cross-root transaction |
| `review-state`, `review-effect` | A promising change with unresolved timing or ownership | Directs the agent to the missing proof |
| `keep-state`, `keep-effect` | State or lifecycle whose current boundary is required | Prevents a behavior-changing rewrite |

## React state examples

### Delete state that has no render consumer

```tsx
// before
const [, setValue] = useState("");
const refresh = () => setValue(loadValue());

// after: preserve side-effectful argument evaluation
const refresh = () => { loadValue(); };
```

### Delete derived state and its follow-up render

```tsx
// before
const [fullName, setFullName] = useState("");
useEffect(() => setFullName(`${first} ${last}`), [first, last]);

// after
const fullName = `${first} ${last}`;
```

### Move state into its only stable child

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

### Keep page ownership and subscribe in the dialog

```tsx
// before: selecting an account rerenders the page
const [target, setTarget] = useState<Account | null>(null);
return <><Accounts onDelete={setTarget} /><DeleteDialog account={target} /></>;

// after: only the dialog leaf subscribes
const target$ = useObservable<Account | null>(null);
return <><Accounts onDelete={value => target$.set(value)} /><DeleteDialogState target$={target$} /></>;

function DeleteDialogState({ target$ }: { target$: Observable<Account | null> }) {
  return <DeleteDialog account={useValue(target$)} />;
}
```

### Keep a render gate alive while moving its subscription down

```tsx
// before: opening the panel rerenders Header and Canvas
const [open, setOpen] = useState(false);
return <><Header /><Canvas /><button onClick={() => setOpen(true)}>Open</button>{open && <Panel />}</>;

// after: PanelGate stays mounted; Panel keeps its original conditional mount
const open$ = useObservable(false);
return <><Header /><Canvas /><button onClick={() => open$.set(true)}>Open</button><PanelGate open$={open$} /></>;

function PanelGate({ open$ }: { open$: Observable<boolean> }) {
  return useValue(open$) ? <Panel /> : null;
}
```

### Split a controlled value from its validation consumer

```tsx
// before: every keystroke rerenders the form owner
const [name, setName] = useState("");
return <><FormHelp /><NameInput value={name} onChange={setName} /><Save disabled={!name.trim()} /></>;

// after: ownership stays above both independent leaves
const name$ = useObservable("");
return <><FormHelp /><NameInputState name$={name$} /><SaveState name$={name$} /></>;

function NameInputState({ name$ }: Props) {
  const name = useValue(name$);
  return <NameInput value={name} onChange={value => name$.set(value)} />;
}
function SaveState({ name$ }: Props) {
  const name = useValue(name$);
  return <Save disabled={!name.trim()} />;
}
```

### Isolate async status from the editor

```tsx
// before
const [copying, setCopying] = useState(false);
const copy = async () => {
  if (!destination) return;
  setCopying(true);
  try { await duplicate(destination); } finally { setCopying(false); }
};
return <><Explorer /><Button disabled={!destination || copying} onClick={copy}>
  {copying ? `${translate("Copying")}...` : translate("Copy")}
</Button></>;

// after: the command keeps its exact boundary; only ButtonState subscribes
const copying$ = useObservable(false);
const copy = async () => {
  if (!destination) return;
  copying$.set(true);
  try { await duplicate(destination); } finally { copying$.set(false); }
};
return <><Explorer /><ButtonState
  copying$={copying$}
  destination={destination}
  onClick={copy}
  copyLabel={translate("Copy")}
  copyingLabel={`${translate("Copying")}...`}
/></>;

function ButtonState({ copying$, destination, onClick, copyLabel, copyingLabel }: Props) {
  const copying = useValue(copying$);
  return <Button disabled={!destination || copying} onClick={onClick}>
    {copying ? copyingLabel : copyLabel}
  </Button>;
}
```

Pure props, labels, and icons may share the same stable leaf. Calls, multiple consumers, repeated controls, and
pending-controlled mounts remain candidates. Projection-only leaves also require an unavoidable async boundary.

### Subscribe once per keyed row

```tsx
// before: selection rerenders the list owner
const [selectedId, setSelectedId] = useState<string | null>(null);
return rows.map(row => (
  <Row key={row.id} selected={selectedId === row.id} onPress={() => setSelectedId(row.id)} />
));

// after
const selectedId$ = useObservable<string | null>(null);
return rows.map(row => <RowState key={row.id} row={row} selectedId$={selectedId$} />);

function RowState({ row, selectedId$ }: Props) {
  const selected = useValue(() => selectedId$.get() === row.id);
  return <Row selected={selected} onPress={() => selectedId$.set(row.id)} />;
}
```

### Keep a measured projection in its only selected leaf

```tsx
// before: layout updates rerender the control owner
const [width, setWidth] = useState(0);
const menuWidth = Math.max((width || fallbackWidth) - 16, 320);
return controls.map(control => {
  switch (control) {
    case "search": return <Search key="search" width={menuWidth} />;
    default: return null;
  }
});

// after: only SearchWidth subscribes
const width$ = useObservable(0);
const updateWidth = (next: number) => width$.set(previous =>
  Math.abs(previous - next) < 1 ? previous : next
);
return controls.map(control => {
  switch (control) {
    case "search": return <SearchWidth key="search" width$={width$} fallback={fallbackWidth} />;
    default: return null;
  }
});

function SearchWidth({ width$, fallback }: Props) {
  const measured = useValue(width$);
  return <Search width={Math.max((measured || fallback) - 16, 320)} />;
}
```

Legend Doctor proves the projection, selected branch, and stable key. Ordinary repeated rows stay candidates.

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

### Move an event-caused reset into the event

```tsx
// before: query change commits, then the effect commits page
useEffect(() => setPage(1), [query]);
const changeQuery = (next: string) => setQuery(next);

// after: one event owns one transition
const changeQuery = (next: string) => {
  setQuery(next);
  setPage(1);
};
```

`move-to-event` requires structural proof for every source mutation. An unresolved custom callback keeps the finding as
a candidate.

### React to Legend without subscribing the component

```tsx
// before
const theme = useValue(settings$.theme);
useEffect(() => syncTheme(theme), [theme]);

// after
useObserveEffect(() => syncTheme(settings$.theme.get()));
```

### Express equivalent mount and teardown intent

```tsx
useEffect(() => start(), []);       // before
useMount(() => start());            // after

useEffect(() => () => stop(), []);  // before
useUnmount(() => stop());           // after
```

Strict Mode replay, setup work, and disposer ownership keep lifecycle changes as candidates when semantics are not
proven.

## Legend subscription examples

### Narrow a broad subscription

```tsx
const profile = useValue(profile$);           // before: only contact.name is rendered
const name = useValue(profile$.contact.name); // after

const { theme } = useValue(settings$);        // before
const theme = useValue(settings$.theme);      // after
```

### Split unrelated render leaves

```tsx
const user = useValue(user$); // before: either field invalidates both leaves
return <><Name value={user.name} /><Avatar src={user.avatarUrl} /></>;

// after
return <><NameState name$={user$.name} /><AvatarState avatar$={user$.avatarUrl} /></>;
```

### Move a subscription into its only stable leaf

```tsx
// before
const open = useValue(dialog$.open);
return <><Header /><Editor /><Dialog open={open} /></>;

// after
return <><Header /><Editor /><DialogState open$={dialog$.open} /></>;

function DialogState({ open$ }: { open$: Observable<boolean> }) {
  return <Dialog open={useValue(open$)} />;
}
```

The stable wrapper preserves child mount identity. Conditional rendering stays inside that wrapper.

### Remove redundant selector work

```tsx
useValue(() => profile$.name.get());                 // before
useValue(profile$.name);                             // after

useValue(profile$.avatar.get(), { suspense: true }); // before
useValue(profile$.avatar, { suspense: true });       // after

useSelector(profile$.name);                          // before
useValue(profile$.name);                             // after
```

### Read a snapshot without tracking

```tsx
const save = () => persist(settings$.theme.get());  // before
const save = () => persist(settings$.theme.peek()); // after

useMount(() => register(panelSize$.get()));          // before
useMount(() => register(panelSize$.peek()));         // after
```

Render reads, tracking APIs, unresolved callbacks, and listener options keep `.get()`.

## Legend write examples

### Replace clone writes with narrow operations

```tsx
profile$.set({ ...profile$.peek(), name });   // before
profile$.name.set(name);                      // after

rows$.set({ ...rows$.peek(), [id]: row });    // before
rows$[id].set(row);                           // after

items$.set(previous => [...previous, item]);  // before
items$.push(item);                            // after
```

### Use the direct boolean operation

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

Legend Doctor keeps the original writes when it finds overlapping paths, awaits, order-sensitive reads, partial write
runs, or unresolved value evaluation.

## Proof boundary

Legend Doctor enforces a change only when TypeScript structure proves it. Component names, paths, app allowlists, and
test-specific exceptions are never proof.

- Keep cohesive one-off UI state in React unless an observable removes a proven parent render.
- Keep observable ownership at the lifetime reported in `stateModel`.
- Subscribe with `useValue` at the lowest proven stable render leaf.
- Use `.peek()` only in a proven non-tracking execution path.
- Apply grouped state findings as one migration.
- Check the installed `@legendapp/state` version and types before an API migration.

These rules follow the official
[Legend State best-practices skill](https://github.com/LegendApp/legend-skills/tree/main/legend-state-best-practices).

## Verified accuracy

The pinned corpus covers 2,356 hooks across 225 targets, with 799 manually audited hook labels, 18 state groups, and
106 Legend practice labels.

| Check | Result |
| --- | ---: |
| Unit tests | 535/535 |
| Actionable precision | 431/431 |
| Actionable recall | 431/432 |
| Legend practice precision | 106/106 |

The one unresolved opportunity remains a candidate because its callback timing is not structurally proven.
