# Legend Doctor

Legend Doctor tells coding agents which React and Legend State changes remove a proven render or lifecycle cost.
Each finding includes the edit, the structural evidence, and the ownership boundary that must stay intact.

Use it to find:

- React state that rerenders an owner when only one leaf needs the value
- effects that create a second render or mirror an event
- broad Legend subscriptions that react to unrelated fields
- tracked reads in code that only needs a snapshot
- clone writes that replace unchanged data
- related writes that expose intermediate state

Legend Doctor only reports. The coding agent edits the application, runs its checks, and scans again.

## Run it

Scan the smallest complete root that contains the components, hooks, barrels, and observable definitions involved in
the change.

```bash
npm install
npm run build
node dist/src/cli.js /absolute/path/to/app-or-feature --actionable
```

Use JSON when another agent or script will consume the result.

```bash
# Proven edits
node dist/src/cli.js /absolute/path/to/root --json --disposition change

# Opportunities that still need source inspection
node dist/src/cli.js /absolute/path/to/root --json --disposition candidate

# Parser, file, function, semantic, and bounded-flow coverage
node dist/src/cli.js /absolute/path/to/root --json --coverage
```

`--actionable` shows one primary instruction for each state migration. It includes `change` and `candidate` findings
and hides intentional `keep` findings.

## Agent loop

1. Run Legend Doctor before editing.
2. Apply each `change` as a semantic instruction, not a text replacement.
3. Inspect each `candidate`. Change it only when the missing timing or ownership fact is proven from source.
4. Run the application's formatter, typecheck, and relevant tests.
5. Scan the same root again. Account for every added, removed, or changed finding.
6. Stop when validation passes and the remaining findings are intentional.

A useful agent prompt:

```text
Run Legend Doctor on <absolute root> before editing. Apply proven change findings one semantic group at a time.
Preserve state lifetime, mount identity, effect timing, cleanup, and atomic writes. Inspect candidates but leave them
unchanged without structural proof. Run the app's checks, scan again, and report the finding delta.
```

## Read the output

Text output is the shortest edit loop:

```text
src/MergeTags.tsx:29:29 [delete-unused-state] Delete React state `value` and its setter calls; assigned values are never consumed.
Scanned 1 files: 2 useState, 0 useEffect, 1 shown.
Re-run legend-doctor after applying change findings; applied changes can reveal new ones.
```

JSON carries the proof and target boundary:

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

| Disposition | Required agent action |
| --- | --- |
| `change` | Apply the instruction. The structural proof is complete. |
| `candidate` | Inspect the named uncertainty. Preserve the code until source resolves it. |
| `keep` | Preserve the current React ownership or lifecycle boundary. |
| `style` | Use the equivalent Legend API only when project policy requires it. |

## React state findings

### Delete state with no consumer

```tsx
// before
const [value, setValue] = useState("");
const clear = () => setValue("");

// after
const clear = () => {};
```

`delete-unused-state` removes a state cell and its render scheduling. Side-effectful arguments stay in their original
statement position.

### Calculate derived values during render

```tsx
// before
const [fullName, setFullName] = useState("");
useEffect(() => setFullName(`${first} ${last}`), [first, last]);

// after
const fullName = `${first} ${last}`;
```

`delete-derived-state` and `delete-effect` remove the stale commit and follow-up render.

### Move state into its only stable owner

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

`move-state-down` stops input changes from rerendering `Page` and `Dashboard`. It requires every read and write to
belong to one stable child.

### Keep ownership high and subscribe low

```tsx
// before
function Page() {
  const [target, setTarget] = useState<Account | null>(null);
  return <><Accounts onDelete={setTarget} /><DeleteDialog account={target} /></>;
}

// after
function Page() {
  const target$ = useObservable<Account | null>(null);
  return <><Accounts onDelete={value => target$.set(value)} /><DeleteDialogState target$={target$} /></>;
}
function DeleteDialogState({ target$ }: { target$: Observable<Account | null> }) {
  return <DeleteDialog account={useValue(target$)} />;
}
```

`use-observable` preserves page-lifetime ownership while limiting notification to the dialog leaf.

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
function SaveButtonState({ pending$, onPress }: {
  pending$: Observable<boolean>;
  onPress: () => Promise<void>;
}) {
  return <SaveButton pending={useValue(pending$)} onPress={onPress} />;
}
```

`use-observable` keeps the exact async completion boundary and stops pending transitions from rerendering the editor.

### Subscribe once per keyed row

```tsx
// before
const [selectedId, setSelectedId] = useState<string | null>(null);
return rows.map(row => <Row key={row.id} selected={selectedId === row.id} onPress={() => setSelectedId(row.id)} />);

// after
const selectedId$ = useObservable<string | null>(null);
return rows.map(row => <RowState key={row.id} row={row} selectedId$={selectedId$} />);
function RowState({ row, selectedId$ }: {
  row: Row;
  selectedId$: Observable<string | null>;
}) {
  const selected = useValue(() => selectedId$.get() === row.id);
  return <Row selected={selected} onPress={() => selectedId$.set(row.id)} />;
}
```

`use-observable` replaces a list-wide selection broadcast with one equality subscription per stable keyed row.

### Replace command-only state with a ref

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

`use-ref` removes updates that no render consumes while preserving callback and effect timing.

### Remove a React mirror of Legend state

```tsx
// before
const savedName = useSavedName();
const [name, setName] = useState(savedName);
const rename = (next: string) => { setName(next); writeName(next); };

// after
const name = useSavedName();
const rename = writeName;
```

`use-value` follows the source-proven Legend reader and writer, then removes duplicate storage and its second update
path.

## Effect findings

### Move a reset into its causal command

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

`move-to-event` removes the post-commit update only when every source mutation is proven.

### React to Legend without subscribing the component

```tsx
// before
const theme = useValue(settings$.theme);
useEffect(() => syncTheme(theme), [theme]);

