# Legend Doctor

Legend Doctor is a read-only static analyzer for coding agents working on React and Legend State. It finds proven render,
subscription, and lifecycle costs, then tells the agent what to change and where the reactive boundary belongs.

## For coding agents only

Legend Doctor is not a human lint dashboard, a codemod, or a runtime profiler. Its output is an instruction for a coding
agent. The agent must inspect the source, apply the recommendation, run the application checks, and run Legend Doctor
again.

The tool answers four questions that ordinary hook linting does not:

- Can this React state or effect disappear without changing behavior?
- If state must remain reactive, which component owns it and which leaf subscribes?
- Can a Legend subscription or write target a narrower observable path?
- Which timing, cleanup, mount identity, or atomic transition requires React to stay in control?

Every hook finding includes an action, confidence, disposition, structural evidence, source location, and state model.
Unproven opportunities stay as reviews. Component names, file paths, and application-specific allowlists are never proof.

## Value delivered

| Proven cost | Agent instruction | Result |
| --- | --- | --- |
| State value is never consumed | Delete the state and setter work | Remove a render source |
| Broad owner rerenders for one leaf | Keep owner-lifetime observable state and subscribe in the leaf | Limit invalidation to the consumer |
| State belongs entirely to one stable child | Move React state into that child | Remove the parent broadcast |
| Command-only state has no render consumer | Replace it with a ref while preserving write timing | Remove the state-driven render |
| Effect only resets state after an event-owned change | Move the reset into each proven mutation | Remove a post-commit render pass |
| Effect is a pure derivation | Calculate during render and delete the effect/state pair | Remove duplicate state and synchronization |
| Broad `useValue(parent$)` read | Subscribe to the lowest common observable path | Ignore unrelated observable changes |
| Multiple related Legend writes | Use `.assign()` or `batch()` | Publish one atomic transition |
| Command uses tracking `.get()` | Use `.peek()` | Avoid creating a reactive dependency |
| React owns lifecycle semantics | Keep the effect or state | Preserve commit timing, cleanup, and Strict Mode behavior |

Measured on the pinned corpus:

| Metric | Result |
| --- | ---: |
| Application roots | 12 |
| Source targets | 225 |
| Hooks analyzed | 2,356 |
| Manually audited hook labels | 796 |
| Known non-enforced opportunities | 1 |
| State groups | 18/18 |
| Unit tests | 524/524 |
| Actionable precision | 100% (426/426) |
| Actionable recall | 99.8% (426/427) |
| Legend practice precision | 100% (100/100) |

These numbers measure analyzer decisions, not runtime speed. The corpus covers Tree Map, Tree Wallet, Memoria, Legend
Music, Excalidraw, Expensify, Formbricks, Outline, Genie Courses, Open WebUI React Native, and Hoalu.

## Agent runbook

### 1. Build the analyzer

```bash
npm install
npm run build
```

Completion criterion: `dist/src/cli.js` exists and the build exits successfully.

### 2. Scan before editing

Run Legend Doctor before every `useState`, `useEffect`, or Legend State optimization:

```bash
node dist/src/cli.js /absolute/path/to/app-or-feature --actionable
```

Use the smallest root that still contains the imported project components and hooks needed for cross-file proof. A single
file is enough for local rules. Use the application or feature root when callback timing, child ownership, barrels, or
observable provenance crosses files.

Completion criterion: the scan inventories the expected files and hooks. If coverage is uncertain, inspect it directly:

```bash
node dist/src/cli.js /absolute/path/to/root --json --coverage
```

### 3. Separate proven changes from audits

Apply proven changes first:

```bash
node dist/src/cli.js /absolute/path/to/root --json --disposition change
```

Then inspect candidates:

```bash
node dist/src/cli.js /absolute/path/to/root --json --disposition candidate
```

| Disposition | Required agent behavior |
| --- | --- |
| `change` | Apply the instruction. The structural proof is complete. |
| `candidate` | Verify the named ownership, lifecycle, or subscription boundary before editing. |
| `keep` | Preserve React ownership or lifecycle. |
| `style` | Apply when repository conventions want the equivalent Legend API form. |

`--actionable` hides `keep` findings and collapses grouped state migrations to one primary instruction. Omit it when
auditing every inventoried hook.

