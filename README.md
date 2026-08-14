# Legend Doctor

Static analysis that tells coding agents how to optimize React `useState`, `useEffect`, and Legend State usage.

One command returns the hook, action, subscription boundary, evidence, and risk. The tool recommends code changes; the
agent implements and verifies them.

## What it delivers

| Input | Output |
| --- | --- |
| React `useState` | Exact action: keep, delete, move, ref, reuse, or observable |
| React `useEffect` | Exact action: keep, delete, event, lifecycle, or reaction |
| Coupled state | One atomic model and one grouped instruction |
| Render scope | Smallest proven subscriber: field, row, gate, or dialog |
| Legend writes | Exact transaction: one `.assign()` or one `batch()` |
| Legend reads | Direct `useValue(observable)` when a selector only unwraps `.get()` |
| Proof | File, line, confidence, evidence, and review boundary |

### Value in numbers

| Case | Before | After target |
| --- | ---: | ---: |
| Select 1 of 100 rows | 1 owner + 100 rows | Up to 2 changed row subscribers |
| Open 1 dialog from a table | Page + table + dialog | 1 dialog subscriber |
| Seed a 3-field draft | 3 React setters | 1 atomic observable write |
| Teardown-only effect | 1 generic effect | 1 explicit lifecycle hook |
| 6 observable field writes | Up to 6 observer flushes | 1 `.assign()` or `batch()` |

## Measured accuracy

| Measure | Result |
| --- | ---: |
| Analyzed app roots | 9 |
| Pinned source targets | 98 |
| Inventoried hooks | 1,747 |
| Manual labels | 503 |
| Grouped-model checks | 12/12 |
| Legend practice checks | 42/42 |
| Unit tests | 247/247 |
| Actionable precision | 100% (275/275) |
| Actionable recall | 92.3% (275/298) |
| `use-observable` recall | 93.4% (225/241) |

These are analyzer-evaluation results, not runtime benchmark claims. The pinned corpus covers Tree Map, Tree Wallet,
Memoria, Legend Music, Excalidraw, Expensify, Formbricks, and Outline.

## Agent workflow

**Agent rule:** run Legend Doctor before and after every React state, effect, or Legend observable optimization.

```bash
npm install
npm run build

# Human-readable instructions
node dist/src/cli.js /path/to/app --actionable

# Structured input for an agent
node dist/src/cli.js /path/to/app --json --actionable
```

Use the result in this order:

1. Run on the smallest relevant app or feature root.
2. Apply `change` findings first.
3. Apply a state cluster as one transaction.
4. Investigate `candidate` findings; do not treat them as proven migrations.
5. Run the app tests and Legend Doctor again.
6. Finish when every changed hook is accounted for and no new unsafe finding appears.

`--actionable` shows `change` and `candidate` findings. Omit it to include intentional `keep` findings.

One JSON finding is enough for an agent to act:

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

## Clear before and after

### 1. Selected row: 101 render targets → up to 2

**Before — scope: owner + 100 rows**

```jsx
function Results({ rows }) {
  const [active, setActive] = useState(0);

  return rows.map((row, index) => (
    <Row
      key={row.id}
      active={active === index}
      onPointerMove={() => setActive(index)}
    />
  ));
}
```

**Finding**

```text
search.tsx:31:31 [use-observable] Replace scalar row-selection state `active` with a
component-lifetime observable; extract a stable-keyed row component and subscribe with a
per-item `useValue(() => active$.get() === rowDiscriminator)` selector.
```

**After — scope: changed row selectors**

```jsx
function Results({ rows }) {
  const active$ = useObservable(0);
  return rows.map((row, index) => (
    <ResultRow key={row.id} row={row} index={index} active$={active$} />
  ));
}

function ResultRow({ row, index, active$ }) {
  const active = useValue(() => active$.get() === index);
  return <Row {...row} active={active} onPointerMove={() => active$.set(index)} />;
}
```

**Result:** changing row 12 → 13 can update 2 boolean subscribers instead of invalidating 101 render targets.

### 2. Dialog state: page + table + dialog → dialog

**Before — scope: whole page**

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

**Finding**

```text
accounts-page.tsx:18:35 [use-observable] Keep `deleteTarget` in a component-lifetime
observable and subscribe at the single dialog call site. Keep table callbacks command-only.
```

