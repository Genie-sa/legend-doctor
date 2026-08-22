# Legend Doctor

Legend Doctor tells coding agents which React and Legend State edits remove a proven render, subscription, allocation,
or post-commit update. Each finding includes the edit, its structural proof, and the ownership boundary that must stay
intact.

The tool reports. The agent edits the application, validates it, and scans again.

## Run

```bash
npm install
npm run build
node dist/src/cli.js /absolute/path/to/app-or-feature --actionable
```

Scan the smallest complete root containing the components, hooks, barrels, and observable definitions involved in the
change.

```bash
# Proven edits
node dist/src/cli.js /absolute/path/to/root --json --disposition change

# Opportunities that need source inspection
node dist/src/cli.js /absolute/path/to/root --json --disposition candidate

# Analysis coverage
node dist/src/cli.js /absolute/path/to/root --json --coverage
```

`--actionable` returns `change` and `candidate` findings. It hides intentional `keep` findings.

## Agent loop

1. Scan before editing.
2. Apply one semantic group of `change` findings.
3. Inspect each `candidate`. Edit only when source proves the missing timing, ownership, or type fact.
4. Run the application's formatter, typecheck, and relevant tests.
5. Scan the same root again.
6. Report every added, removed, or changed finding.
7. Stop when checks pass and every remaining finding is intentional.

```text
Run Legend Doctor on <absolute root> before editing. Apply proven change findings one semantic group at a time.
Preserve state lifetime, mount identity, effect timing, cleanup, and atomic writes. Inspect candidates and keep the
code unchanged unless source proves the missing fact. Run the app's checks, scan again, and report the finding delta.
```

## Read the result

Text keeps the edit loop short:

```text
src/MergeTags.tsx:29:29 [delete-unused-state] Delete React state `value` and its setter calls; assigned values are never consumed.
Scanned 1 files: 2 useState, 0 useEffect, 1 shown.
Re-run legend-doctor after applying change findings; applied changes can reveal new ones.
```

JSON includes the proof and target boundary:

```json
{
  "action": "move-use-value-down",
  "confidence": "certain",
  "disposition": "change",
  "evidence": [
    "1 render read of pending occurs only inside the stable <SaveStatus> leaf at line 88",
    "that leaf contains 1 of the owner's 24 JSX elements and is not conditional, keyed, repeated, or split across returns"
  ],
  "location": { "file": "src/SettingsPage.tsx", "line": 42, "column": 19 },
  "message": "Move useValue(request$.pending) into a stable wrapper around <SaveStatus>...",
  "practice": "reactivity"
}
```

| Disposition | Agent action |
| --- | --- |
| `change` | Apply the instruction. The proof is complete. |
| `candidate` | Read the named source and resolve the uncertainty. |
| `keep` | Preserve the current ownership or lifecycle boundary. |
| `style` | Apply only when project policy requires the equivalent Legend API. |

## Detection catalog

| Finding | Work removed |
| --- | --- |
| `delete-unused-state` | State cells and updates with no consumer |
| `delete-derived-state`, `delete-effect` | Effect-driven derived state and its second render |
| `move-state-down` | Owner renders caused by state used in one stable child |
| `use-observable` | Owner renders caused by leaf-only, async, dialog, or keyed-row state |
| `use-ref` | Renders caused by command-only values |
| `use-value` | Duplicate React mirrors of Legend state |
| `move-to-event` | Post-commit reset renders caused by event-driven effects |
| `use-observe-effect` | Component subscriptions used only by an external reaction |
| `use-mount`, `use-unmount` | Empty-dependency lifecycle effects when semantics match |
| `narrow-use-value-subscription` | Notifications from unused sibling fields |
| `split-use-value-leaves` | Shared invalidation between independent render leaves |
| `move-use-value-down` | Broad owner rerenders from a leaf-only subscription |
| `pass-observable-to-use-value` | Redundant selectors and eager reads |
| `replace-legacy-use-value` | Legacy Legend selector calls |
| `use-peek-for-snapshot` | Tracking reads in non-tracking commands and callbacks |
| `narrow-observable-write` | Object, record, or array cloning for one narrow write |
| `toggle-observable` | Generic boolean updater callbacks |
| `assign-observable-fields` | Intermediate publications between sibling field writes |
| `batch-observable-writes` | Intermediate publications across observable roots |
| `review-state`, `review-effect` | Unproven opportunities that require source inspection |
| `keep-state`, `keep-effect` | State or effects whose current boundary is required |

## React state examples

### Remove unused or derived state

