# Legend Doctor

Legend Doctor is a read-only analyzer for coding agents. It finds proven ways to remove owner
renders, post-commit updates, broad subscriptions, duplicate state, and fragmented observable writes.

The agent reads the evidence, makes one semantic change, runs the application's checks, and scans again. Findings that
lack timing or ownership proof stay as candidates.

## Agent prompt

```text
Run Legend Doctor on <absolute root> before editing. Apply proven change findings one semantic group at a time.
Preserve state lifetime, mount identity, effect timing, cleanup, dependencies, write order, keys, and atomic writes.
Inspect candidates and leave code unchanged unless source proves the missing fact. Run the app's formatter, typecheck,
and relevant tests, scan the same root again, and report the exact finding delta.
```

## Run it

```bash
npm install
npm run build
node dist/src/cli.js /absolute/path/to/app-or-feature --json --actionable
```

Scan the smallest complete root that contains the relevant components, hooks, imports, re-exports, and observables.
Legend Doctor resolves TypeScript configuration, component props, callback flow, barrels, and observable provenance across
files. A single-file scan can hide the proof needed for a safe result.

```bash
# Proven edits only
node dist/src/cli.js /absolute/path/to/root --json --disposition change

# Opportunities that need agent review
node dist/src/cli.js /absolute/path/to/root --json --disposition candidate

# Compact edit queue
node dist/src/cli.js /absolute/path/to/root --actionable

# Parsed files, functions, and skipped analysis stages
node dist/src/cli.js /absolute/path/to/root --json --coverage
```

`--actionable` includes `change` and `candidate` findings. It hides intentional `keep` findings.

## Agent loop

1. Scan before editing.
2. Apply one group of `change` findings.
3. Read every `candidate`. Edit only when the named source proves the missing fact.
4. Preserve lifecycle, mount identity, state ownership, command timing, keys, and atomic transitions.
5. Run the application's formatter, typecheck, and relevant tests.
6. Scan the same root again.
7. Report each added, removed, or changed finding, including a zero delta.
8. Stop when checks pass and every remaining finding is intentional.

Applied changes can expose a smaller subscription boundary, so the second scan is part of the edit, not optional cleanup.

## Output

Text output is a short edit queue:

```text
DocumentCopy.tsx:26:33 [use-observable] Replace controlled state `publish` with an owner-scoped observable and wrap `Switch` in a stable leaf subscriber; keep its value callback API unchanged and use non-tracking reads in submit or commit commands, snapshotting once at command entry before deferred work.
DocumentCopy.tsx:27:33 [review-state] Review `copying`; its async pending interval and leaf boundary are proven, but source does not prove that every command runs from a deferred event. Do not publish these writes through an observable until the callback contract resolves.
DocumentCopy.tsx:29:38 [review-state] Legend-first restructuring candidate: replace `selectedPath` with observable ownership and move its subscription into the smallest rendered subtree; updates currently invalidate this owner with 12 JSX elements.
Scanned 1 files: 4 useState, 0 useEffect, 4 shown.
Re-run legend-doctor after applying change findings; applied changes can reveal new ones.
```

JSON is the agent interface. Each finding names the edit, proof, location, and required ownership boundary:

```json
{
  "action": "use-observable",
  "confidence": "probable",
  "disposition": "change",
  "evidence": [
    "owner: DocumentCopy, lines 22-118, JSX elements 12",
    "reads: render 0, effects 0, deferred 1, transported 2",
    "writes: setter calls 0, effect writes 0",
    "transport targets: Switch"
  ],
  "hook": "useState",
  "location": { "file": "DocumentCopy.tsx", "line": 26, "column": 33 },
  "message": "Replace controlled state `publish` with an owner-scoped observable...",
  "name": "publish",
  "stateModel": {
    "ownership": "local-observable",
    "subscription": "leaf-use-value"
  }
}
```

| Disposition | Agent action |
| --- | --- |
| `change` | Apply the instruction. Structural proof is complete. |
| `candidate` | Inspect the named source. Resolve the missing timing, ownership, or type fact. |
| `keep` | Preserve the current React or lifecycle boundary. |
| `style` | Apply only when the installed Legend API supports the equivalent form. |

## Detected value

