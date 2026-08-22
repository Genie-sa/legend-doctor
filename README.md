# Legend Doctor

Legend Doctor is a read-only analyzer for coding agents working on React and Legend State. It finds proven React
renders, effect passes, broad subscriptions, and repeated observable publications, then names the safer boundary.

The tool produces instructions. The agent inspects and edits the application.

## Agent loop

```bash
npm install
npm run build
node dist/src/cli.js /absolute/path/to/app-or-feature --actionable
```

Use the smallest root that still contains imported components and hooks needed for cross-file proof. Use a feature or
application root when state, callbacks, barrels, or observable provenance cross files.

1. Scan before editing.
2. Apply findings with `disposition: "change"`.
3. Inspect `candidate` findings. Change code only after proving the missing fact.
4. Run the application's typecheck and tests.
5. Scan again until every edited finding is accounted for.

Useful filters:

```bash
# Proven changes
node dist/src/cli.js /absolute/path/to/root --json --disposition change

# Unproven candidates
node dist/src/cli.js /absolute/path/to/root --json --disposition candidate

# Analyzed files and functions
node dist/src/cli.js /absolute/path/to/root --json --coverage
```

`--actionable` shows changes and candidates, hides keeps, and prints one primary instruction for each state group.

## Output

Text output is built for a short agent loop:

```text
src/MergeTags.tsx:29:29 [delete-unused-state] Delete React state `value` and its setter calls; assigned values are never consumed.
Scanned 1 files: 2 useState, 0 useEffect, 1 shown.
Re-run legend-doctor after applying change findings; applied changes can reveal new ones.
```

JSON adds the structural proof and target state model:

```json
{
  "action": "use-observable",
  "confidence": "certain",
  "disposition": "change",
  "evidence": ["owner: SettingsPage, lines 20-190, JSX elements 24"],
  "location": { "file": "src/SettingsPage.tsx", "line": 42, "column": 31 },
  "stateModel": {
    "ownership": "local-observable",
    "subscription": "leaf-use-value"
  }
}
```

| Disposition | Agent action |
| --- | --- |
| `change` | Apply the instruction. The structural proof is complete. |
| `candidate` | Inspect the named ownership, timing, or subscription boundary. |
| `keep` | Preserve React ownership or lifecycle. |
| `style` | Apply the equivalent Legend API when project policy wants it. |

## React state examples

### `[delete-unused-state]` Delete an unused render source

Before: `const [sent, setSent] = useState(false); const save = () => { setSent(true); onSave(); };`

After: `const save = () => onSave();`

Value: one state cell and every render it scheduled disappear.

### `[delete-derived-state]` and `[delete-effect]` Calculate during render

Before: `useEffect(() => setFullName(first + " " + last), [first, last]);`

After: `const fullName = first + " " + last;`

Value: no stale commit and no synchronization render.

### `[move-state-down]` Put state in its only stable owner

```tsx
// before
function Page() {
  const [query, setQuery] = useState("");
  return <><Dashboard /><SearchBox query={query} onChange={setQuery} /></>;
}

// after
function SearchBox() {
  const [query, setQuery] = useState("");
  return <input value={query} onChange={event => setQuery(event.target.value)} />;
}
```

Value: typing rerenders `SearchBox`, not `Page` and `Dashboard`.

### `[use-ref]` Keep command data without render notification

Before: an effect loads `payload` into `useState`, no JSX reads it, and a proven event reads it later.

After: the effect writes `payloadRef.current`; the event reads the same ref.

Value: loading command-only data no longer rerenders the owner. The proof preserves callback timing and snapshot order.

### `[use-observable]` Keep ownership high and subscribe low

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

Value: the observable keeps the original lifetime, but only the dialog leaf rerenders.

### `[use-observable]` Keep an effect and move its presentation sink

Before: a resize effect writes `width` in a large page, and only `<WidthLabel>` renders it.

After: the same effect writes `width$`; a stable label leaf calls `useValue(width$)`.

Value: resize no longer rerenders the page. Effect phase, dependencies, listener cleanup, and ownership stay unchanged.

### `[use-observable]` Subscribe inside a JSX child callback

```tsx
// before
const [hovered, setHovered] = useState(false);
return <Picker>{() => (
  <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
    <Icon fill={hovered ? "green" : "gray"} />
  </div>
)}</Picker>;

// after
const hovered$ = useObservable(false);
return <Picker>{() => <HoverLeaf hovered$={hovered$} />}</Picker>;
```

Value: hover rerenders one stable leaf. The tool proves the callback position and every deferred event producer.

## React effect examples

### `[move-to-event]` Put a reset in its causal command

Before: `useEffect(() => setPage(1), [query]);`

After: the proven query mutation writes `query` and resets `page` in the same command.

Value: React skips the post-commit reset render. A Legend migration uses one `.assign()` or `batch()` transition.

### `[use-observe-effect]` React directly to an observable

Before: `const theme = useValue(settings$.theme); useEffect(() => syncTheme(theme), [theme]);`

After: `useObserveEffect(() => syncTheme(settings$.theme.get()));`

Value: the component no longer subscribes and rerenders only to run the reaction.

### `[use-mount]` and `[use-unmount]` Mark a lifecycle candidate

