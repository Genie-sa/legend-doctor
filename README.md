# Legend Doctor

Legend Doctor finds avoidable React renders and unsafe Legend State boundaries. It gives coding agents a concrete edit,
the structural proof behind it, and the state lifetime that must survive the change.

It catches work that file-at-a-time lint rules miss:

- React state owned above its only consumer
- effects that add a second render or mirror an event
- broad Legend subscriptions that invalidate unrelated UI
- tracked reads in snapshot-only code
- object writes that publish more state than they change
- related writes that expose intermediate state

The analyzer is read-only. The agent edits the application, runs its checks, and scans again.

Legend Doctor follows the official
[Legend State best-practices skill](https://github.com/LegendApp/legend-skills/tree/main/legend-state-best-practices): keep
observable ownership at the required lifetime, subscribe with `useValue` at the smallest stable render leaf, use
`.peek()` for proven snapshots, and publish the narrowest safe transaction.

## Agent workflow

Build once, then scan the smallest complete root that contains the relevant components, hooks, barrels, and observable
definitions.

```bash
npm install
npm run build
node dist/src/cli.js /absolute/path/to/app-or-feature --actionable
```

For every edit loop:

1. Run Legend Doctor before editing.
2. Apply each `change` as a semantic instruction.
3. Inspect each `candidate`. Edit only after source proves the missing ownership or timing fact.
4. Run the application's typecheck and tests.
5. Run Legend Doctor again and account for every changed finding.

Useful machine-readable views:

```bash
# Proven edits only
node dist/src/cli.js /absolute/path/to/root --json --disposition change

# Opportunities that need more source proof
node dist/src/cli.js /absolute/path/to/root --json --disposition candidate

# Parser, file, function, semantic, and bounded-flow coverage
node dist/src/cli.js /absolute/path/to/root --json --coverage
```

`--actionable` shows `change` and `candidate` findings, hides intentional keeps, and prints one primary instruction for
each grouped state migration.

## Output

Text output is short enough to drive an edit loop:

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

| Disposition | Agent action |
| --- | --- |
| `change` | Apply the instruction. The structural proof is complete. |
| `candidate` | Inspect the missing proof and preserve the code until it is resolved. |
| `keep` | Preserve the current React ownership or lifecycle boundary. |
| `style` | Use the equivalent Legend API only when project policy calls for it. |

## Detection examples

### Delete state that does no work

```tsx
// before
const [value, setValue] = useState("");
const clear = () => setValue("");

// after
const clear = () => {};
```

`delete-unused-state` removes a state cell when neither its current nor assigned values reach rendering or another
command. Evaluation with side effects stays at its original statement position.

### Delete synchronized derived state

```tsx
// before
const [fullName, setFullName] = useState("");
useEffect(() => setFullName(`${first} ${last}`), [first, last]);

// after
const fullName = `${first} ${last}`;
```

`delete-derived-state` and `delete-effect` remove the stale commit and follow-up render.

### Move state into its only owner

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

`move-state-down` requires every read and write to belong to one stable child. Typing stops rerendering `Page` and
`Dashboard`.

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

`use-ref` preserves callback timing while removing a render that no JSX consumes.

### Keep lifetime high and notification low

```tsx
// before
function AccountsPage() {
  const [target, setTarget] = useState<Account | null>(null);
  return <><Accounts onDelete={setTarget} /><DeleteDialog account={target} /></>;
}

// after
function AccountsPage() {
  const target$ = useObservable<Account | null>(null);
  return <><Accounts onDelete={value => target$.set(value)} /><DeleteDialogState target$={target$} /></>;
}
function DeleteDialogState({ target$ }: { target$: Observable<Account | null> }) {
  return <DeleteDialog account={useValue(target$)} />;
}
```

`use-observable` keeps page-lifetime ownership but rerenders only the dialog leaf.

### Remove state that mirrors an observable

```tsx
// before
const savedName = useSavedName();
const [name, setName] = useState(savedName);
const changeName = (next: string) => {
  setName(next);
  writeName(next);
};

// after
const name = useSavedName();
const changeName = writeName;
```

`use-value` follows the source-proven Legend reader and writer, then removes duplicate React storage and its second
update path.

### Move a reset into the command that caused it

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

`move-to-event` is emitted only after every mutation is proven. The reset happens in the causal command without a
post-commit update.

### React to Legend without subscribing React

```tsx
// before
const theme = useValue(settings$.theme);
useEffect(() => syncTheme(theme), [theme]);

// after
useObserveEffect(() => syncTheme(settings$.theme.get()));
```

`use-observe-effect` removes a component subscription used only to trigger an external reaction.

### Express bounded mount and teardown work

```tsx
// before
useEffect(() => start(), []);
useEffect(() => () => stop(), []);

// suggested Legend forms
useMount(() => start());
useUnmount(() => stop());
```

`use-mount` and `use-unmount` expose setup-only and teardown-only effects. The finding stays conservative when React
Strict Mode replay, setup work, or disposer ownership is unresolved.

### Narrow a broad subscription

```tsx
// before
const profile = useValue(profile$);
return <Name>{profile.name}</Name>;

// after
const name = useValue(profile$.name);
return <Name>{name}</Name>;
```

`narrow-use-value-subscription` stops sibling fields from invalidating the component.

### Split independent render leaves

```tsx
// before
const user = useValue(user$);
return <><Name value={user.name} /><Avatar src={user.avatarUrl} /></>;

// after
return <><NameState name$={user$.name} /><AvatarState avatar$={user$.avatarUrl} /></>;
```

`split-use-value-leaves` gives each stable leaf its own subscription. Updating a name no longer rerenders the avatar.

### Move a subscription below a conditional value

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

`move-use-value-down` keeps the subscriber mounted while preserving the selected child's mount behavior.

### Pass the observable directly

```tsx
// before
const name = useValue(() => profile$.name.get());

// after
const name = useValue(profile$.name);
```

`pass-observable-to-use-value` simplifies only a proven direct path. Computed selectors stay callbacks.

### Replace legacy Legend selectors

```tsx
// before
const name = useSelector(profile$.name);

// after
const name = useValue(profile$.name);
```

`replace-legacy-use-value` resolves named aliases and namespace imports from `@legendapp/state/react`. Unrelated
lookalike functions do not qualify.

### Keep snapshot reads non-tracking

```tsx
// event snapshot
const save = () => persist(settings$.theme.peek());

// lifecycle snapshot
useMount(() => register(panelSize$.peek()));

// observable listener snapshot
settings$.theme.onChange(() => persist(audit$.latestTheme.peek()));
```

`use-peek-for-snapshot` replaces zero-argument `.get()` in a proven event, initializer, direct React effect, or direct
Legend mount or unmount callback. It also handles an inline, one-argument `.onChange()` listener on a proven Legend
observable. Listener options, named or nested callbacks, tracking callbacks, render reads, and unproven getters stay
unchanged because their execution or tracking context is not fully proven.

It also follows callback contracts across files:

```tsx
// owner.tsx
<HookBridge getValue={() => settings$.showPanel.get()} />

// HookBridge.tsx
function HookBridge({ getValue }: { getValue: () => boolean }) {
  useLayoutEffect(() => publish(getValue()), [getValue]);
  return null;
}
```

When source proves that `getValue` is invoked only by the layout effect, the owner read becomes `.peek()`.

### Publish only the changed path

```tsx
settings$.set({ ...settings$.peek(), theme }); // before
settings$.theme.set(theme);                    // after

items$.set([...items$.peek(), item]);          // before
items$.push(item);                              // after

menu$.open.set(!menu$.open.peek());            // before
menu$.open.toggle();                            // after
```

`narrow-observable-write` and `toggle-observable` avoid replacing unchanged siblings or existing array entries.

### Publish one atomic transition

```tsx
// before
draft$.name.set(name);
draft$.color.set(color);

// after
draft$.assign({ name, color });
```

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

`assign-observable-fields` and `batch-observable-writes` hide intermediate state. The analyzer preserves overlapping
paths, awaits, order-sensitive reads, and partial write runs.

## What it can report

| Area | Findings |
| --- | --- |
| React state | `delete-unused-state`, `delete-derived-state`, `move-state-down`, `use-ref`, `use-observable`, `use-value`, `keep-state`, `review-state` |
| React effects | `delete-effect`, `move-to-event`, `use-observe-effect`, `use-mount`, `use-unmount`, `keep-effect`, `review-effect` |
| Legend reads | `narrow-use-value-subscription`, `split-use-value-leaves`, `move-use-value-down`, `pass-observable-to-use-value`, `replace-legacy-use-value`, `use-peek-for-snapshot` |
| Legend writes | `narrow-observable-write`, `toggle-observable`, `assign-observable-fields`, `batch-observable-writes` |

## Safety rules for agents

- Apply findings as semantic instructions, not text replacements.
- Keep observable ownership at the lifetime named by `stateModel`.
- Subscribe at the lowest proven stable render leaf.
- Use `.peek()` only in proven non-tracking code.
- Apply grouped state findings as one transaction.
- Preserve effect phase, dependencies, cleanup, write order, mount identity, list keys, and conditional cardinality.
- Keep candidates unchanged until source inspection completes the proof.

Component names, file paths, app allowlists, and corpus-specific exceptions never count as proof.

## Verified baseline

The pinned corpus contains 2,356 hooks across 225 targets, 796 manually audited hook labels, 18 state groups, and 106
Legend practice labels.

- Unit tests: 530/530
- Actionable precision: 100% at 426/426
- Actionable recall: 99.8% at 426/427
- Legend practice precision: 100% at 106/106

The one known opportunity remains visible as a non-enforced recall miss because moving it could change callback timing.
The corpus covers Tree Map, Tree Wallet, Memoria, Legend Music, Excalidraw, Expensify, Formbricks, Outline, Genie Courses,
Open WebUI React Native, and Hoalu.

Detector work follows [AGENTS.md](AGENTS.md). Corpus and scoring work follows [evals/README.md](evals/README.md).
