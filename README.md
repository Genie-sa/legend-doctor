# Legend Doctor

Legend Doctor finds React and Legend State changes that remove proven work. It detects avoidable owner renders,
post-commit updates, broad subscriptions, duplicate state, and writes that publish intermediate observable states. Every
enforced finding includes the structural evidence an agent needs to edit safely.

This is a tool for coding agents. It reports and proves changes. The agent edits the application, runs its checks, and
scans again.

## Run it

```bash
npm install
npm run build
node dist/src/cli.js /absolute/path/to/app-or-feature --json --actionable
```

Scan the smallest complete root that contains the relevant components, hooks, imports, re-exports, and observable
definitions. Legend Doctor follows data and callback contracts across files, so scanning one isolated component can
hide the proof required for a finding.

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

Text output is terse:

```text
src/MergeTags.tsx:29:29 [delete-unused-state] Delete React state `value` and its setter calls; assigned values are never consumed.
Scanned 1 files: 2 useState, 0 useEffect, 1 shown.
Re-run legend-doctor after applying change findings; applied changes can reveal new ones.
```

JSON is the preferred agent interface. It includes the action, disposition, evidence, location, message, and any group
or ownership details:

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

| Disposition | Required agent behavior |
| --- | --- |
| `change` | Apply the instruction. Structural proof is complete. |
| `candidate` | Inspect the named source and resolve the uncertainty. |
| `keep` | Preserve the current ownership or lifecycle boundary. |
| `style` | Apply only when project policy requires the equivalent Legend API. |

## What it detects

| Finding | Work removed |
| --- | --- |
| `delete-unused-state` | State cells and updates with no consumer |
| `delete-derived-state`, `delete-effect` | Effect-driven derived state and its second render |
| `move-state-down` | Parent renders caused by state owned by one stable child |
| `use-observable` | Parent renders caused by leaf-only, async, dialog, or keyed-row state |
| `use-ref` | Renders caused by command-only values |
| `use-value` | Duplicate React mirrors of Legend state |
| `move-to-event` | Post-commit reset renders caused by event-driven effects |
| `use-observe-effect` | Component subscriptions used only by external reactions |
| `use-mount`, `use-unmount` | Equivalent empty-dependency lifecycle effects |
| `narrow-use-value-subscription` | Notifications from unused sibling fields |
| `split-use-value-leaves` | Shared invalidation between independent render leaves |
| `move-use-value-down` | Parent renders from a leaf-only subscription |
| `pass-observable-to-use-value` | Redundant selectors and eager reads |
| `replace-legacy-use-value` | Legacy Legend selector calls |
| `use-peek-for-snapshot` | Tracking reads in non-tracking commands and callbacks |
| `narrow-observable-write` | Object, record, or array cloning for one narrow write |
| `toggle-observable` | Generic boolean updater callbacks |
| `assign-observable-fields` | Intermediate publications between sibling field writes |
| `batch-observable-writes` | Intermediate publications across observable roots |
| `review-state`, `review-effect` | Unproven opportunities that need source inspection |
| `keep-state`, `keep-effect` | State or effects whose current boundary is required |

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

### Isolate async status from the editor

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

The leaf may combine the flag with state-independent input, as in `disabled={pending || queueFull}`. Calls, multiple
consumers, repeated controls, and pending-controlled mount gates remain candidates.

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

The pinned corpus covers 2,356 hooks across 225 targets, with 798 manually audited hook labels, 18 state groups, and
106 Legend practice labels.

| Check | Result |
| --- | ---: |
| Unit tests | 534/534 |
| Actionable precision | 429/429 |
| Actionable recall | 429/430 |
| Legend practice precision | 106/106 |

The one unresolved opportunity remains a candidate because its callback timing is not structurally proven.
