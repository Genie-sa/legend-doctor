# Legend Doctor

Static analysis for React and Legend State. It tells coding agents what to change, where to subscribe, and when React
should stay in control.

```bash
npm install
npm run build
node dist/src/cli.js /path/to/app --json --actionable
```

## What you get

| Input | Output |
| --- | --- |
| `useState` | Keep, delete, move down, ref, `useValue`, or observable |
| `useEffect` | Keep, move to event, mount, unmount, or observable reaction |
| Coupled fields | One grouped model and one atomic migration |
| Broad subscriptions | Lowest proven observable path |
| Non-reactive `.get()` | `.peek()` in proven snapshots and commands |
| Whole-object clone writes | Direct child `.set()` on the changed path |
| Multiple Legend writes | One `.assign()` or `batch()` transaction |
| Every finding | File, line, action, confidence, evidence, and boundary |

Measured on pinned real applications:

| Metric | Result |
| --- | ---: |
| App roots | 9 |
| Source targets | 117 |
| Hooks analyzed | 1,850 |
| Manual labels | 562 |
| Unit tests | 281/281 |
| Actionable precision | 100% (297/297) |
| Actionable recall | 93.7% (297/317) |
| Legend practice precision | 100% (60/60) |

These are analyzer evals, not runtime benchmarks. The corpus includes Tree Map, Tree Wallet, Memoria, Legend Music,
Excalidraw, Expensify, Formbricks, and Outline.

## Agent contract

Run Legend Doctor before and after every React state, effect, or Legend observable optimization.

1. Run it on the smallest app or feature root.
2. Apply `change` findings first.
3. Apply every grouped state finding as one transaction.
4. Inspect `candidate` findings; they are opportunities, not proven migrations.
5. Run app tests and Legend Doctor again.
6. Finish when every changed hook is accounted for and no unsafe finding appears.

`--actionable` returns `change` and `candidate`. Omit it to include intentional `keep` findings.

```json
{
  "action": "use-observable",
  "disposition": "change",
  "confidence": "probable",
  "location": { "file": "accounts-page.tsx", "line": 18, "column": 35 },
  "name": "deleteTarget",
  "stateModel": {
    "ownership": "local-observable",
    "subscription": "leaf-use-value"
  }
}
```

## Before and after

### 1. Page state → dialog subscriber

Before: opening a dialog invalidates the page and table.

```tsx
function AccountsPage() {
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);

  return (
    <>
      <AccountsTable onDelete={setDeleteTarget} />
      <DeleteDialog
        account={deleteTarget}
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
```

Output:

```text
accounts-page.tsx:18 [use-observable] Keep `deleteTarget` in a component-lifetime
observable and subscribe at the single dialog call site.
```

After: only the dialog wrapper subscribes.

```tsx
function AccountsPage() {
  const deleteTarget$ = useObservable<Account | null>(null);
  return (
    <>
      <AccountsTable onDelete={account => deleteTarget$.set(account)} />
      <DeleteDialogState deleteTarget$={deleteTarget$} />
    </>
  );
}

function DeleteDialogState({ deleteTarget$ }) {
  const account = useValue(deleteTarget$);
  return (
    <DeleteDialog
      account={account}
      open={account !== null}
      onClose={() => deleteTarget$.set(null)}
    />
  );
}
```

### 2. Effect draft → one atomic model

Before: one synchronization causes three React state writes.

```tsx
const [name, setName] = useState("");
const [color, setColor] = useState("");
const [anchor, setAnchor] = useState<string | null>(null);

useEffect(() => {
  setName(session.name);
  setColor(session.color);
  setAnchor(session.anchor);
}, [session]);
```

Output:

```text
SessionSheet.tsx:44 [use-observable] Replace (`name`, `color`, `anchor`) with one
observable draft. Preserve the React effect and assign the draft atomically.
```

After: the effect keeps its timing and performs one write.

```tsx
const draft$ = useObservable({ name: "", color: "", anchor: null as string | null });

useEffect(() => {
  draft$.set({ name: session.name, color: session.color, anchor: session.anchor });
}, [session]);

function NameField({ draft$ }) {
  const name = useValue(draft$.name);
  return <Input value={name} onChangeText={next => draft$.name.set(next)} />;
}
```