| Finding | Proven cost removed |
| --- | --- |
| `delete-unused-state` | Unused state cell and its updates |
| `delete-derived-state` | Post-commit synchronization and second render |
| `delete-effect` | Empty lifecycle left by deleted derived state |
| `move-state-down` | Parent render caused by one child's local edit |
| `use-observable` | Broad owner render while preserving owner lifetime |
| `use-ref` | Render caused by a value used only in commands or cleanup |
| `use-value` | Duplicate React ownership of a Legend value |
| `move-to-event` | Effect-driven second transition after an event |
| `use-observe-effect` | Component subscription used only by an external side effect |
| `use-mount`, `use-unmount` | Equivalent setup or teardown expressed with Legend lifecycle APIs |
| `narrow-use-value-subscription` | Updates to unread sibling observable fields |
| `split-use-value-leaves` | One broad subscription invalidating independent leaves |
| `move-use-value-down` | Observable updates rendering a broad parent |
| `move-use-value-into-child` | A parent render used only to transport one observable value |
| `pass-observable-to-use-value` | Redundant selector execution |
| `replace-legacy-use-value` | Legacy `useSelector` or `use$` call |
| `use-peek-for-snapshot` | Tracking read in a proven non-tracking command |
| `narrow-observable-write` | Parent clone and broad observable publication |
| `toggle-observable` | Boolean updater ceremony |
| `assign-observable-fields` | Several publications to sibling fields |
| `batch-observable-writes` | Several publications across related observable roots |
| `review-state`, `review-effect` | Unsafe guesses, surfaced with the exact missing proof |

## React state examples

### Delete unused state

```tsx
// before
const [, setTick] = useState(0);
const refresh = () => setTick(loadVersion());

// after, preserve argument evaluation
const refresh = () => { loadVersion(); };
```

```tsx
// before, the value can never differ from null
const [invalid, setInvalid] = useState<string | null>(null);
const choiceValue = choices[index].label;
if (invalid === choiceValue) setInvalid(null);

// after, keep the existing choice evaluation and delete the dead guard
const choiceValue = choices[index].label;
```

Invariant-state deletion requires one primitive initializer, only identical literal writes, and reads confined to inert
equality guards whose sole branch is that idempotent setter. Different writes, extra branch work, published reads, effects,
and setter escape remain candidates.

### Calculate during render

```tsx
// before, commits once with stale data and again from the effect
const [total, setTotal] = useState(0);
useEffect(() => setTotal(price * quantity), [price, quantity]);

// after
const total = price * quantity;
```

### Move state into its only child

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

### Split a typed object draft by property

```tsx
// before: editing one field rerenders the dialog shell, list, warning, and every field
interface Fields { name: string; scientificName: string; }
const EMPTY_FIELDS: Fields = { name: "", scientificName: "" };
const [fields, setFields] = useState(EMPTY_FIELDS);
const valid = fields.name.trim() && fields.scientificName.trim();
const submit = () => save(fields);
return <Dialog>
  <SourceList />
  <Field value={fields.name} onChange={value => setFields(old => ({ ...old, name: value }))} />
  <Field value={fields.scientificName} onChange={value => setFields(old => ({ ...old, scientificName: value }))} />
  <Warning />
  <button disabled={!valid} onClick={submit}>Save</button>
</Dialog>;

// after: each edit publishes one child and rerenders only its field plus validation
const fields$ = useObservable({ ...EMPTY_FIELDS });
const submit = () => save({ ...fields$.peek() });
return <Dialog>
  <SourceList />
  <FieldState value$={fields$.name} onChange={value => fields$.name.set(value)} />
  <FieldState value$={fields$.scientificName} onChange={value => fields$.scientificName.set(value)} />
  <Warning />
  <SubmitState fields$={fields$} onSubmit={submit} />
</Dialog>;

function FieldState({ value$, onChange }: { value$: Observable<string>; onChange: (value: string) => void }) {
  return <Field value={useValue(value$)} onChange={onChange} />;
}
function SubmitState({ fields$, onSubmit }: { fields$: Observable<Fields>; onSubmit: () => void }) {
  const disabled = useValue(() => !fields$.name.get().trim() || !fields$.scientificName.get().trim());
  return <button disabled={disabled} onClick={onSubmit}>Save</button>;
}
```

Agent output:

```text
use-observable — Replace object draft `fields` with one owner-scoped observable; clone its initial object once, write each controlled property directly, subscribe at each existing property leaf and pure aggregate leaf, and clone one non-tracking whole-draft snapshot at the start of submit or commit commands.
```

Legend Doctor requires a local string-only interface, a matching constant initializer, one setter-only controlled command
per property, source-proven callback timing, pure bounded validation projections, and independent owner content. Effects,
setter transport, mount gates, resets, multi-property writes, companion React writes, and unresolved controls stay under
review.

### Keep immediate input renders out of repeated results

```tsx
// before: every keystroke also rebuilds every result row
const [draft, setDraft] = useState("");
const [query, setQuery] = useState("");
const onChange = (value: string) => {
  setDraft(value);
  scheduleSearch(value, setQuery);
};
return <>
  <Input value={draft} onChange={onChange} />
  {items.map(item => <Row key={item.id} item={item} />)}
</>;

// after: the existing delayed query update still renders results; draft edits render only InputState
const draft$ = useObservable("");
const onChange = (value: string) => {
  draft$.set(value);
  scheduleSearch(value, setQuery);
};
return <>
  <InputState value$={draft$} onChange={onChange} />
  {items.map(item => <Row key={item.id} item={item} />)}
</>;

function InputState({ value$, onChange }: { value$: Observable<string>; onChange: (value: string) => void }) {
  return <Input value={useValue(value$)} onChange={onChange} />;
}
```

