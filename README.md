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

## Before and after

### Row-local selection

Before: every cursor update rerenders the list owner and every row.

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

After: the owner keeps one stable observable; each row subscribes to one boolean.

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

Tool output:

```text
search.tsx:31:31 [use-observable] Replace scalar row-selection state `active` with a
component-lifetime observable; extract a stable-keyed row component and subscribe with a
per-item `useValue(() => active$.get() === rowDiscriminator)` selector, while event commands
read or update the cursor without subscribing.
```

Result: keyboard and pointer updates target row selectors instead of invalidating the 28-element search owner.

### Effect-synchronized draft

Before: the synchronization effect and every field edit rerender the sheet owner.

```tsx
const [name, setName] = useState("");
const [color, setColor] = useState("");

useEffect(() => {
  setName(session.name);
  setColor(session.color);
}, [session]);
```

After: keep the React effect and its timing, but assign one observable draft atomically.

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

Tool output:

```text
SessionSheet.tsx:44:27 [use-observable] Replace the effect-synchronized React draft cluster
(`name`, `color`, `anchor`) with one component-lifetime observable model; preserve the React
synchronization effect and its dependencies, assign the draft atomically there, and subscribe
only in rendered leaves.

SessionSheet.tsx:53:3 [review-effect] Preserve this React synchronization effect and its
dependency timing; replace only its setter calls with one atomic observable assignment.
```

Result: field edits can update leaf subscribers while the original React synchronization timing remains unchanged.

### Teardown ownership

```text
Tooltip.tsx:93:3 [use-unmount] Replace this teardown-only empty-dependency effect with
`useUnmount` if once-only Legend lifecycle semantics are intended.
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