### 3. Broad read → lowest observable path

Before: any `profile$` child can invalidate the component.

```tsx
const profile = useValue(profile$);
return <Name>{profile.name}</Name>;
```

Output:

```text
Profile.tsx:18 [narrow-use-value-subscription] Narrow `profile` from
`useValue(profile$)` to `useValue(profile$.name)`.
```

After: only `profile$.name` is observed.

```tsx
const name = useValue(profile$.name);
return <Name>{name}</Name>;
```

The rule follows nested children and selects the deepest static path shared by every read. Divergent fields, dynamic or
optional access, assertion boundaries, calls, writes, and raw object transport stay unchanged.

### 4. Whole-object clone → direct child write

Before: one field update clones and replaces every sibling.

```ts
const current = profile$.peek();
profile$.set({ ...current, name });
```

Output:

```text
profile.ts:24 [narrow-observable-write] Replace the whole-object clone with
`profile$.name.set(name)`.
```

After:

```ts
profile$.name.set(name);
```

For keyed records, the same rule targets the changed entry:

```ts
records$[recordId].set(record);
```

### 5. Multiple writes → one publication

Before:

```ts
player$.error.set(message);
player$.isLoading.set(false);
player$.isPlaying.set(false);
```

Output:

```text
LocalAudioPlayer.tsx:257 [assign-observable-fields] Replace 3 `.set()` calls with one
`player$.assign(...)`; observers publish once.
```

After:

```ts
player$.assign({ error: message, isLoading: false, isPlaying: false });
```

The tool uses `batch()` when writes span observables or `.assign()` would change evaluation semantics.

### 6. Command read → non-tracking snapshot

Before:

```tsx
const onSave = () => save(profile$.name.get());
```

Output:

```text
Profile.tsx:24 [use-peek-for-snapshot] Replace `profile$.name.get()` with
`profile$.name.peek()`; this code path needs a snapshot, not a reactive dependency.
```

After:

```tsx
const onSave = () => save(profile$.name.peek());
```

The rule is limited to proven React snapshots and event commands. Render reads, Legend reactions, unknown callbacks,
dynamic paths, and shallow `get(true)` stay unchanged.

### 7. Teardown effect → explicit lifecycle

Before:

```tsx
useEffect(() => () => tooltip.hide(), []);
```

Output:

```text
Tooltip.tsx:93 [use-unmount] Replace this teardown-only empty-dependency effect with
`useUnmount` if once-only Legend lifecycle semantics are intended.
```

After:

```tsx
useUnmount(() => tooltip.hide());
```

## Actions

| Disposition | Agent response |
| --- | --- |
| `change` | Proof is complete. Implement and verify. |
| `candidate` | Inspect the final ownership or subscription boundary. |
| `keep` | React already owns the correct state or lifecycle. |

Legend Doctor is Legend-first, not conversion-first. It keeps React when resource lifetime, commit timing, cleanup, or a
cohesive leaf makes React the better owner.

## Development

```bash
npm run typecheck
npm test
```

Rules are split so agents can work on one proof family at a time:

| File | Responsibility |
| --- | --- |
| `src/analyze-source.ts` | Hook inventory, evidence, orchestration |
| `src/rules/effects.ts` | Effect and lifecycle rules |
| `src/rules/effect-drafts.ts` | Effect-synchronized drafts |
| `src/rules/deferred-reveal.ts` | Deferred reveal and render gates |
| `src/rules/keyed-selection.ts` | Row and collection selection |
| `src/rules/observable-clone-writes.ts` | Narrow child writes without parent cloning |
| `src/rules/observable-reads.ts` | Direct and lowest-path reads |
| `src/rules/state-proofs.ts` | Shared state and JSX proofs |
| `src/analyze-legend-practices.ts` | Legend practice orchestration and write transactions |

Pinned repositories, labels, and acceptance gates live in [evals/README.md](evals/README.md).

The tool recommends changes. It does not edit application code.