This finding preserves the delayed command and requires the repeated JSX to sit outside the proposed subscriber.
Synchronous companion writes, reads of the immediate state in delayed work, repeated producers, and repeated work inside
the input subtree remain candidates.

### Move search into its repeated producer

```tsx
// before: typing rebuilds every owner-side collection projection
const [query, setQuery] = useState("");
const matches = users.filter(user => user.name?.toLowerCase().includes(query));
const current = users.find(user => user.current);
const others = users.filter(user => !user.current);
const shown = current ? [...others.slice(0, 8), current] : others.slice(0, 8);
const avatars = shown.map(user => {
  if (!user.current) return <Avatar key={user.id} user={user} />;
  return <Avatar key={user.id}><Island>
    <QuickSearch onChange={setQuery} />
    {matches.map(match => <User key={match.id} user={match} />)}
  </Island></Avatar>;
});
return mobile ? <MobileUsers users={users} /> : <Desktop><Toolbar />{avatars}</Desktop>;

// after: the filter still runs once, inside the producer subscriber
const query$ = useObservable("");
return mobile
  ? <MobileUsers users={users} />
  : <Desktop><Toolbar /><AvatarListState query$={query$} shown={shown} users={users} /></Desktop>;

function AvatarListState({ users, shown, query$ }: Props) {
  const query = useValue(query$);
  const matches = users.filter(user => user.name?.toLowerCase().includes(query));
  return <>{shown.map(user => {
    if (!user.current) return <Avatar key={user.id} user={user} />;
    return <Avatar key={user.id}><Island>
      <QuickSearch onChange={value => query$.set(value)} />
      {matches.map(match => <User key={match.id} user={match} />)}
    </Island></Avatar>;
  })}</>;
}
```

Legend Doctor resolves `QuickSearch` to a deferred input callback and requires the exact filter and its repeated producer
to move together from one directly returned JSX slot. The filter still executes once. Query edits skip at least two
unconditional owner-side collection passes, and at least five JSX elements remain outside the subscriber. Opaque
predicates, mutated sources, inline, prop-only, or escaped producers, eager adapters, or another query consumer stay
under review.

### Keep ownership above a dialog and subscribe in the leaf

```tsx
// before, selecting an account rerenders Accounts
const [target, setTarget] = useState<Account | null>(null);
return <><Accounts onDelete={setTarget} /><DeleteDialog account={target} /></>;

// after
const target$ = useObservable<Account | null>(null);
return <><Accounts onDelete={value => target$.set(value)} /><DeleteDialogState target$={target$} /></>;

function DeleteDialogState({ target$ }: { target$: Observable<Account | null> }) {
  return <DeleteDialog account={useValue(target$)} />;
}
```

### Preserve a lazy dialog after its first open

```tsx
// before: opening or closing also rerenders the page chrome and list
const [target, setTarget] = useState<Item | null>(null);
const [open, setOpen] = useState(false);
const [ready, setReady] = useState(false);
const show = (item: Item) => { setTarget(item); setReady(true); setOpen(true); };
return <><PageChrome />{ready && <LazyDialog item={target} open={open} />}</>;

// after: one atomic model keeps the first-open latch and dialog transitions together
const dialog$ = useObservable({ target: null as Item | null, open: false, ready: false });
const show = (item: Item) => dialog$.assign({ target: item, open: true, ready: true });
return <><PageChrome /><LazyDialogState dialog$={dialog$} /></>;

function LazyDialogState({ dialog$ }: { dialog$: Observable<{ target: Item | null; open: boolean; ready: boolean }> }) {
  const dialog = useValue(dialog$);
  const close = () => dialog$.assign({ target: null, open: false });
  return dialog.ready ? <LazyDialog item={dialog.target} open={dialog.open} onClose={close} /> : null;
}
```

The latch must be monotonic, open atomically with the payload, and gate the same bounded lazy-dialog subtree. A latch
reset, a second gated surface, unresolved lazy provenance, or state outside that subtree keeps the group under review.

### Preserve a conditional child's mount identity

```tsx
// before
const [open, setOpen] = useState(false);
return <><Canvas /><button onClick={() => setOpen(true)}>Open</button>{open && <Panel />}</>;

// after, PanelGate stays mounted while Panel keeps its conditional mount
const open$ = useObservable(false);
return <><Canvas /><button onClick={() => open$.set(true)}>Open</button><PanelGate open$={open$} /></>;

function PanelGate({ open$ }: { open$: Observable<boolean> }) {
  return useValue(open$) ? <Panel /> : null;
}
```

A gate may call an immutable local JSX factory. Legend Doctor resolves it only when the factory takes no arguments and
has one direct JSX return. Mutable bindings, wrapper factories, parameters, and multiple returns stay under review.

### Isolate event-computed overlay state