### 4. Apply the boundary in the finding

Treat a finding as a semantic instruction, not a text replacement.

- Delete proven dead state before introducing another reactive container.
- Keep observable ownership at the component lifetime named by the finding.
- Put `useValue` in the lowest proven leaf. Keep commands non-tracking with `.peek()`.
- Apply every grouped state finding as one transaction. Preserve co-written fields with `.assign()` or `batch()`.
- Preserve effect phase, dependency timing, cleanup ownership, mount identity, and command statement order.
- Keep reviews as reviews when source proof is incomplete. Do not infer safety from a familiar component name.

The `stateModel` field makes the boundary explicit:

| Field | Meaning |
| --- | --- |
| `ownership: delete` | Remove the state model. |
| `ownership: react` | React remains the owner. |
| `ownership: ref` | Keep owner lifetime without render notification. |
| `ownership: local-observable` | Create one observable at the current React owner. |
| `ownership: existing-observable` | Use the already proven Legend observable. |
| `ownership: review` | Ownership cannot move until the agent proves the missing boundary. |
| `subscription: none` | No rendered subscriber is required. |
| `subscription: leaf-react` | Move React state into the stable child leaf. |
| `subscription: leaf-use-value` | Subscribe in a nested leaf, not the owner. |
| `subscription: owner-react` | The current React owner remains the cohesive subscriber. |
| `subscription: owner-use-value` | The current owner must keep its Legend subscription. |
| `subscription: review` | The lowest safe subscriber is unresolved. |

### 5. Validate and rescan

Run the affected application's typecheck and tests. Then run the same Legend Doctor command again.

Completion criterion: every edited finding is accounted for, grouped transitions remain atomic, application checks pass,
and the post-edit scan introduces no unsafe or unexplained change finding. Applied changes can expose a second safe
optimization, so continue until the changed area is stable.

## What the tool prints

Text output is compact enough for an agent loop:

```text
merge-tags-combobox.tsx:28:27 [review-state] Review React state `open`; local evidence does not prove a render-boundary improvement.
merge-tags-combobox.tsx:29:29 [delete-unused-state] Delete React state `value` and its setter calls; assigned values are never consumed.
Scanned 1 files: 2 useState, 0 useEffect, 2 shown.
Re-run legend-doctor after applying change findings; applied changes can reveal new ones.
```

Use JSON when the agent needs evidence or an exact ownership model:

```json
{
  "files": 1,
  "findings": [
    {
      "action": "delete-unused-state",
      "confidence": "certain",
      "disposition": "change",
      "evidence": [
        "owner: MergeTagsCombobox, lines 26-73, JSX elements 13",
        "reads: render 0, effects 0, deferred 1, transported 0",
        "writes: setter calls 1, effect writes 0",
        "transport targets: none"
      ],
      "hook": "useState",
      "location": {
        "column": 29,
        "file": "merge-tags-combobox.tsx",
        "line": 29
      },
      "message": "Delete React state `value` and its setter calls; assigned values are never consumed.",
      "name": "value",
      "stateModel": {
        "ownership": "delete",
        "subscription": "none"
      }
    }
  ],
  "hooks": {
    "effects": 0,
    "states": 2,
    "total": 2
  },
  "practices": []
}
```

The evidence reports the facts used by the detector. It does not replace source inspection. `confidence: certain` means
the transformation preserves the modeled semantics. `confidence: probable` marks a structurally bounded choice whose
final policy, such as once-only mount behavior, still belongs to the agent.

## Representative agent changes

### Delete a render source instead of migrating it

Before:

```tsx
const [value, setValue] = useState("");

function select(next: string) {
  setValue(next === value ? "" : next);
  close();
  onSelect(next);
}
```

Output:

```text
[delete-unused-state] Delete React state `value` and its setter calls; assigned values are never consumed.
```

After:

```tsx
function select(next: string) {
  close();
  onSelect(next);
}
```

The detector emits this only when the initializer and setter argument are evaluation-safe and the value never renders,
escapes, reaches an effect, or affects another command.

### Keep ownership, move only the subscription