```tsx
// delete-unused-state, before
const [value, setValue] = useState("");
const refresh = () => setValue(loadValue());

// after: preserve argument evaluation
const refresh = () => { loadValue(); };

// delete-derived-state + delete-effect
const [fullName, setFullName] = useState("");
useEffect(() => setFullName(`${first} ${last}`), [first, last]);

const fullName = `${first} ${last}`; // after
```

The unused-state edit preserves side-effectful setter arguments. The derived-state edit removes the stale commit and
follow-up render.

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

`move-state-down` requires every read and write to belong to the same stable child.

### Keep ownership high and subscribe low

```tsx
// before
const [target, setTarget] = useState<Account | null>(null);
return <><Accounts onDelete={setTarget} /><DeleteDialog account={target} /></>;

// after
const target$ = useObservable<Account | null>(null);
return <>
  <Accounts onDelete={value => target$.set(value)} />
  <DeleteDialogState target$={target$} />
</>;

function DeleteDialogState({ target$ }: { target$: Observable<Account | null> }) {
  return <DeleteDialog account={useValue(target$)} />;
}
```

`use-observable` keeps page-lifetime ownership while limiting notification to the dialog leaf.

### Isolate async status

```tsx
// before
const [pending, setPending] = useState(false);
const save = async () => {
  setPending(true);
  try { await submit(); } finally { setPending(false); }
};
return <><Editor /><SaveButton pending={pending} onPress={save} /></>;

// after
const pending$ = useObservable(false);
const save = async () => {
  pending$.set(true);
  try { await submit(); } finally { pending$.set(false); }
};
return <><Editor /><SaveButtonState pending$={pending$} onPress={save} /></>;

function SaveButtonState({ pending$, onPress }: Props) {
  return <SaveButton pending={useValue(pending$)} onPress={onPress} />;
}
```

The async completion boundary stays intact. Pending transitions stop rerendering `Editor`.

### Subscribe once per keyed row

```tsx
// before
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

### Isolate a measured value in one selected control

```tsx
// before: every layout event rerenders every control
const uniqueControls = controls.filter((control, index, array) => array.indexOf(control) === index);
const [layoutWidth, setLayoutWidth] = useState(0);
const updateWidth = (next: number) => setLayoutWidth(previous =>
  Math.abs(previous - next) < 1 ? previous : next
);
const baseWidth = layoutWidth > 0 ? layoutWidth : windowWidth;
const dropdownWidth = Math.max(baseWidth - 16, 320);
return uniqueControls.map(control => {
  switch (control) {
    case "search": return <Search key="search" width={dropdownWidth} />;
    default: return null;
  }
});

// after: ownership stays here; only SearchWidth subscribes
const layoutWidth$ = useObservable(0);
const updateWidth = (next: number) => layoutWidth$.set(previous =>
  Math.abs(previous - next) < 1 ? previous : next
);
return uniqueControls.map(control => {
  switch (control) {
    case "search": return <SearchWidth key="search" width$={layoutWidth$} fallback={windowWidth} />;
    default: return null;
  }
});

function SearchWidth({ width$, fallback }: Props) {
  const measured = useValue(width$);
  return <Search width={Math.max((measured > 0 ? measured : fallback) - 16, 320)} />;
}
```

This finding requires immutable projections, an unshadowed pure calculation, a structurally deduplicated array, one
literal switch branch, and a matching stable key. Ordinary repeated rows remain candidates.

### Replace command-only state or a Legend mirror

```tsx
// use-ref, before
const [socket, setSocket] = useState<WebSocket | null>(null);
useEffect(() => { setSocket(connect()); }, []);
const send = () => socket?.send("ping");

// after
const socketRef = useRef<WebSocket | null>(null);
useEffect(() => { socketRef.current = connect(); }, []);
const send = () => socketRef.current?.send("ping");

// use-value, before
const savedName = useSavedName();
const [name, setName] = useState(savedName);
const rename = (next: string) => { setName(next); writeName(next); };

// after
const name = useSavedName();
const rename = writeName;
```

`use-ref` applies when render never consumes the value. `use-value` follows source-proven Legend readers and writers
before removing duplicate storage.

## Effect examples

### Move an event-caused reset to the event

```tsx
// before
useEffect(() => setPage(1), [query]);
const changeQuery = (next: string) => setQuery(next);

// after
const changeQuery = (next: string) => {
  setQuery(next);
  setPage(1);
};
```

`move-to-event` requires proof for every source mutation.

### React to Legend without subscribing the component

```tsx
const theme = useValue(settings$.theme);                 // before
useEffect(() => syncTheme(theme), [theme]);