```tsx
// before, every scroll renders the page owner
const [scrolled, setScrolled] = useState(false);
const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
  const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
  setScrolled(scrollTop + clientHeight >= scrollHeight);
};
return <section>
  <div onScroll={onScroll}><Content /></div>
  {!scrolled && <Fade />}
  {!scrolled && <ScrollHint />}
  <Dashboard />
</section>;

// after, one stable leaf subscribes for both overlays
const scrolled$ = useObservable(false);
const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
  const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
  scrolled$.set(scrollTop + clientHeight >= scrollHeight);
};
return <section>
  <div onScroll={onScroll}><Content /></div>
  <ScrollPresentation scrolled$={scrolled$} />
  <Dashboard />
</section>;

function ScrollPresentation({ scrolled$ }: { scrolled$: Observable<boolean> }) {
  const scrolled = useValue(scrolled$);
  return <>{!scrolled && <Fade />}{!scrolled && <ScrollHint />}</>;
}
```

This proof requires one call-free boolean expression and adjacent bounded gates. The write may come from an intrinsic
event or directly from a React effect; an effect migration changes only the storage write and leaves the effect,
dependencies, cleanup, measurement, and statement position intact. Opaque calls, custom component callbacks, mixed
event/effect ownership, companion React writes, repeated output, and separated surfaces stay under review.

### Isolate a source-resolved layout measurement

```tsx
// before, each native layout event renders the full sidebar
const [outerWidth, setOuterWidth] = useState(0);
const width = Math.max(outerWidth - inset, 0);
const onLayout = useCallback(layout => setOuterWidth(layout.width), [setOuterWidth]);
return <NativeSidebar onLayout={onLayout}>
  <Search width={width + 8} />
  <Header style={{ width }} />
  <PlaylistRows />
</NativeSidebar>;

// after, the owner keeps lifetime while only the two width leaves subscribe
const outerWidth$ = useObservable(0);
const onLayout = useCallback(layout => outerWidth$.set(layout.width), [outerWidth$]);
return <NativeSidebar onLayout={onLayout}>
  <SearchWidth outerWidth$={outerWidth$} inset={inset} />
  <HeaderWidth outerWidth$={outerWidth$} inset={inset} />
  <PlaylistRows />
</NativeSidebar>;

function SearchWidth({ outerWidth$, inset }: Props) {
  return <Search width={Math.max(useValue(outerWidth$) - inset, 0) + 8} />;
}
function HeaderWidth({ outerWidth$, inset }: Props) {
  return <Header style={{ width: Math.max(useValue(outerWidth$) - inset, 0) }} />;
}
```

Legend Doctor follows the callback through imported components and optional event wrappers. React Native hosts created
by a source-exported `requireNativeComponent` count only when the factory import and immutable binding are proven. The
numeric write must be event-only and isolated; repeated consumers, calls in projections, companion React writes, eager
invocation, effects, and broad leaves remain candidates.

### Update one host prop without rerendering its owner

```tsx
// before: every layout event rebuilds the complete certificate
const [scale, setScale] = useState(1);
const onLayout = (event: LayoutChangeEvent) => {
  setScale(event.nativeEvent.layout.width / DESIGN_WIDTH);
};
return <View onLayout={onLayout}>
  <Image source={template} />
  <View style={[styles.scaler, { transform: [{ scale }] }]}>
    <CertificateContent />
  </View>
</View>;

// after: the native style prop owns the only subscription
const scale$ = useObservable(1);
const onLayout = (event: LayoutChangeEvent) => {
  scale$.set(event.nativeEvent.layout.width / DESIGN_WIDTH);
};
return <View onLayout={onLayout}>
  <Image source={template} />
  <$View $style={() => [styles.scaler, { transform: [{ scale: scale$.get() }] }]}>
    <CertificateContent />
  </$View>
</View>;
```

Agent output:

```text
use-observable — Replace event-owned scalar state `scale` with one component-lifetime observable and make its single host prop reactive; preserve the source-proven event callback, calculation, write position, host children, and mount identity so the host prop updates without rerendering the broad owner.
```

The same proof catches interaction props:

```tsx
// before: focus rerenders the complete row
const [focused, setFocused] = useState(false);
return <View style={styles.container(focused)}>
  <TextInput onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
  <RowContent />
</View>;

// after: only the root host style reacts
const focused$ = useObservable(false);
return <$View $style={() => styles.container(focused$.get())}>
  <TextInput onFocus={() => focused$.set(true)} onBlur={() => focused$.set(false)} />
  <RowContent />
</$View>;
```

This requires source-proven DOM or React Native events, one pure prop on one non-repeated host, and at least twelve JSX
elements in the owner. Boolean state must start as `false` and use only literal writes. Effects, custom component props,
impure projections, repeated surfaces, command reads, functional updaters, and companion React writes stay under review.

### Isolate a controlled value and its validation