Before:

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
[use-observable] Keep `deleteTarget` in a component-lifetime observable and subscribe at the single dialog call site.
```

After:

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

function DeleteDialogState({ deleteTarget$ }: { deleteTarget$: Observable<Account | null> }) {
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

The observable stays at the original owner, so conditional branches do not reset it. Only the dialog leaf subscribes.

### Preserve effect timing and publish one transition

Before:

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
[use-observable] Replace (`name`, `color`, `anchor`) with one observable draft. Preserve the React effect and assign the draft atomically.
```

After:

```tsx
const draft$ = useObservable({ name: "", color: "", anchor: null as string | null });

useEffect(() => {
  draft$.assign({
    name: session.name,
    color: session.color,
    anchor: session.anchor,
  });
}, [session]);
```

The React effect still owns synchronization timing. Leaf controls subscribe to `draft$.name`, `draft$.color`, or
`draft$.anchor` instead of subscribing the owner to the whole draft.

### Narrow an existing Legend subscription

Before:

```tsx
const profile = useValue(profile$);
return <Name>{profile.name}</Name>;
```

Output:

```text
[narrow-use-value-subscription] Narrow `profile` from `useValue(profile$)` to `useValue(profile$.name)`.
```

After:

```tsx
const name = useValue(profile$.name);
return <Name>{name}</Name>;
```

Only changes to `profile$.name` now invalidate the component.

### Keep deliberate React lifecycle ownership

If project policy requires post-commit timing, place the directive immediately above the effect:

```tsx
// legend-doctor keep-react-effect: the SDK requires post-commit timing.
useEffect(() => syncSdk(identity), [identity]);
```

Legend Doctor keeps the hook in its inventory and emits `keep-effect`. The same conservative rule protects committed ref
mirrors, cleanup ownership, Strict Mode replay, external subscriptions, and unresolved callback timing.

## Action reference

| Action family | Agent interpretation |
| --- | --- |
| `delete-unused-state`, `delete-derived-state`, `delete-effect` | Remove proven redundant React work. |
| `move-state-down` | Put React state in the stable child that owns every read and write. |
| `use-ref` | Keep the value at owner lifetime without render notification. |
| `use-observable`, `use-value`, `use-observe-effect` | Use Legend ownership or reactivity at the boundary named in the message. |
| `move-to-event` | Move a synchronization reset into every proven causal mutation. |
| `use-mount`, `use-unmount` | Candidate once-only lifecycle semantics. Verify Strict Mode policy first. |
| `keep-state`, `keep-effect` | Preserve React semantics. |
| `review-state`, `review-effect` | Source proof is incomplete. Audit before changing ownership. |
| `narrow-use-value-subscription`, `split-use-value-leaves`, `move-use-value-down` | Subscribe at a lower observable or component leaf. |
| `pass-observable-to-use-value`, `replace-legacy-use-value` | Use the current Legend React API without changing computed selectors. |
| `narrow-observable-write`, `toggle-observable`, `assign-observable-fields`, `batch-observable-writes` | Mutate the smallest proven path and preserve one publication. |
| `use-peek-for-snapshot` | Read a command snapshot without tracking. |

## Safety model

Legend Doctor is Legend-first, not conversion-first. A recommendation is actionable only when it removes a proven render,
lifecycle pass, subscription, or publication while preserving these invariants:

- React effect phase, dependency timing, cleanup ownership, and Strict Mode behavior
- component ownership lifetime and mount identity
- render snapshots across synchronous and deferred commands
- atomic state-machine transitions and write order
- list keys, cardinality, and per-row subscription identity
- the lowest proven leaf subscription boundary

Unknown callback execution, unresolved ownership, dynamic observable paths, callable state, effect escapes, partial state
clusters, and unstable repeated children remain explicit reviews.

## Developing Legend Doctor

Agents changing the detector must follow [AGENTS.md](AGENTS.md). Read [evals/README.md](evals/README.md) before changing
labels or scoring. [NEXT_PHASE.md](NEXT_PHASE.md) records the current proof, exact application deltas, and remaining
opportunities.

The required local checks are:

```bash
npm run typecheck
npm test
```

Run Legend Doctor before and after detector work. Add the minimal adversarial fixture and manually audited pinned label
before implementation, then run the complete pinned corpus. Report action deltas for every application, including zero.

Legend Doctor recommends changes. It never edits the analyzed application.
