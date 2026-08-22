# Legend Doctor

Legend Doctor tells coding agents where React and Legend State create avoidable renders, effect passes, broad
subscriptions, or repeated publications. Every proposed change includes structural evidence. Unproven opportunities
stay review findings.

The tool is read-only. The agent edits the application.

Its targets follow the official
[Legend State best-practices skill](https://github.com/LegendApp/legend-skills/tree/main/legend-state-best-practices):
subscribe at the smallest render leaf, use `useValue` for render data, use `.peek()` for proven non-tracking snapshots,
and publish the narrowest safe transaction.

## Run it

```bash
npm install
npm run build
node dist/src/cli.js /absolute/path/to/app-or-feature --actionable
```

Scan the smallest root that still contains the imported components, hooks, barrels, and observable definitions needed
for cross-file proof.

Agent loop:

1. Scan before editing.
2. Apply every `change` finding as a semantic instruction.
3. Inspect each `candidate`; edit only after proving the missing ownership or timing fact.
4. Run the application's typecheck and tests.
5. Scan again. Account for every changed finding.

Useful views:

```bash
# Proven edits
node dist/src/cli.js /absolute/path/to/root --json --disposition change

# Opportunities that need source inspection
node dist/src/cli.js /absolute/path/to/root --json --disposition candidate

# Parser, file, function, semantic, and bounded-flow coverage
node dist/src/cli.js /absolute/path/to/root --json --coverage
```

`--actionable` prints changes and candidates, hides intentional keeps, and emits one primary instruction per grouped
state migration.

## Read the output

Text is optimized for an agent edit loop:

```text
src/MergeTags.tsx:29:29 [delete-unused-state] Delete React state `value` and its setter calls; assigned values are never consumed.
Scanned 1 files: 2 useState, 0 useEffect, 1 shown.
Re-run legend-doctor after applying change findings; applied changes can reveal new ones.
```

JSON includes the proof and target state boundary:

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
| `candidate` | Inspect the named missing proof. Preserve the code until it is resolved. |
| `keep` | Preserve the React ownership or lifecycle boundary. |
| `style` | Use the equivalent Legend API only when project policy requires it. |

## What it detects

### React state

| Finding | Detected shape | Value |
| --- | --- | --- |
| `delete-unused-state` | State is written but never consumed | Deletes the state cell and every render it scheduled |
| `delete-derived-state` | An effect mirrors render inputs into state | Deletes the stale commit and synchronization render |
| `move-state-down` | One stable child owns every read and write | Rerenders the child instead of its parent subtree |
| `use-ref` | Listener or command data never affects JSX | Preserves the value without render notification |
| `use-observable` | Ownership must stay high while rendered reads are leaf-local | Keeps lifetime and moves notification to Legend leaves |
| `use-value` | React state mirrors one proven observable source | Removes the duplicate state and update path |
| `keep-state` | React already owns the smallest cohesive boundary | Prevents a migration that would split identity or atomic behavior |
| `review-state` | A callback, owner, or path remains unresolved | Makes the missing proof explicit |

### React effects

| Finding | Detected shape | Value |
| --- | --- | --- |
| `delete-effect` | An effect only derives render data | Calculates once per render instead of rendering twice |
| `move-to-event` | An effect resets state after one proven command changes | Performs one causal transition without a follow-up commit |
| `use-observe-effect` | A post-mount reaction only follows Legend values | Reacts without subscribing the component |
| `use-mount` | A bounded setup-only mount effect | Exposes the once-only Legend lifecycle option |
| `use-unmount` | A bounded teardown-only effect | Exposes the once-only Legend teardown option |
| `keep-effect` | Cleanup, committed refs, persistence, or integration timing owns the effect | Prevents lifecycle regressions |
| `review-effect` | Effect timing, callback source, or cleanup is unresolved | Keeps uncertain timing changes out of actionable output |

### Legend subscriptions and reads

| Finding | Detected shape | Value |
| --- | --- | --- |
| `narrow-use-value-subscription` | A whole object subscription renders one field | Sibling fields stop invalidating the component |
| `split-use-value-leaves` | One object subscription feeds independent JSX leaves | Each field rerenders only its own leaf |
| `move-use-value-down` | A large owner subscribes for one stable leaf | Observable updates bypass the owner subtree |
| `pass-observable-to-use-value` | `useValue` wraps one direct `.get()` | Uses the direct leaf subscription API |
| `replace-legacy-use-value` | `useSelector` or `use$` reads a proven observable | Migrates to the current `useValue` API |
| `use-peek-for-snapshot` | An event, initializer, or source-proven React effect callback calls `.get()` | Avoids accidental tracking in snapshot code |

### Legend writes

| Finding | Detected shape | Value |
| --- | --- | --- |
| `narrow-observable-write` | A whole object or array is cloned to change one part | Publishes only the changed path or append |
| `toggle-observable` | A boolean is read, inverted, and written | Uses one direct observable operation |
| `assign-observable-fields` | Consecutive sibling fields are written together | Publishes one object transition |
| `batch-observable-writes` | Consecutive independent roots form one safe transaction | Hides intermediate state from observers |

## Before and after

### Delete a synchronization render

```tsx
// before
const [fullName, setFullName] = useState("");
useEffect(() => setFullName(`${first} ${last}`), [first, last]);

// after
const fullName = `${first} ${last}`;
```

Detected as `delete-derived-state` plus `delete-effect`. The rendered value is available immediately and React skips the
post-commit update.

### Rerender the input, not the page

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

Detected as `move-state-down` only when every state read and write belongs to the same stable child. Typing no longer
rerenders `Page` or `Dashboard`.

### Keep ownership high and notification low

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
  const account = useValue(target$);
  return <DeleteDialog account={account} />;
}
```

Detected as `use-observable`. The observable keeps the page lifetime; only the dialog leaf subscribes and rerenders.

### Keep a conditional subscriber mounted

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

Detected as `move-use-value-down`. The wrapper stays mounted, preserving subscription lifetime and the conditional
child's mount behavior while removing the page subscription.

### Split independent observable leaves

```tsx
// before
const user = useValue(user$);
return <><Name value={user.name} /><Avatar src={user.avatarUrl} /></>;