useObserveEffect(() => syncTheme(settings$.theme.get())); // after
```

### Express mount and teardown intent

```tsx
useEffect(() => start(), []);       // before
useMount(() => start());            // after

useEffect(() => () => stop(), []);  // before
useUnmount(() => stop());           // after
```

Strict Mode replay, setup work, and disposer ownership keep these as candidates when semantics are unresolved.

## Legend read examples

### Narrow broad subscriptions

```tsx
const profile = useValue(profile$);           // before: only profile.contact.name is read
const name = useValue(profile$.contact.name); // after

const { theme } = useValue(settings$);        // before
const theme = useValue(settings$.theme);      // after
```

`narrow-use-value-subscription` stops unused sibling fields from invalidating the component.

### Split independent leaves

```tsx
// before
const user = useValue(user$);
return <><Name value={user.name} /><Avatar src={user.avatarUrl} /></>;

// after
return <><NameState name$={user$.name} /><AvatarState avatar$={user$.avatarUrl} /></>;
```

`split-use-value-leaves` prevents a name update from rerendering the avatar leaf.

### Move one subscription to its stable leaf

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

Conditional children keep the condition inside the stable wrapper:

```tsx
function ErrorState({ error$ }: Props) {
  const error = useValue(error$);
  return error ? <ErrorMessage>{error}</ErrorMessage> : null;
}
```

`move-use-value-down` preserves the selected child's mount behavior.

### Remove redundant `useValue` work

```tsx
useValue(() => profile$.name.get());                    // before
useValue(profile$.name);                                // after

useValue(profile$.avatar.get(), { suspense: true });    // before
useValue(profile$.avatar, { suspense: true });           // after

useSelector(profile$.name);                             // before
useValue(profile$.name);                                // after
```

These produce `pass-observable-to-use-value` or `replace-legacy-use-value`. Import provenance prevents lookalike local
functions from matching.

### Use snapshots outside tracking contexts

```tsx
const save = () => persist(settings$.theme.get());       // before
const save = () => persist(settings$.theme.peek());      // after

useMount(() => register(panelSize$.get()));              // before
useMount(() => register(panelSize$.peek()));             // after

settings$.theme.onChange(() => persist(audit$.latestTheme.get()));  // before
settings$.theme.onChange(() => persist(audit$.latestTheme.peek())); // after
```

`use-peek-for-snapshot` also follows effect-only callbacks across files. Render reads, tracking APIs, nested callbacks,
listener options, and unresolved execution keep `.get()`.

## Legend write examples

### Replace clone writes with narrow operations

```tsx
profile$.set({ ...profile$.peek(), name });       // before
profile$.name.set(name);                          // after

rows$.set({ ...rows$.peek(), [id]: row });        // before
rows$[id].set(row);                               // after

items$.set(previous => [...previous, item]);      // before
items$.push(item);                                // after
```

`narrow-observable-write` preserves the original write when value evaluation or collection identity is unresolved.

### Use the direct boolean operation

```tsx
menu$.open.set(value => !value); // before
menu$.open.toggle();             // after
```

### Publish related fields once

```tsx
draft$.name.set(name);             // before
draft$.color.set(color);

draft$.assign({ name, color });    // after
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

`batch-observable-writes` preserves overlapping paths, awaits, order-sensitive reads, and partial write runs.

## Safety rules

- Check the installed `@legendapp/state` version and types before applying an API migration.
- Keep cohesive one-off UI state in React unless an observable removes a proven owner render.
- Keep observable ownership at the lifetime named by `stateModel`.
- Subscribe with `useValue` at the lowest proven stable render leaf.
- Use `.peek()` only where the finding proves non-tracking execution.
- Apply grouped state findings as one migration.
- Preserve effect phase, dependencies, cleanup, write order, mount identity, list keys, and conditional cardinality.
- Treat component names, paths, app allowlists, and corpus exceptions as context, never as proof.

The rules follow the official
[Legend State best-practices skill](https://github.com/LegendApp/legend-skills/tree/main/legend-state-best-practices).

## Accuracy

The pinned corpus contains 2,356 hooks across 225 targets, 797 manually audited hook labels, 18 state groups, and 106
Legend practice labels.

| Check | Result |
| --- | ---: |
| Unit tests | 532/532 |
| Actionable precision | 428/428 |
| Actionable recall | 428/429 |
| Legend practice precision | 106/106 |

The one unresolved opportunity remains non-enforced because its callback timing is not structurally proven.