```tsx
// before, each key renders the form owner
const [name, setName] = useState("");
return <><FormHelp /><NameInput value={name} onChange={setName} /><Save disabled={!name.trim()} /></>;

// after, the input and validation subscribe independently
const name$ = useObservable("");
return <><FormHelp /><NameState name$={name$} /><SaveState name$={name$} /></>;
```

### Derive controlled props inside one leaf

```tsx
// before, opening the dialog renders the page owner
const [open, setOpen] = useState(false);
return <><Dashboard /><DetailDialog id={open ? id : null} open={open} onOpenChange={setOpen} /></>;

// after, one subscriber derives every state-dependent dialog prop
const open$ = useObservable(false);
return <><Dashboard /><DetailDialogState id={id} open$={open$} /></>;

function DetailDialogState({ id, open$ }: Props) {
  const open = useValue(open$);
  return <DetailDialog id={open ? id : null} open={open} onOpenChange={value => open$.set(value)} />;
}
```

Opaque calls, repeated children, sibling consumers, and effect reads remain candidates.

### Isolate a compact transported boolean

```tsx
// before, opening the native menu also renders the toolbar and press target
const [expanded, setExpanded] = useState(false);
const open = () => setExpanded(true);
const dismiss = () => setExpanded(false);
return <><Toolbar /><PressTarget onPress={open} /><NativeMenu expanded={expanded} onDismiss={dismiss} /></>;

// after, the owner keeps the lifetime and the menu owns the subscription
const expanded$ = useObservable(false);
const open = () => expanded$.set(true);
const dismiss = () => expanded$.set(false);
return <><Toolbar /><PressTarget onPress={open} /><NativeMenuState expanded$={expanded$} onDismiss={dismiss} /></>;

function NativeMenuState({ expanded$, onDismiss }: Props) {
  return <NativeMenu expanded={useValue(expanded$)} onDismiss={onDismiss} />;
}
```

The compact-owner proof requires an independent rendered sibling and terminal local boolean writes. Setter forwarding,
companion state writes, reactive mutations, or work after a setter keep the finding under review.

### Leave an existing leaf alone

```tsx
// already the smallest useful React owner
function Field() {
  const [value, setValue] = useState("");
  return <Input value={value} onChange={setValue} />;
}
```

Legend Doctor reports `keep-state` here. An observable wrapper would rebuild the same child and add machinery without
narrowing the render boundary.

### Isolate an exact array membership control

```tsx
// before, every checkbox renders the settings page
const [selected, setSelected] = useState(initial);
const toggle = (value: string) => setSelected(previous =>
  previous.includes(value) ? previous.filter(item => item !== value) : [...previous, value]
);
const submit = () => save(selected);
return <form onSubmit={handleSubmit(submit)}>
  <SettingsHelp />
  <TriggerCheckboxGroup selected={selected} onSelectionChange={toggle} />
</form>;

// after, keep one owner handle and snapshot once when submitting
const selected$ = useObservable(initial);
const toggle = (value: string) => selected$.set(previous =>
  previous.includes(value) ? previous.filter(item => item !== value) : [...previous, value]
);
const submit = () => save(selected$.peek());
return <form onSubmit={handleSubmit(submit)}>
  <SettingsHelp />
  <TriggerCheckboxGroupState selected$={selected$} onSelectionChange={toggle} />
</form>;

function TriggerCheckboxGroupState({ selected$, onSelectionChange }: Props) {
  return <TriggerCheckboxGroup selected={useValue(selected$)} onSelectionChange={onSelectionChange} />;
}
```

Legend Doctor accepts the exact immutable membership toggle and imported React Hook Form `handleSubmit`. Opaque
reconcilers, extra updater work, unresolved adapters, and coupled state changes remain candidates.

### Isolate one record entry per row

```tsx
// before, one vote renders the entire message rail
const [feedback, setFeedback] = useState<Record<string, Verdict>>({});
const vote = async (message: Message, verdict: Verdict) => {
  setFeedback(previous => ({ ...previous, [message.id]: verdict }));
  try { await submit(message.id, verdict); }
  catch {
    setFeedback(previous => {
      const next = { ...previous };
      delete next[message.id];
      return next;
    });
  }
};
return messages.map(message =>
  <MessageRow key={message.id} active={feedback[message.id]} onVote={value => vote(message, value)} />
);

// after, only the voted row subscribes and the async boundary stays unchanged
const feedback$ = useObservable<Record<string, Verdict>>({});
const vote = async (message: Message, verdict: Verdict) => {
  feedback$[message.id].set(verdict);
  try { await submit(message.id, verdict); }
  catch { feedback$[message.id].delete(); }
};
return messages.map(message =>
  <MessageRowState key={message.id} feedback$={feedback$} message={message} onVote={vote} />
);

function MessageRowState({ feedback$, message, onVote }: Props) {
  return <MessageRow
    active={useValue(feedback$[message.id])}
    onVote={verdict => onVote(message, verdict)}
  />;
}
```