// after
return <><NameState name$={user$.name} /><AvatarState avatar$={user$.avatarUrl} /></>;
```

Detected as `split-use-value-leaves` only when both leaf boundaries are stable. A name change does not rerender the
avatar, and an avatar change does not rerender the name.

### Narrow a subscription without adding components

```tsx
// before
const profile = useValue(profile$);
return <Name>{profile.name}</Name>;

// after
const name = useValue(profile$.name);
return <Name>{name}</Name>;
```

Detected as `narrow-use-value-subscription`. Unrelated profile fields stop invalidating this component.

### Use the direct Legend subscription API

```tsx
// before
const name = useValue(() => profile$.name.get());

// after
const name = useValue(profile$.name);
```

Detected as `pass-observable-to-use-value`. Computed selectors remain callbacks; only a proven direct observable path is
simplified.

### Keep snapshot reads non-tracking across files

```tsx
// owner.tsx
<HookBridge getValue={() => settings$.showPanel.get()} />

// HookBridge.tsx
function HookBridge({ getValue }: { getValue: () => boolean }) {
  useLayoutEffect(() => publish(getValue()), [getValue]);
  return null;
}
```

Legend Doctor resolves the imported component and proves that `getValue` is directly invoked only by the React layout
effect. It emits `use-peek-for-snapshot` for `settings$.showPanel.get()`. A callback used during render or forwarded to an
unknown subscriber does not pass this proof.

### Move a reset into its cause

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

Detected as `move-to-event` only after every query mutation is proven. The reset becomes part of one causal command; a
Legend migration uses one `.assign()` or `batch()` transaction.

### React to Legend without rerendering React

```tsx
// before
const theme = useValue(settings$.theme);
useEffect(() => syncTheme(theme), [theme]);

// after
useObserveEffect(() => syncTheme(settings$.theme.get()));
```

Detected as `use-observe-effect`. The component no longer subscribes only to trigger an effect.

### Replace render-neutral state with a ref

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

Detected as `use-ref` only when the value never affects JSX and callback timing remains intact. Connecting no longer
causes a render.

### Publish the smallest Legend change

```tsx
settings$.set({ ...settings$.peek(), theme }); // before
settings$.theme.set(theme);                    // after

items$.set([...items$.peek(), item]);          // before
items$.push(item);                              // after

menu$.open.set(!menu$.open.peek());            // before
menu$.open.toggle();                            // after
```

Detected as `narrow-observable-write` or `toggle-observable`. Unchanged siblings and existing array entries are not
replaced.

### Publish one atomic transition

```tsx
// before: sibling fields
draft$.name.set(name);
draft$.color.set(color);

// after
draft$.assign({ name, color });

// before: independent roots
session$.user.set(user);
router$.route.set("home");

// after
batch(() => {
  session$.user.set(user);
  router$.route.set("home");
});
```

Detected as `assign-observable-fields` or `batch-observable-writes`. Overlapping paths, awaits, order-sensitive reads,
and partial write runs remain unchanged.

## Safety boundary

Apply findings as semantic instructions, not text replacements.

- Keep observable ownership at the lifetime named by `stateModel`.
- Subscribe with `useValue` at the lowest proven stable render leaf.
- Read snapshots with `.peek()` only in proven non-tracking code.
- Apply grouped state findings as one transaction.
- Preserve effect phase, dependencies, cleanup, write order, mount identity, list keys, and conditional cardinality.
- Preserve candidates until source inspection completes the proof.

Component names, file paths, application allowlists, and corpus-specific exceptions never count as proof.

## Verified baseline

The pinned corpus contains 2,356 hooks across 225 targets, 796 manually audited hook labels, 18 state groups, and 103
Legend practice labels.

- Unit tests: 526/526
- Actionable precision: 100% at 426/426
- Actionable recall: 99.8% at 426/427
- Legend practice precision: 100% at 103/103

The one known opportunity remains visible as a non-enforced recall miss. The corpus covers Tree Map, Tree Wallet,
Memoria, Legend Music, Excalidraw, Expensify, Formbricks, Outline, Genie Courses, Open WebUI React Native, and Hoalu.

Detector work follows [AGENTS.md](AGENTS.md); corpus and scoring work follows [evals/README.md](evals/README.md).
