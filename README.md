# Legend Doctor

Static analysis for coding agents that optimize React `useState` and `useEffect` with Legend State.

Legend Doctor scans an app and returns file-level refactoring instructions. It finds where an observable can reduce
owner renders, where a subscription belongs, which states must move together, and which React effects must stay intact.

## What it delivers

| Input | Output |
| --- | --- |
| React `useState` | Keep, delete, move, use a ref, reuse an observable, or create an observable |
| React `useEffect` | Keep, delete, move to an event, or use a Legend lifecycle/reaction hook |
| Coupled state | One grouped model instead of several conflicting edits |
| Render usage | The smallest proven subscriber: leaf, row selector, gate, or call-site wrapper |
| Risk | File, line, confidence, evidence, and explicit review cases |

### Optimization value

| Pattern | Before | Target result |
| --- | --- | --- |
| Selected row | Owner and all rows render | At most the old and new row render |
| Form draft | Every keystroke renders the form owner | Only subscribed fields and validation leaves render |
| Modal payload | Opening a dialog renders its table/page owner | The dialog call-site subscriber renders |
| Coupled state | Several independent edits risk split transitions | One atomic observable model |
| React effect | Easy to change timing while refactoring | Cleanup, dependencies, and commit phase stay explicit |

## Current proof

| Measure | Result |
| --- | ---: |
| Analyzed app roots | 9 |
| Pinned source targets | 92 |
| Inventoried hooks | 1,738 |
| Manual labels | 490 |
| Grouped-model checks | 12/12 |
| Unit tests | 207/207 |
| Actionable precision | 100% (264/264) |
| Actionable recall | 91.0% (264/290) |
| `use-observable` recall | 91.9% (215/234) |

The corpus covers Tree Map, Tree Wallet, Memoria, Legend Music, Excalidraw, Expensify, Formbricks, and Outline. Repos and
commits are pinned so source drift cannot improve the score accidentally.

## Agent workflow

**Agent rule:** run Legend Doctor before and after every React state/effect optimization.

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

## Clear before and after

### 1. Selected row: 100 rows → about 2 row renders

**Before:** one cursor update invalidates the list owner and all 100 rows.

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

**Doctor says:**

```text
search.tsx:31:31 [use-observable] Replace scalar row-selection state `active` with a
component-lifetime observable; extract a stable-keyed row component and subscribe with a
per-item `useValue(() => active$.get() === rowDiscriminator)` selector.
```

**After:** the owner keeps one observable. Each row subscribes to one boolean.

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

**Impact:** changing row 12 → row 13 can rerender 2 row subscribers instead of the owner plus 100 rows.

### 2. Dialog state: page render → dialog render

**Before:** opening a dialog rerenders the table, filters, toolbar, and dialog.

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

**Doctor says:**

```text
accounts-page.tsx:18:35 [use-observable] Keep `deleteTarget` in a component-lifetime
observable and subscribe at the single dialog call site. Keep table callbacks command-only.
```

**After:** table commands update the observable; one stable wrapper subscribes for the dialog.

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

**Impact:** open and close update 1 dialog boundary instead of rebuilding the page and table.

### 3. Effect-synchronized draft: 2 setter calls → 1 atomic assignment

**Before:** mounting can render the sheet, run the effect, then render it again. Every edit renders it again.

```tsx
const [name, setName] = useState("");
const [color, setColor] = useState("");

useEffect(() => {
  setName(session.name);
  setColor(session.color);
}, [session]);
```

**Doctor says:**

```text
SessionSheet.tsx:44:27 [use-observable] Replace the effect-synchronized React draft cluster
(`name`, `color`, `anchor`) with one component-lifetime observable model. Preserve the React
effect and assign the draft atomically.

SessionSheet.tsx:53:3 [review-effect] Preserve this React synchronization effect and its
dependency timing. Replace only its setter calls with one atomic observable assignment.
```

**After:** keep the React effect and dependency timing. Change only its state sink.

```tsx
const draft$ = useObservable({ name: "", color: "" });

useEffect(() => {
  draft$.assign({ name: session.name, color: session.color });
}, [session]);

const save = () => submit(draft$.peek());

function NameField({ draft$ }) {
  const name = useValue(draft$.name);
  return <Input value={name} onChangeText={next => draft$.name.set(next)} />;
}
```

**Impact:** the synchronization write no longer forces a second owner render; edits update subscribed fields.

### 4. Teardown ownership: keep setup out, move cleanup

**Before:** an empty-dependency effect exists only to return cleanup.

```tsx
useEffect(() => {
  return () => tooltip.hide();
}, []);
```

**Doctor says:**

```text
Tooltip.tsx:93:3 [use-unmount] Replace this teardown-only empty-dependency effect with
`useUnmount` if once-only Legend lifecycle semantics are intended.
```

**After:** lifecycle intent is explicit.

```tsx
useUnmount(() => tooltip.hide());
```

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