The record key must match the stable row key. Every read and exact clone write must target that same primitive entry.
Whole-record reads, resets, multi-key updates, entry-controlled row mounts, eager callbacks, and unresolved wrappers remain
candidates.

### Keep an inline editor inside its keyed row

```tsx
// before, opening, typing, and closing render the list owner
const [editingId, setEditingId] = useState<string | null>(null);
const [editText, setEditText] = useState("");

// after, paired opens stay atomic and typing reaches only the active row
const editor$ = useObservable({ id: null as string | null, text: "" });
const beginEdit = (row: Row) => editor$.assign({ id: row.id, text: row.name });
const closeEdit = () => editor$.id.set(null);
const saveEdit = () => save(editor$.text.peek());

function EditableRow({ editor$, row }: { editor$: Observable<{ id: string | null; text: string }>; row: Row }) {
  const editing = useValue(() => editor$.id.get() === row.id);
  return editing ? <InlineEditor editor$={editor$} /> : <RowView row={row} />;
}

function InlineEditor({ editor$ }: { editor$: Observable<{ id: string | null; text: string }> }) {
  return <Input value={useValue(editor$.text)} onChange={value => editor$.text.set(value)} />;
}
```

Legend Doctor permits a cursor-only close because the hidden draft already persists in React. Every non-null cursor
change must still assign its matching draft atomically; switching rows with stale text stays under review.

### Isolate a persistent dialog without changing its mount behavior

```tsx
// before, opening and closing render the 50-element page owner
const [target, setTarget] = useState<Action | null>(null);
const [open, setOpen] = useState(false);
const edit = (action: Action) => { setTarget(action); setOpen(true); };
return <><PageContent onEdit={edit} />{target ? <EditDialog target={target} open={open} setOpen={setOpen} /> : null}</>;

// after, the model opens atomically and the dialog still stays mounted while open=false
const dialog$ = useObservable({ target: null as Action | null, open: false });
const edit = (action: Action) => dialog$.assign({ target: action, open: true });
return <><PageContent onEdit={edit} /><EditDialogState dialog$={dialog$} /></>;

function EditDialogState({ dialog$ }: { dialog$: Observable<{ target: Action | null; open: boolean }> }) {
  const target = useValue(dialog$.target);
  const open = useValue(dialog$.open);
  return target
    ? <EditDialog target={target} open={open} setOpen={value => dialog$.open.set(value)} />
    : null;
}
```

Legend Doctor requires one source-resolved dialog target inside one bounded payload gate. The stable wrapper replaces the
complete conditional slot. The same model applies to an always-mounted drawer whose payload starts as
`useState<T | undefined>()`, and to the equivalent `payload && <Dialog />` gate. Payload fanout, opaque initializers,
repeated gates, unresolved targets, and broad branches remain candidates. Dialog chrome may stay inside the leaf when
the complete branch has at most twelve JSX elements and is no more than 40% of its owner.

### Keep a scalar popup payload atomic with visibility

```tsx
// before, selecting a level rerenders the complete card
const [open, setOpen] = useState(false);
const [level, setLevel] = useState(1);
const showLevel = (nextLevel: number) => { setLevel(nextLevel); setOpen(true); };
return <><CardContent onSelect={showLevel} /><LevelPopup open={open} level={level} setOpen={setOpen} /></>;

// after, one leaf receives the same plain props and the paired open stays atomic
const popup$ = useObservable({ open: false, level: 1 });
const showLevel = (nextLevel: number) => popup$.assign({ level: nextLevel, open: true });
return <><CardContent onSelect={showLevel} /><LevelPopupState popup$={popup$} /></>;

function LevelPopupState({ popup$ }: { popup$: Observable<{ open: boolean; level: number }> }) {
  const popup = useValue(popup$);
  return <LevelPopup open={popup.open} level={popup.level} setOpen={value => popup$.open.set(value)} />;
}
```

Legend Doctor requires a literal string or number payload, a false visibility flag, paired event-rooted opens, one
stable source-resolved child, and a deferred close callback. The child still receives plain props, so its effects and
memoization keep their existing timing. Payload reads in the owner, functional updates, repeated or keyed popups,
different child targets, and any unpaired open remain candidates.

A controlled close may reset React draft state without blocking an otherwise independent popup leaf. The tool proves
that exception only for a literal `false` write or an immutable boolean callback parameter whose companion writes are
inside `if (!open)`. A positive guard, reassigned parameter, hidden helper, or payload write during open remains a
candidate.

A single nullable payload can also own an always-mounted dialog's `open` expression. Legend Doctor recommends one
owner-lifetime observable only when every render read stays inside that complete dialog call site, every command is
event-rooted, and no companion React write shares the transition. Event commands take non-tracking snapshots while the
dialog wrapper owns the only `useValue` subscription.