Empty setup and teardown effects become candidates only when the syntax proves the bounded shape. The agent still decides
whether Legend's once-only lifecycle matches the application's Strict Mode policy.

### `[keep-effect]` Preserve React lifecycle

An effect with setup and cleanup stays in React. Record an intentional post-commit effect directly above it:

```tsx
// legend-doctor keep-react-effect: the SDK requires post-commit timing.
useEffect(() => syncSdk(identity), [identity]);
```

Value: the analyzer inventories the decision without proposing a timing change.

## Legend subscription examples

### `[use-value]` Delete a React mirror of an observable

Before: an imported `useSavedName()` value seeds React state, and every React setter call also writes that same value to
the proven observable source.

After: render `useSavedName()` directly and keep the observable writer as the only update path.

Value: the duplicate React state and its extra render disappear.

### `[narrow-use-value-subscription]` Subscribe to the rendered field

Before: `const profile = useValue(profile$); return <Name>{profile.name}</Name>;`

After: `const name = useValue(profile$.name); return <Name>{name}</Name>;`

Value: unrelated profile fields no longer rerender this component.

### `[split-use-value-leaves]` Give sibling fields separate subscribers

Before: `const user = useValue(user$); return <><Name value={user.name} /><Avatar src={user.avatarUrl} /></>;`

After: `<NameState name$={user$.name} />` and `<AvatarState avatar$={user$.avatarUrl} />` subscribe independently.

Value: changing one field rerenders one leaf.

### `[move-use-value-down]` Remove a broad owner subscription

Before: a form owner calls `useValue(request$.pending)` and passes the boolean to `<SaveStatus>`.

After: a stable status leaf receives `request$.pending` and calls `useValue` itself.

Value: pending changes no longer rerender the form.

### `[pass-observable-to-use-value]` Use the direct subscription API

Before: `useValue(() => profile$.name.get())`

After: `useValue(profile$.name)`

Value: direct paths stay direct. Computed selectors remain callbacks. `replace-legacy-use-value` covers the equivalent
migration from legacy React selector hooks.

### `[use-peek-for-snapshot]` Keep commands non-tracking

Before: `const save = () => submit(draft$.get());`

After: `const save = () => submit(draft$.peek());`

Value: the command reads a snapshot without creating a reactive dependency.

## Legend write examples

### `[narrow-observable-write]` Write the changed path or array operation

```tsx
settings$.set({ ...settings$.peek(), theme }); // before
settings$.theme.set(theme);                    // after

items$.set([...items$.peek(), item]);          // before
items$.push(item);                              // after
```

Value: Legend publishes only the field or append that changed.

### `[toggle-observable]` Use the boolean operation

Before: `menu$.open.set(!menu$.open.peek());`

After: `menu$.open.toggle();`

Value: the transition is explicit and performs no tracked read.

### `[assign-observable-fields]` Publish related object fields once

Before: `draft$.name.set(name); draft$.color.set(color);`

After: `draft$.assign({ name, color });`

Value: observers see one object transition.

### `[batch-observable-writes]` Publish multi-root transitions once

```tsx
batch(() => {
  session$.user.set(user);
  router$.route.set("home");
});
```

Value: observers cannot see the intermediate state. Order-sensitive values, overlapping paths, awaits, and partial write
runs stay unchanged.

## Reviews are findings

Legend Doctor emits `review-state` or `review-effect` when proof stops. It emits `keep-state` when React already owns the
smallest cohesive render boundary or moving one field would split an atomic transition.

| Code shape | Missing proof |
| --- | --- |
| Setter passed to an unresolved custom callback | Execution may happen during render, an effect, or an event |
| State controls `key`, list membership, or a conditional owner | Moving it may change mount identity or cardinality |
| Effect callback or setup is unresolved | Moving it may change commit timing or cleanup |
| Fields are co-written on only some paths | Splitting them may expose an intermediate state |
| Observable path or import provenance is unresolved | The exact subscription or write target is unknown |

Component names, file paths, and application allowlists never count as proof.

## Agent safety rules

- Apply a finding as a semantic instruction, not a text replacement.
- Keep observable ownership at the component lifetime named by `stateModel`.
- Put `useValue` in the lowest proven stable leaf and use `.peek()` in commands.
- Apply grouped state findings as one transaction.
- Preserve effect phase, dependencies, cleanup, write order, mount identity, and list keys.
- Leave candidates unchanged until source inspection proves the missing fact.

## Verified baseline

The pinned corpus contains 2,356 hooks across 225 targets and 796 manually audited labels.

- Unit tests: 524/524
- Actionable precision: 100% at 426/426
- Actionable recall: 99.8% at 426/427
- Legend practice precision: 100% at 100/100

The one known opportunity remains visible as a non-enforced recall miss. The corpus covers Tree Map, Tree Wallet, Memoria,
Legend Music, Excalidraw, Expensify, Formbricks, Outline, Genie Courses, Open WebUI React Native, and Hoalu.

## Changing Legend Doctor

Follow [AGENTS.md](AGENTS.md). Read [evals/README.md](evals/README.md) before changing labels or scoring. Add the minimal
adversarial fixture and manually audited pinned label before detector code. Run the typecheck, unit suite, full pinned
corpus, and Legend Doctor after every detector phase. Report action deltas for every application, including zero.