// after
useObserveEffect(() => syncTheme(settings$.theme.get()));
```

`use-observe-effect` removes a component subscription used only to drive an external reaction.

### Separate mount and teardown intent

```tsx
// React forms
useEffect(() => start(), []);
useEffect(() => () => stop(), []);

// Legend forms when once-only semantics are proven
useMount(() => start());
useUnmount(() => stop());
```

`use-mount` and `use-unmount` remain candidates when React Strict Mode replay, setup work, or disposer ownership could
change behavior.

## Legend read findings

### Narrow a broad subscription

```tsx
// before
const profile = useValue(profile$);
return <Name>{profile.contact.name}</Name>;

// after
const name = useValue(profile$.contact.name);
return <Name>{name}</Name>;
```

`narrow-use-value-subscription` stops changes to sibling fields from invalidating the component.

### Split independent fields into independent leaves

```tsx
// before
const user = useValue(user$);
return <><Name value={user.name} /><Avatar src={user.avatarUrl} /></>;

// after
return <><NameState name$={user$.name} /><AvatarState avatar$={user$.avatarUrl} /></>;
```

`split-use-value-leaves` prevents a name change from rerendering the avatar and an avatar change from rerendering the
name.

### Move a subscription into one stable leaf

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

`move-use-value-down` keeps ownership in place and rerenders only the leaf proven to consume the value.

### Preserve a conditional child's mount behavior

```tsx
// before
const error = useValue(request$.error);
return <Page>{error ? <ErrorMessage>{error}</ErrorMessage> : null}</Page>;

// after
return <Page><ErrorState error$={request$.error} /></Page>;
function ErrorState({ error$ }: { error$: Observable<string> }) {
  const error = useValue(error$);
  return error ? <ErrorMessage>{error}</ErrorMessage> : null;
}
```

`move-use-value-down` mounts the subscriber outside the condition, so the selected child's identity stays unchanged.

### Pass the observable directly

```tsx
useValue(() => profile$.name.get()); // before
useValue(profile$.name);             // after

useValue(profile$.avatar.get(), { suspense: true }); // before
useValue(profile$.avatar, { suspense: true });       // after
```

`pass-observable-to-use-value` removes a redundant selector or fixes an eager read while preserving types and options.

### Replace the legacy selector API

```tsx
useSelector(profile$.name); // before
useValue(profile$.name);    // after
```

`replace-legacy-use-value` resolves aliases and namespace imports from `@legendapp/state/react`. Lookalike functions do
not qualify.

### Use snapshots in commands

```tsx
const save = () => persist(settings$.theme.get());  // before
const save = () => persist(settings$.theme.peek()); // after
```

### Use snapshots in lifecycle callbacks

```tsx
useMount(() => register(panelSize$.get()));  // before
useMount(() => register(panelSize$.peek())); // after
```

### Use snapshots in observable listeners

```tsx
settings$.theme.onChange(() => persist(audit$.latestTheme.get()));  // before
settings$.theme.onChange(() => persist(audit$.latestTheme.peek())); // after
```

All three emit `use-peek-for-snapshot`. The rule also follows callbacks across files when source proves they run only
inside an effect. Render reads, tracking APIs, nested callbacks, listener options, and unproven getters keep `.get()`.

## Legend write findings

### Update one object field

```tsx
profile$.set({ ...profile$.peek(), name }); // before
profile$.name.set(name);                    // after
```

`narrow-observable-write` avoids cloning and replacing unaffected siblings.

### Update one dynamic record entry

```tsx
rows$.set({ ...rows$.peek(), [id]: row }); // before
rows$[id].set(row);                        // after
```

`narrow-observable-write` preserves the record and publishes only the changed entry.

### Append one inert value

```tsx
items$.set(previous => [...previous, item]); // before
items$.push(item);                           // after
```

`narrow-observable-write` avoids cloning and replacing existing entries. The rule abstains when value evaluation or
array identity is not exact.

### Toggle directly

```tsx
menu$.open.set(value => !value); // before
menu$.open.toggle();             // after
```

`toggle-observable` expresses the same proven boolean update with the direct Legend operation.

### Assign fields as one publication

```tsx
// before
draft$.name.set(name);
draft$.color.set(color);

// after
draft$.assign({ name, color });
```

`assign-observable-fields` prevents observers from seeing a half-updated object.

### Batch writes across roots

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

`batch-observable-writes` publishes one transaction. It preserves overlapping paths, awaits, order-sensitive reads,
and partial write runs.

## Safety contract

- Check the installed `@legendapp/state` version and types before applying an API migration.
- Keep cohesive one-off UI state in React unless an observable removes a proven owner render.
- Keep observable ownership at the lifetime in `stateModel`.
- Subscribe with `useValue` at the lowest proven stable render leaf.
- Use `.peek()` only where the finding proves non-tracking execution.
- Apply grouped state findings as one migration.
- Preserve effect phase, dependencies, cleanup, write order, mount identity, list keys, and conditional cardinality.
- Treat component names, paths, app allowlists, and corpus exceptions as context, never as proof.

These rules follow the official
[Legend State best-practices skill](https://github.com/LegendApp/legend-skills/tree/main/legend-state-best-practices).

## Verified accuracy

The pinned corpus has 2,356 hooks across 225 targets, 796 manually audited hook labels, 18 state groups, and 106
Legend practice labels.

- Unit tests: 530/530
- Actionable precision: 426/426
- Actionable recall: 426/427
- Legend practice precision: 106/106

The unresolved opportunity stays non-enforced because changing it could alter callback timing.