The same proof covers a bounded conditional dialog when call-free child props are derived from the payload inside that
one gate. The stable subscriber replaces the complete conditional slot, so the dialog still mounts only when the
payload exists. Calls, payload reads outside the slot, repeated output, broad branches, unresolved events, and companion
React writes remain candidates.

### Isolate async status

```tsx
// before, pending transitions render the editor
const [copying, setCopying] = useState(false);
const copy = async () => {
  setCopying(true);
  try { await duplicate(); } finally { setCopying(false); }
};
return <><Editor /><Button loading={copying} onClick={copy} /></>;

// after, the command boundary is unchanged
const copying$ = useObservable(false);
const copy = async () => {
  copying$.set(true);
  try { await duplicate(); } finally { copying$.set(false); }
};
return <><Editor /><ButtonState copying$={copying$} onClick={copy} /></>;
```

Pure props, labels, and icons may share one stable status leaf. Every async status change requires source-proven deferred
callback timing, including the one-leaf form. Intrinsic events qualify directly. A custom `onX` prop qualifies only when
multi-file analysis follows every command path to an intrinsic or framework event or another proven deferred
registration. Eager invocation and unresolved wrappers remain candidates. Repeated controls, mount gates, impure
projections, and conditional first awaits also remain candidates.

The same pending interval may feed two or three stable leaves without rendering their owner:

```tsx
// before, both transitions render the settings popover
const [uploading, setUploading] = useState(false);
return <Popover>
  <Settings />
  {hasLogo
    ? <LogoButton disabled={uploading}>Replace</LogoButton>
    : <LogoButton disabled={uploading}>Upload</LogoButton>}
</Popover>;

// after, each existing branch keeps its mount identity and subscribes at the button
const uploading$ = useObservable(false);
return <Popover>
  <Settings />
  {hasLogo
    ? <LogoButtonState uploading$={uploading$}>Replace</LogoButtonState>
    : <LogoButtonState uploading$={uploading$}>Upload</LogoButtonState>}
</Popover>;

function LogoButtonState({ uploading$, children }: Props) {
  return <LogoButton disabled={useValue(uploading$)}>{children}</LogoButton>;
}
```

Multi-leaf advice requires one complete async event interval, two or three non-repeated call sites in one owner return,
and source-proven deferred callback timing. Small cohesive workflows, eager child callbacks, effect-triggered commands,
synchronous companion writes before awaited work, and repeated rows remain candidates.

Deferred callback proof also follows a polymorphic wrapper when an immutable local conditional selects a lowercase
intrinsic tag from one destructured boolean prop and the concrete callsite fixes that prop with a literal or literal
default. Dynamic values, JSX spreads, reassigned props, mutable targets, and selected custom components remain candidates.

### Subscribe once per keyed row

```tsx
// before, selection renders the list owner
const [selectedId, setSelectedId] = useState<string | null>(null);
return rows.map(row => <Row key={row.id} selected={selectedId === row.id} />);

// after
const selectedId$ = useObservable<string | null>(null);
return rows.map(row => <RowState key={row.id} row={row} selectedId$={selectedId$} />);
```

The proof requires an item-derived stable key and per-row membership. Index keys and mount-control reads abstain.

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

### Stop a presentation clock from rendering its owner

```tsx
// before: the interval rebuilds the complete generation screen five times per second
const [elapsed, setElapsed] = useState(0);
useEffect(() => {
  const timer = setInterval(() => setElapsed(Date.now() - startedAt), 200);
  return () => clearInterval(timer);
}, []);
const activeStage = stageFromElapsed(elapsed);
return <><GenerationChrome />
  <ol>{stages.map(stage => <Stage key={stage.id} active={stage.index === activeStage} />)}</ol>
  <Progress value={progressFromElapsed(elapsed)} />
</>;

// after: keep the effect; subscribe once around the keyed list and once around progress
const elapsed$ = useObservable(0);
useEffect(() => {
  const timer = setInterval(() => elapsed$.set(Date.now() - startedAt), 200);
  return () => clearInterval(timer);
}, []);
return <><GenerationChrome /><StagesState elapsed$={elapsed$} /><ProgressState elapsed$={elapsed$} /></>;
```

Agent output:

```text
use-observable — Replace effect-written scalar `elapsed` with an owner-scoped observable; preserve the React effect, cleanup, dependencies, calculations, and write order, then subscribe only in its two bounded presentation leaves.
```

The proof accepts numeric state written only by one React effect, up to three immutable projection hops, structurally
pure local helpers closed over inert module constants, and stable keyed repeated output. Effect reads, functional
updaters, opaque helpers, companion React writes, unstable keys, broad leaves, and owners below twelve JSX elements stay
candidates.

### Move an event-owned reset into the event

```tsx
// before, query commits and the effect commits page
useEffect(() => setPage(1), [query]);
const changeQuery = (next: string) => setQuery(next);

// after, one event owns one transition
const changeQuery = (next: string) => {
  setQuery(next);
  setPage(1);
};
```