**After — scope: one stable dialog wrapper**

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

**Result:** open and close update 1 dialog boundary. The page and table remain command-only.

### 3. Effect-synchronized draft: 3 setters → 1 write

**Before — 3 React state writes**

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

**Finding**

```text
SessionSheet.tsx:44:27 [use-observable] Replace the effect-synchronized React draft cluster
(`name`, `color`, `anchor`) with one component-lifetime observable model. Preserve the React
effect and assign the draft atomically.

SessionSheet.tsx:53:3 [review-effect] Preserve this React synchronization effect and its
dependency timing. Replace only its setter calls with one atomic observable assignment.
```

**After — 1 atomic observable write**

```tsx
const draft$ = useObservable({ name: "", color: "", anchor: null as string | null });

useEffect(() => {
  draft$.set({ name: session.name, color: session.color, anchor: session.anchor });
}, [session]);

const save = () => submit(draft$.peek());

function NameField({ draft$ }) {
  const name = useValue(draft$.name);
  return <Input value={name} onChangeText={next => draft$.name.set(next)} />;
}
```

**Result:** the effect keeps the same timing and dependencies. Its 3 writes become 1 transaction; edits update only
subscribed fields.

### 4. Teardown-only effect: generic effect → explicit lifecycle

**Before — 1 generic React effect**

```tsx
useEffect(() => {
  return () => tooltip.hide();
}, []);
```

**Finding**

```text
Tooltip.tsx:93:3 [use-unmount] Replace this teardown-only empty-dependency effect with
`useUnmount` if once-only Legend lifecycle semantics are intended.
```

**After — 1 explicit teardown hook**

```tsx
useUnmount(() => tooltip.hide());
```

**Result:** cleanup ownership is visible. The agent changes it only when once-only Legend lifecycle semantics are intended.

### 5. Observable fields: 3 `.set()` calls → 1 `.assign()`

**Before — observers may run after every write**

```ts
player$.error.set(message);
player$.isLoading.set(false);
player$.isPlaying.set(false);
```

**Finding**

```text
LocalAudioPlayer.tsx:257:7 [assign-observable-fields] Replace 3 `.set()` calls with one
`player$.assign(...)` for `error`, `isLoading`, `isPlaying`; observers publish once.
```

**After — one shallow object transaction**

```ts
player$.assign({ error: message, isLoading: false, isPlaying: false });
```

When writes span objects or use updater functions, the tool keeps their evaluation semantics and emits
`batch-observable-writes`:

```ts
batch(() => {
  player$.isLoading.set(false);
  session$.error.set(message);
});
```

**Result:** observers see 1 final transaction. `.assign()` is used only for direct fields of 1 object whose values do not
read that observable. Otherwise the result is `batch()`. The rule requires Legend observables proven locally or through
a resolved project export. It ignores tests, Maps, animation values, partial write runs, repeated paths, `await`, and
separated control flow.

### 6. Direct observable read: selector wrapper → observable

**Before — redundant selector**

```ts
const accent = useValue(() => theme$.customColors.dark.accent.primary.get());
```

**Finding**

```text
TrackItem.tsx:62:25 [pass-observable-to-use-value] Replace
`useValue(() => theme$.customColors.dark.accent.primary.get())` with
`useValue(theme$.customColors.dark.accent.primary)`; the direct form keeps the same subscription with less code.
```

**After — direct subscription**

```ts
const accent = useValue(theme$.customColors.dark.accent.primary);
```

**Result:** 1 callback and 1 `.get()` are removed. Computed selectors, shallow reads, dynamic paths, and unproven getters
are left unchanged.

## How findings are classified

| Disposition | Agent response |
| --- | --- |
| `change` | Structural proof is complete; implement and verify |
| `candidate` | The opportunity is real, but the final boundary needs inspection |
| `keep` | React already owns the correct cohesive state or lifecycle |

Legend Doctor is Legend-first, not conversion-first. It keeps React state when the owner is already the right leaf. It
also keeps React effects when resource lifetime, cleanup, commit ordering, or React dependencies require them.

## Development

```bash
npm run typecheck
npm test
```

Evaluation policy, pinned repositories, acceptance gates, and the full corpus command live in
[evals/README.md](evals/README.md).

The analyzer currently recommends changes but does not edit application code.