Every source mutation must be structurally resolved. Unknown component callbacks stay candidates.

### React to Legend without rendering the component

```tsx
// before
const theme = useValue(settings$.theme);
useEffect(() => syncTheme(theme), [theme]);

// after
useObserveEffect(() => syncTheme(settings$.theme.get()));
```

### Express setup and teardown intent

```tsx
useEffect(() => start(), []);       // before
useMount(() => start());            // after

useEffect(() => () => stop(), []);  // before
useUnmount(() => stop());           // after
```

Strict Mode replay, setup work, and disposer ownership stay candidates unless the lifecycle is equivalent.

### Keep committed-ref work in React

```tsx
useEffect(() => {
  if (!listRef.current) return;
  const items = listRef.current.querySelectorAll("[role=option]");
  items[selectedIndex]?.scrollIntoView({ block: "nearest" });
}, [selectedIndex]);
```

Legend Doctor reports `keep-effect`. The DOM receiver may pass through immutable local aliases, but the command still
depends on React post-commit timing. Alias escape and unrelated nested calls remain candidates.

## Legend subscription examples

### Narrow to the field that renders

```tsx
const profile = useValue(profile$);           // before
const name = profile.contact.name;

const name = useValue(profile$.contact.name); // after
```

### Split unrelated leaves

```tsx
const user = useValue(user$); // before
return <><Name value={user.name} /><Avatar src={user.avatarUrl} /></>;

// after
return <><NameState name$={user$.name} /><AvatarState avatar$={user$.avatarUrl} /></>;
```

### Move a subscription into its only stable consumer

```tsx
const open = useValue(dialog$.open);                     // before
return <><Editor /><Dialog open={open} /></>;

return <><Editor /><DialogState open$={dialog$.open} /></>; // after
```

### Use an existing child as the subscription boundary

```tsx
// before: every toggle reruns WorkspaceProvider and Palette
function WorkspaceProvider() {
  const open = useValue(paletteOpen$);
  useWorkspaceHotkeys();
  return <Palette open={open} />;
}

// after: only Palette subscribes and rerenders
function WorkspaceProvider() {
  useWorkspaceHotkeys();
  return <Palette open$={paletteOpen$} />;
}

function Palette({ open$ }: { open$: Observable<boolean> }) {
  const open = useValue(open$);
  return <Dialog open={open} />;
}
```

This cross-file finding requires one direct primitive prop, one source-resolved plain child, and one stable call site.
Conditional, keyed, repeated, memoized, shared, transformed, object-valued, or unresolved transports are left unchanged.

### Remove selector work and legacy APIs

```tsx
useValue(() => profile$.name.get());                 // before
useValue(profile$.name);                             // after

useValue(profile$.avatar.get(), { suspense: true }); // before
useValue(profile$.avatar, { suspense: true });       // after

useSelector(profile$.name);                          // before
useValue(profile$.name);                             // after
```

### Use a non-tracking command snapshot

```tsx
const save = () => persist(settings$.theme.get());  // before
const save = () => persist(settings$.theme.peek()); // after
```

Render reads, tracking callbacks, listener options, and unresolved callback chains keep `.get()`.

## Legend write examples

### Write the changed path

```tsx
profile$.set({ ...profile$.peek(), name });  // before
profile$.name.set(name);                     // after

rows$.set({ ...rows$.peek(), [id]: row });   // before
rows$[id].set(row);                          // after

items$.set(previous => [...previous, item]); // before
items$.push(item);                           // after
```

### Toggle directly

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

Overlapping paths, awaits, order-sensitive reads, partial write runs, and unresolved value evaluation preserve the
original writes.

## Proof boundary

Legend Doctor emits `change` only when TypeScript structure proves the edit. Component names, paths, application
allowlists, disabled UI, and corpus expectations are not proof.

- Keep cohesive one-control state in React when an observable cannot remove an owner render.
- Keep observable ownership at the lifetime named in `stateModel`.
- Subscribe with `useValue` at the lowest proven stable render leaf.
- Use `.peek()` only in a proven non-tracking path.
- Apply grouped findings as one migration.
- Check the installed `@legendapp/state` version and types before changing APIs.

These rules follow the official
[Legend State best-practices skill](https://github.com/LegendApp/legend-skills/tree/main/legend-state-best-practices).

## Verified accuracy

The pinned corpus covers 2,390 hooks across 235 targets. It contains 854 manually audited hook labels, 26 state groups,
and 109 Legend practice labels. Thirty-two safe async-leaf opportunities remain explicit non-enforced labels because
their complete custom callback chains are not yet source-proven.

| Check | Result |
| --- | ---: |
| Unit tests | 570/570 |
| Actionable precision | 437/437 |
| Actionable recall | 437/469 |
| Legend practice precision | 109/109 |

The corpus keeps known opportunities as non-enforced labels. A detector cannot improve its score by turning uncertain
code into a forced edit.
