# Unoptimized Legend State apps: discovery, scan, and audit

Date: 2026-09-28. Analyzer: `origin/main` at `28772c7`, built with `tsc -p tsconfig.json --outDir .cand-dist` and run as
`node --max-old-space-size=16384 .cand-dist/src/cli.js <root> --coverage`. Every app was cloned with `--depth=1`. No
dependencies were installed and no app code was run, so the Legend State version comes from each lockfile
(`capabilities.legendState.source: lockfile`).

The pinned Legend apps are at their recall ceiling, so this search looked for public apps written by people other than
Legend State's author, where ordinary mistakes survive. It found eleven. Their 301 `change` findings were audited by
hand against source:

- **212 correct, 88 false positives, 1 uncertain**, for 70% precision.
- 32 of the false positives come from one capability bug: React 18 `createRoot` apps are treated as legacy roots.
  Without that bug, precision is 79%.

## False positives first

Each class lists its count, the apps it appeared in, representative locations, and a minimal reproduction. Paths are
relative to the repository root.

### FP1. React 18 `createRoot` treated as a legacy root (32: gptme 25, zinnia 7)

The tool marks `batch-observable-writes` and `assign-observable-fields` as `change` because
`capabilities.concurrentRoot` is false. `src/project/concurrent-root-workspace.ts` decides that from the declared
`react-dom` range alone (it requires `>= 19`). Both apps declare `react-dom ^18.3.1`, but every root they create uses
`createRoot`:

- gptme: `webui/src/main.tsx:49`, `webui/src/panel.tsx:19`, `webui/src/utils/markdownRenderer.ts:190`
- zinnia: `apps/zinnia-core/src/main.tsx:15`, `:23`

Those roots already coalesce the writes into one render. 17 of the 32 sites also sit inside React event handlers,
which batch on any root. Representative sites:

- gptme `webui/src/components/ChatMessage.tsx:237`: writes to `renderer$` and `parser$`, which have no render
  subscribers, so batching removes nothing on any root.
- gptme `webui/src/hooks/useProviderHealth.ts:43`: after an `await`, so this is the only kind of site where the
  premise would hold on a real legacy root.
- zinnia `components/HeroPanel/StartStateContent.tsx:95`: react-query `onSuccess`.

Verified with a two-file fixture: `react-dom ^18.3.1`, `createRoot(el).render(<App/>)`, and a module function doing
`title$.set(a); count$.set(b)`. The scan reports `concurrentRoot: false` and `batch-observable-writes change`.

```tsx
// main.tsx (react-dom 18)
createRoot(document.getElementById("root")!).render(<App />);
// App.tsx
export function load(next: { title: string; count: number }) {
  title$.set(next.title); // tool: two renders, wrap in batch
  count$.set(next.count); // actual: one render on a createRoot root
}
```

### FP2. The leaf is the owner: no material render cut (22)

Found in `use-observable` and `move-state-down`:

| App       | Count | Locations                                                                                                                                                                    |
| --------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| junto     |     7 | `src/renderer/components/InspectorFields.tsx:298`, `gallery/ActivityMarkGallery.tsx:372`, `:373`, `rts/KindSurface.tsx:241`, `:242`, `rules/ChecksEditor.tsx:83`, `:84`      |
| gptme     |     6 | `webui/src/components/DeleteConversationConfirmationDialog.tsx:35`, `:36`, `:37`, `ExamplesSection.tsx:50`, `TabbedCodeBlock.tsx:28`, `workspace/MarkdownPreviewTabs.tsx:15` |
| zenborg   |     4 | `src/components/AreaColumnSubtoolbar.tsx:27`, `HabitFormDialog.tsx:744`, `PlaceFormDialog.tsx:622`, `:474`                                                                   |
| reptikeep |     3 | `src/app/(index,reminders,settings,search)/backup-restore.android.tsx:72`, `:74`, `:79`                                                                                      |
| meron     |     1 | `desktop/frontend/src/components/chat/ConversationDetailsPanel.tsx:89`                                                                                                       |
| Nora      |     1 | `components/modal/ToolsModal.tsx:57`                                                                                                                                         |

The owner passes the JSX-element threshold, but almost every element either reads the state or is a static host
element. What stays in the owner after the cut is a wrapper div or a dialog shell. On reptikeep's
`backup-restore.android.tsx` the extracted `<Column>` is the whole screen.

```tsx
function PageUrlControl({ url }: { url: string }) {
  const [draft, setDraft] = useState(url);
  return (
    <div>
      <label>
        <span>url</span>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      </label>
    </div>
  );
} // the leaf is the <input>; the removed owner render is three host elements
```

### FP3. The owner renders anyway on the same update (7)

The cut removes no render, because something else in the same update re-renders the owner.

- **Owner callback fires in the same handler.** habitquest `src/features/habits/components/content-picker.tsx:209`,
  `:223`, `:226` call a prop `onChange` on every keystroke, and the parent re-renders the owner. This still fires in
  the repo-root scan, where the parents `app/habit/create.tsx` and `app/habit/edit/[id].tsx` are in scope.
- **Co-written with owner state.** reptikeep `src/components/reptile-form-sheet.android.tsx:130` (`setNameDirty` next
  to the form's own `setName`).
- **The parent writes on every move.** zenborg `src/components/CircularPhaseSlider.tsx:68` gets a parent observable
  write on every pointermove. Its value-keyed rows also remount under the prescribed row.
- **A parent subscribes through a custom hook.** junto `src/renderer/components/rts/CompletedTaskNotify.tsx:28`
  (`use-observe-effect`): the parent subscribes through `useRegionRollups` (`src/renderer/lib/region-rollups.ts:121`).
- **The subscribed siblings are written in the same synchronous stretch.** meron
  `desktop/frontend/src/components/kanban/KanbanBoardColumn.tsx:98` (`peek-unrendered-use-value`): every
  `accountCursors` writer also writes `threads` and `cursors`, which the component subscribes to. The edit is safe dead
  code removal and should be `style`.

```tsx
function Picker({ onChange }: { onChange: (v: Content) => void }) {
  const [label, setLabel] = useState("");
  return (
    <TextInput
      value={label}
      onChangeText={(t) => {
        setLabel(t);
        onChange({ label: t });
      }}
    />
  );
} // the parent's setState re-renders Picker on the same keystroke
```

### FP4. An atomic transition split across React lanes after an `await` (7: junto 5, habitquest 2)

Locations:

- junto `src/renderer/components/work/WorkSurfaces.tsx:479`, `:480`
- junto `src/renderer/components/work/TaskOperatorPanel.tsx:176`, `:177`
- junto `src/renderer/components/settings/CompanionSettingsSection.tsx:220`
- habitquest `src/features/auth/components/auth-form.tsx:46`
- habitquest `app/(tabs)/training.tsx:211`

The tool converts one state and leaves a React state that is written in the same post-`await` continuation. After the
edit, the observable reaches React through `useSyncExternalStore`, which uses the sync lane and commits in a
microtask. The remaining `setState` uses the default lane and commits in a later task. One commit becomes two, in
reversed order.

On habitquest `auth-form.tsx:42`, the tool's own `mode` review lists the `loading` co-write as unresolved, yet
`loading` is emitted as `change`. The co-write check runs from one side only.

```tsx
const [open, setOpen] = useState(true);
const title$ = useObservable(""); // was useState("")
const submit = async () => {
  await api.create(title$.peek());
  title$.set(""); // sync lane: commits first
  setOpen(false); // default lane: commits later; the form shows cleared but still open
};
```

### FP5. Dead components (5: zenborg 3, gptme 2)

No module imports these components:

- zenborg `src/components/PlanAreaCard.tsx:65`, `:66`
- zenborg `src/components/PlanHabitItem.tsx:35`
- gptme `webui/src/components/ui/carousel.tsx:52`, `:53`

Size is counted across both branches of a component that never mounts.

```tsx
// nothing imports this file
export function PlanAreaCard() {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      …
    </Popover>
  );
}
```

### FP6. The React Compiler already provides the sibling cut (3: anipoex)

Locations: anipoex `src/components/layout/header/header.web.tsx:58`,
`src/features/manga/screens/manga-detail/components/source-picker.tsx:24`, `.../tracking.tsx:17`.

`reactCompiler: true` is detected, but the `use-observable` cost model ignores it. The compiled owner reuses the
cached JSX for unchanged siblings, so the edit saves only the owner's own function call. reptikeep also runs the
compiler, and all 13 of its correct cuts are marginal for the same reason.

```tsx
function Picker() {
  // compiled by the React Compiler
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onPress={() => setOpen(true)}>Source</Button>
      {/* cached, skipped on re-render */}
      <Sheet isPresented={open} onDismiss={() => setOpen(false)} />
    </>
  );
}
```

### FP7. `use-value-for-render-read` with no stale output (3: gptme 2, habitquest 1)

- gptme `webui/src/components/MainLayout.tsx:376`: the `.get()` only guards a render-phase write, and the owner already
  re-renders through `use$(conversation$)` at `:147`.
- gptme `webui/src/stores/tasks.ts:79`: `showArchived$` is never written in production.
- habitquest `app/profile/[userId].tsx:188`: `useT()` at `:34` already subscribes to `lang$` inside a custom hook
  (`src/lib/i18n/index.ts:1690`). The rule only sees subscription calls written directly in the component body.

```tsx
function useT() {
  return STRINGS[use$(lang$)];
}
function Screen() {
  const T = useT();
  const d = fmt(lang$.get());
} // never stale
```

### FP8. Single-occurrence false positives (9)

| App        | Location                                                               | Action                     | Why it is wrong                                                                                                                                                                                                                                                                                                                        | Minimal shape                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| meron      | `desktop/frontend/src/useAppEffects.ts:281`                            | use-observe-effect         | Changes behavior. `loadThread` (`states/mail.ts:808`) calls `mail$.threadErrorId.get()` before its first `await`, so the read becomes tracked. A persistent failure sets it, which re-runs the observer, which fetches again: a retry loop.                                                                                            | `useObserveEffect(() => { const id = sel$.get(); if (id) void load(id) })` where `load` reads `err$.get()` synchronously and sets `err$` on failure |
| anipoex    | `src/features/manga/hooks/use-manga-entry.ts:18`                       | use-observable             | Breaks the UI. The leaf replaces `<Stack.Toolbar.Button>`, and the app's toolbar selects children with `child.type === Stack.Toolbar.Button` (`src/components/layout/toolbar/toolbar-items.ts:43-46`), so the Refresh button disappears on Android and web. The review path already abstains on the same shape at `manga-list.tsx:21`. | A parent filters `Children.toArray(children)` by `c.type === X`, and the cut wraps `<X>` in a leaf                                                  |
| pounce     | `packages/app/src/components/ChatList.tsx:68`                          | use-observable             | Breaks a shared `ChatKeyboardHandle.composerHeight: number` contract that the shipped `ChatList.mobile.tsx` (reached through `ChatList.ios.ts`) must also satisfy. The same scan marks that file `render-cut-unproven`.                                                                                                                | Two platform files implement one hook interface; the tool edits the default file only                                                               |
| gptme      | `webui/src/contexts/SettingsContext.tsx:122`                           | use-observable             | All 7 consumers destructure the whole `settings` object, so "useValue per destructured field" becomes a whole-object subscription. No render is removed.                                                                                                                                                                               | `const { settings } = useSettings()` in every consumer                                                                                              |
| meron      | `desktop/frontend/src/components/dialog/SignatureSettingsCard.tsx:232` | move-use-value-into-child  | The child uses `value` only as `useEditor({ content })`'s initial value. A second caller (`:308`) passes React state, so turning the prop into an observable breaks it. The right edit is a peek.                                                                                                                                      | A child prop used only as a mount-time initializer                                                                                                  |
| reptikeep  | `src/app/(index,reminders,settings,search)/search.tsx:27`              | snapshot-mutated-use-value | The only in-place write is in a test (`src/components/__tests__/add-weight-sheet.test.tsx:48`). Every production write replaces the root.                                                                                                                                                                                              | Production code uses `x$.set({ ...x$.peek(), [id]: v })`; only a test writes `x$[id].field.set(v)`                                                  |
| Nora       | `components/modal/SettingsUsageLimitsContent.tsx:373`                  | peek-unrendered-use-value  | No render is removed: no `pin` write can happen while `PinPrompt` is mounted. Harmless, but a reachability claim, not a static proof.                                                                                                                                                                                                  | Label it non-enforced                                                                                                                               |
| habitquest | `src/ui/theme/theme-context.tsx:42`                                    | use-observable             | The provider's parent has no state, and the only write remounts `<Stack key={themeKey}>` and every themed consumer. Nothing is left to cut.                                                                                                                                                                                            | A provider value that changes only on the write that remounts the tree                                                                              |
| habitquest | `app/paywall.tsx:199`                                                  | use-observe-effect         | The render it saves belongs to a screen that calls `router.back()`. The rewrite moves navigation from post-commit into the synchronous notification inside `subscriptionStore$.isPremium.set` in the middle of `purchaseSubscription`.                                                                                                 | An effect whose only job is to navigate away                                                                                                        |

Uncertain (1): polkadot-web-migration
`components/sections/migrate/dialogs/approve-multisig-call-dialog.tsx:425` (`use-value-for-render-read`). The
untracked read is real. But its only consumer is a `useMemo` keyed on `currentApp`, and `currentApp` keeps its
identity across the in-place `apps[i].multisigAccounts.set` writes. The new subscription is also deep on the whole
`apps` tree, in a dialog that stays mounted while closed. I could not establish whether the parent observer cascade
already delivers the wholesale `apps.set`.

### Defects in correct findings

- **gptme: `useValue` recommended where it does not exist.** 8 hook messages tell the user to use `useValue`, but the
  locked beta.30 has no `useValue` export. The same report says `useValueExport: missing`. Locations:
  `ConversationSettings.tsx:113`, `SetupWizard.tsx:158`, `:161`, `carousel.tsx:52`, `:53`, `UnifiedSidebar.tsx:168`,
  `WorkspaceExplorer.tsx:34`, `SettingsContext.tsx:122`.
- **gptme: consumer paths lowercased.** The `SettingsContext.tsx:122` message lists them as `components/chatinput.tsx`
  and so on.
- **polkadot-web-migration: prose edit breaks the rules of hooks.** At
  `components/hooks/useTokenLogo.ts:14` the message says to replace `.get()` in place, but the read follows an early
  return at `:12`, so doing that makes `useValue` conditional. The `edits` field is correctly omitted; the prose should
  say to hoist.
- **zenborg: misleading evidence.** The `snapshot-mutated-use-value` evidence lists test-file writes first
  (`src/application/__tests__/CycleService.test.ts`) and hides the production writes
  (`src/application/services/CycleService.ts:286`) inside "and 23 more".
- **Selector copy reported to allocate every render.** Two audits report that `useSelector` in beta.47/48 re-runs its
  selector during every render. If so, the suggested copy `useValue(() => ({ ...x$.get() }))` allocates a new object
  on every render, and a `useMemo` keyed on it recomputes every render. That result is never stale, but the memo is
  wasted. This was read from the package source; it is not runtime-verified.
- **pounce: missing move.** At `packages/app/src/screens/Space.tsx:149`, `move-state-down` leaves out the `detailDay`
  memo at `:241`, which has to move with the state.
- **habitquest: Android slot contract.** At `app/(tabs)/today.tsx:485`, a leaf around the `refreshControl` slot must
  forward `style` and `children`, because React Native's Android ScrollView clones that element.
- **Nora: persistence not reasoned about.** The `peek-unrendered-use-value` evidence says "seeded with plain data"
  and never considers the module-level `syncObservable` persistence (`states/settings.ts:452`). The answer was right
  because `syncObservable` loads locally and eagerly.
- **pounce: capability misses.**
  - `reactCompiler: false` is reported, but the mobile consumer compiles this shared raw-TS package with
    `experiments.reactCompiler: true` (`apps/mobile/app.json:76`).
  - `.ios.ts` / `.mobile.tsx` platform files are not resolved.
- **Inconsistent verdicts on identical shapes.** One call site gets `change` while its twin gets a review:
  - habitquest `app/habit/create.tsx:153` is `change`, but `app/habit/edit/[id].tsx:92` is a review.
  - zenborg `AreaColumnHeader.tsx:45` is `change`, but `PlaceFormDialog.tsx:56` is a review.
  - meron `SideNav.tsx:49` is `change`, but `MessagePane.tsx:153` is a review.

## Candidates

Discovery sources:

- `gh api search/code`: `"@legendapp/state" filename:package.json` plus five import and hook queries, 2,430 hits.
- The GitHub dependents graph for `@legendapp/state`: 555 repositories.
- `gh search repos`.

Excluded:

- the LegendApp org and the existing corpus apps;
- tutorials, templates and starters;
- forks of other candidates (`kuKie0427/rig` is a gptme fork, `adilelhaji/oreneta` is a meron fork);
- repos with no license (PackRat, medama, kaset-app, river-journal and others);
- repos with too little Legend usage: amical, codex-relay, foam, prismical, snowb-bmf and others had fewer than 10
  observable components.

"Observable components" counts `.tsx`/`.jsx` files that reference an observable and use `use$`, `useValue`,
`useSelector`, `observer`, `.get()` or a reactive component.

| Repo                            | SHA        | License    | Stars | Last push  | Top contributors              | Legend State  | Scan root              | Files | Observable components |
| ------------------------------- | ---------- | ---------- | ----: | ---------- | ----------------------------- | ------------- | ---------------------- | ----: | --------------------: |
| `skastr0/junto`                 | `f30adbb9` | Apache-2.0 |     2 | 2026-09-26 | skastr0                       | 3.0.0-beta.47 | `src/renderer`         |   382 |                    92 |
| `gptme/gptme` (web UI)          | `f7bb3487` | MIT        |  4433 | 2026-09-28 | TimeToBuildBob, ErikBjare     | 3.0.0-beta.30 | `webui/src`            |   324 |                    34 |
| `equanimitech/zenborg`          | `523af6cf` | MIT        |     0 | 2026-09-25 | Thopiax                       | 3.0.0-beta.35 | `src`                  |   324 |                    45 |
| `nonbili/meron`                 | `002b8791` | AGPL-3.0   |    68 | 2026-09-28 | rnons                         | 3.0.0-beta.47 | `desktop/frontend/src` |   274 |                    51 |
| `battisteb/habitquest`          | `1da8941d` | MIT        |     0 | 2026-09-28 | batto060504-collab, battisteb | 3.0.0-beta.46 | repo root              |   194 |                    35 |
| `pounce-ai/pounce`              | `e83d6daf` | MIT        |    14 | 2026-08-25 | xinha-sh                      | 3.0.0-beta.47 | `packages/app/src`     |   295 |                    21 |
| `karlprieb/reptikeep`           | `6e9756ea` | MIT        |     3 | 2026-09-25 | karlprieb                     | 3.0.0-beta.48 | `src`                  |   209 |                    31 |
| `plantaest/zinnia`              | `2b9a704b` | AGPL-3.0   |     6 | 2026-09-07 | plantaest                     | 2.1.15        | `apps/zinnia-core/src` |   159 |                    24 |
| `Zondax/polkadot-web-migration` | `11003922` | Apache-2.0 |     3 | 2026-09-24 | ayelenmurano, ioanSflt        | 3.0.0-beta.48 | repo root              |   292 |                    16 |
| `Carloss616/anipoex`            | `e679af1e` | MIT        |     0 | 2026-09-22 | Carloss616                    | 3.0.0-beta.48 | `src`                  |   283 |                    18 |
| `nonbili/Nora` (control)        | `466900b6` | AGPL-3.0   |  1103 | 2026-09-24 | rnons                         | 3.0.0-beta.47 | repo root              |   294 |                    45 |

Full SHAs:

- junto `f30adbb946421f8606f27b6e8a5e9e37c7e0fb85`
- gptme `f7bb34871442bb69d3cbecde49c7ce1f2e22517a`
- zenborg `523af6cf9d18fa33941be971e057037283800ba0`
- meron `002b87918804b21b8833e8d0ebaa4b05e44296c0`
- habitquest `1da8941df4ac58f818a34c0e7a529de69039e4ba`
- pounce `e83d6dafdc762395baaae0cd0e98af3f3068c080`
- reptikeep `6e9756eaf8219c9813135027e51a84df0c6be967`
- zinnia `2b9a704b169228b8b26fdddc50d8f403cd79b845`
- polkadot-web-migration `110039223ac01afa28d107341fb7dcc70314a741`
- anipoex `e679af1e37f1e19e4f6fb22b019b24347da6d4dc`
- Nora `466900b69739fd6cb67ca644bcb7ce07293d3473`

Notes on individual candidates:

- **meron and Nora** are by the author of the pinned NouTube and Nori. Nora is a near-clone of NouTube (same `Nou*`
  components and file set), so it serves as a control rather than a candidate. meron adds new shapes: a Wails desktop
  app, a root effect hook, and per-column keyed maps.
- **habitquest** was first scanned from `src`. That missed the Expo Router `app/` directory, which holds about 11k
  lines and the hottest screen. The repo-root scan is the one reported here.
- **pounce** keeps most hot data in TanStack DB and React state. Legend covers about 15 global stores.

## Scan results

The table mixes two kinds of `change`: hook findings (React state and effect conversions) and practice findings
(Legend-specific rewrites). Inventory counts are for the `useValue` subscription inventory.

| App                    | Files | Hook states / effects | Hook change / candidate / keep | Practice change / candidate / style | Inventory total / unresolved / planned / other-action | Top unresolved reasons                                                                |
| ---------------------- | ----: | --------------------: | -----------------------------: | ----------------------------------: | ----------------------------------------------------: | ------------------------------------------------------------------------------------- |
| junto                  |   382 |             417 / 242 |                 49 / 451 / 159 |                        6 / 44 / 362 |                                     358 / 354 / 1 / 3 | no-render-consumer 174, unsupported-value-flow 124, owner-commit-or-snapshot-work 117 |
| gptme                  |   324 |             222 / 132 |                  36 / 241 / 77 |                         28 / 4 / 16 |                                       97 / 97 / 0 / 0 | owner-commit-or-snapshot-work 45, unsupported-value-flow 33, no-render-consumer 30    |
| zenborg                |   324 |              151 / 59 |                  19 / 138 / 53 |                        9 / 52 / 115 |                                     147 / 147 / 0 / 0 | no-render-consumer 115, unsupported-value-flow 83, owner-commit-or-snapshot-work 66   |
| meron                  |   274 |             178 / 122 |                  25 / 188 / 87 |                          4 / 91 / 2 |                                     262 / 258 / 3 / 1 | no-render-consumer 149, unsupported-value-flow 140, owner-commit-or-snapshot-work 105 |
| habitquest (repo root) |   194 |              136 / 56 |                  38 / 125 / 29 |                        2 / 20 / 109 |                                     102 / 102 / 0 / 0 | owner-commit-or-snapshot-work 80, no-render-consumer 60, unsupported-value-flow 54    |
| pounce                 |   295 |              181 / 81 |                  24 / 181 / 57 |                          0 / 6 / 36 |                                       36 / 36 / 0 / 0 | unsupported-value-flow 17, no-render-consumer 16, owner-commit-or-snapshot-work 12    |
| reptikeep              |   209 |              118 / 23 |                   17 / 94 / 30 |                          1 / 3 / 58 |                                       85 / 85 / 0 / 0 | observable-binding-not-proven 35, no-render-consumer 31, unsupported-value-flow 24    |
| zinnia                 |   159 |               17 / 18 |                    2 / 23 / 10 |                           7 / 0 / 3 |                                       61 / 61 / 0 / 0 | no-render-consumer 41, unsupported-value-flow 27, event-or-callback-consumer 24       |
| polkadot-web-migration |   292 |               49 / 25 |                    5 / 55 / 14 |                          3 / 7 / 38 |                                       37 / 37 / 0 / 0 | no-render-consumer 22, owner-commit-or-snapshot-work 19, unsupported-value-flow 19    |
| anipoex                |   283 |               38 / 11 |                    4 / 28 / 17 |                           0 / 2 / 0 |                                       19 / 19 / 0 / 0 | stable-material-render-cut-not-proven 7, wrapped-result 5, no-render-consumer 4       |
| Nora (control)         |   294 |               82 / 76 |                  10 / 100 / 48 |                        12 / 19 / 15 |                                    196 / 184 / 0 / 12 | no-render-consumer 124, unsupported-value-flow 109, owner-commit-or-snapshot-work 82  |

Across all apps, the inventory has 1,400 `useValue` sites. 20 have a finding (4 planned cuts, 16 other actions); the
other 1,380 are unresolved.

Capabilities that decided rules:

- **zinnia** disables `observable-tracking`, `plain-primitive-projection` and `browser-storage-persistence`
  (Legend v2).
- **gptme and zinnia** disable `legacy-use-value` (no `useValue` export). Both are wrongly reported as legacy roots.
- **reptikeep and anipoex** disable `observable-clone-writes` (React Compiler).

The most common review abstentions are `atomic-transition-unproven` (610 across the apps) and `render-cut-unproven`
(294). Next come `effect-write-ownership-unresolved` and `effect-causal-owner-unresolved`.

### Precision by app

| App                    |  Change | Correct | False positive | Uncertain | Dominant false-positive class               |
| ---------------------- | ------: | ------: | -------------: | --------: | ------------------------------------------- |
| junto                  |      55 |      42 |             13 |         0 | leaf is the owner (7), atomic split (5)     |
| gptme                  |      64 |      28 |             36 |         0 | concurrent root (25)                        |
| zenborg                |      28 |      20 |              8 |         0 | leaf is the owner (4), dead code (3)        |
| meron                  |      29 |      25 |              4 |         0 | mixed                                       |
| habitquest (repo root) |      40 |      32 |              8 |         0 | owner renders anyway (3), atomic split (2)  |
| pounce                 |      24 |      23 |              1 |         0 | platform contract                           |
| reptikeep              |      18 |      13 |              5 |         0 | leaf is the owner (3)                       |
| zinnia                 |       9 |       2 |              7 |         0 | concurrent root (7)                         |
| polkadot-web-migration |       8 |       7 |              0 |         1 | none                                        |
| anipoex                |       4 |       0 |              4 |         0 | React Compiler (3), element-type parent (1) |
| Nora (control)         |      22 |      20 |              2 |         0 | leaf is the owner (1), reachability (1)     |
| **Total**              | **301** | **212** |         **88** |     **1** |                                             |

### Precision by action

| Action                                                | Change | Correct | False positive | Notes                                                                               |
| ----------------------------------------------------- | -----: | ------: | -------------: | ----------------------------------------------------------------------------------- |
| use-observable                                        |    200 |     158 |             42 | About half the correct ones are low value (one render per click, small owners)      |
| batch-observable-writes, assign-observable-fields     |     32 |       0 |             32 | All FP1                                                                             |
| move-state-down                                       |     17 |      13 |              4 |                                                                                     |
| snapshot-mutated-use-value                            |     14 |      13 |              1 | 7 are live stale-memo bugs users can hit, 5 are latent, 1 is a test-only write (FP) |
| peek-unrendered-use-value                             |     13 |      11 |              2 |                                                                                     |
| use-observe-effect                                    |     11 |       8 |              3 | 1 changes behavior (meron retry loop)                                               |
| use-value-for-render-read                             |      5 |       1 |              3 | Plus 1 uncertain                                                                    |
| move-use-value-into-child                             |      4 |       3 |              1 |                                                                                     |
| split-use-value-leaves, narrow-use-value-subscription |      3 |       3 |              0 |                                                                                     |
| pass-observable-to-use-value, delete-unused-state     |      2 |       2 |              0 |                                                                                     |

The 13 correct `snapshot-mutated-use-value` findings include live stale-UI bugs:

- zenborg `src/app/harvest/page.tsx:42` (a reflection edit does not show), plus `:43` and `:45`
- zenborg `src/components/PlacesMapView.tsx:51`, `PlacesTreeView.tsx:150`, `RelationshipTagger.tsx:29`
- junto `src/renderer/lib/region-rollups.ts:147`, `:151`
- gptme `webui/src/hooks/useMultiServerConversations.ts:15`
- habitquest `app/(tabs)/shop.tsx:313`

zenborg's author had already hand-fixed the same bug in `src/components/banded-heatmap/CycleDeckHeatmap.tsx:30-37`.

The highest-value correct `use-observable` cuts are:

- gptme `webui/src/components/ConversationContent.tsx:788`: a 250 ms countdown in a 1,100-line owner.
- zenborg `src/components/CycleDeck.tsx:117`: each keystroke re-runs `computeVirtualDeckCards`.
- meron `desktop/frontend/src/components/chat/ConversationMessageList.tsx:79`: link hover re-renders every message
  frame.
- junto `src/renderer/components/terminal/TerminalSurface.tsx:706`: resize geometry in a 1,560-line owner.
- habitquest `app/(tabs)/today.tsx:465-470`: a four-state completion cluster on the main screen.

## Candidate and unresolved sample

About 160 `candidate` findings and unresolved inventory entries were sampled, 10 to 21 per app. About 62 hide a real,
statically provable render or lifecycle cost that the tool misses:

| App        | Sampled | Real misses |
| ---------- | ------: | ----------: |
| junto      |      21 |          11 |
| gptme      |      20 |           7 |
| zenborg    |      18 |           8 |
| habitquest |      16 |           7 |
| meron      |      13 |           7 |
| Nora       |      10 |           6 |
| pounce     |      11 |           6 |
| zinnia     |      15 |           4 |
| polkadot   |      15 |           3 |
| reptikeep  |      11 |           3 |
| anipoex    |      11 |           0 |

The rest were correct abstentions: the state picks the rendered subtree, feeds the list, or gates a mount. The misses
cluster into the gaps below.

## Missed-pattern gaps, ranked

Ranked by the number of apps with a verified, statically provable instance, then by update frequency.

| #   | Gap                                                                                                                     | Apps | Representative file:line                                                                                                                                                                                                                                                                                                                                                                                                                        | Cost                                                                                                                                                                                                                  | Blocker today                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ---: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Whole collection subscribed by the list owner, with no per-row selector; rows get snapshots or the full selection array |    7 | habitquest `app/(tabs)/today.tsx:453-456` → `:860-891`; meron `desktop/frontend/src/components/threads/ThreadList.tsx:466-471`; zenborg `src/hooks/useSelection.ts:24-29` via `MomentCard.tsx:55`; Nora `components/tab/NativeTabHost.tsx:32`, `:209-217`; reptikeep `src/app/(index,reminders,settings,search)/index.ios.tsx:48-49`; junto `src/renderer/components/feed/OperatorFeed.tsx:265`; gptme `webui/src/components/AgentsList.tsx:26` | Every item write or selection re-renders every non-memo row. Nora: about 4 writes × N tabs per page load into an 830-line row. habitquest: 4–5 screen renders per completion, each rebuilding `Gesture.Pan` per card. | No row-selector rule; `select-primitive-projection` covers only `v === id` on an existing row binding                                             |
| 2   | A subscription or derivation inside a custom hook, whose consumer is the caller                                         |    7 | zinnia `apps/zinnia-core/src/hooks/useShowMainPanel.ts:6`; polkadot `components/hooks/useSynchronization.ts:92` (sync progress); zenborg `src/hooks/useHabitHealth.ts:29-49`; gptme `webui/src/hooks/useProviderHealth.ts:90-91`; habitquest `app/(tabs)/_layout.tsx:13-21`; junto `src/renderer/lib/region-rollups.ts:121-150`; meron `desktop/frontend/src/useAppEffects.ts:47-59`                                                            | High-frequency progress re-renders 66-element owners (polkadot). Per-card O(moments) health work (zenborg). The navigator layout re-renders on every completion (habitquest).                                         | `no-render-consumer` + `unsupported-value-flow` on a hook return; FP3 and FP7 are the precision side of the same blind spot                       |
| 3   | Dynamic-key, Map-entry or factory-getter observable bindings not proven, which blocks narrowing                         |    6 | gptme `webui/src/components/ChatInput.tsx:882` (`use$(conversations$.get(id))`); junto `src/renderer/components/chat/ChatView.tsx:150-159` (`chatState$[agentKey]`); meron `desktop/frontend/src/components/kanban/KanbanBoardColumn.tsx:93-112`; reptikeep 32 inventory entries on `activityStores.*.$` (a getter in `src/state/activity-store.ts:17-52`); anipoex `.../source-picker.tsx:25`; habitquest `app/habit/[id].tsx:261-263`         | gptme's ChatInput and junto's ChatView re-render on **every streamed token**. meron: one column write re-renders all N columns (O(N²) on board load).                                                                 | `observable-binding-not-proven`, `selector-observable-binding-not-proven`                                                                         |
| 4   | Stale memo after an in-place write, missed or demoted to candidate                                                      |    4 | habitquest `app/(tabs)/today.tsx:544` (candidate at `:454`) and `src/features/habits/components/take-break-modal.tsx:34`; junto `src/renderer/components/rts/StoppageRank.tsx:79`, plus `RtsBottomBar.tsx:997`, `:1196`; gptme `webui/src/components/MainLayout.tsx:207` (a member of a mutated object) and `:235-290` (memo keyed on a computed handle); pounce `packages/app/src/screens/Search.tsx:60` → `:83`, `:137` (cross-file writes)   | Wrong UI, not extra renders: sort order, unlocks and occupancy marks stay stale until a refetch.                                                                                                                      | The demotion to candidate never checks whether the co-dependencies are written on the same path; the match covers only the bare `useValue` result |
| 5   | Whole object subscribed to derive one primitive or boolean (length, emptiness, a combined flag, a discarded tick)       |    4 | Nora `components/page/MainPageContent.tsx:23` (`.length`); junto `src/renderer/components/CanvasChrome.tsx:27`, `src/renderer/App.tsx:305-306`, `terminal/TerminalSurface.tsx:724-726`, `:1795`; zinnia `useShowMainPanel.ts:6`; zenborg `src/components/Timeline.tsx:138`                                                                                                                                                                      | junto's App re-renders the whole app on each canvas switch, and every TerminalSurface re-renders on every doc commit. zenborg's whole timeline re-renders every 60 s.                                                 | `plain-seed-not-proven` on a module-const seed (`EMPTY_DOC`); no multi-read fusion; zinnia also has `legend-v2-tracking`                          |
| 6   | High-frequency React state that belongs in an observable plus a leaf (streams, polls, timers, scroll)                   |    5 | pounce `packages/app/src/screens/Session.tsx:195`, `:744` (every SSE frame into a 1,400-line screen); junto `src/renderer/components/work/TaskBoard.tsx:2300` (1 Hz), `sheet/SheetDetail.tsx:63` (scroll); gptme `webui/src/components/ComputerPreview.tsx:54` (2 s poll); habitquest `app/training/[id].tsx:24` (1 Hz)                                                                                                                         | Full-screen renders at stream or timer rate                                                                                                                                                                           | `effect-write-ownership-unresolved` / `atomic-transition-unproven`; no Legend-first streaming rule                                                |
| 7   | The atomic-transition gate ignores same-event React batching                                                            |    3 | zenborg `src/components/OracleSettingsSection.tsx:63`; habitquest `src/features/habits/components/content-picker.tsx:220`; meron `desktop/frontend/src/components/tasks/TasksPanel.tsx:54`                                                                                                                                                                                                                                                      | Per-keystroke re-renders of 28–69 element owners; all co-writes sit in one click or key handler                                                                                                                       | `atomic-transition-unproven`                                                                                                                      |
| 8   | Render reads misclassified as `no-render-consumer` or event reads (a latent precision hazard)                           |    3 | zinnia `components/ChangeCard/ChangeCard.tsx:53` (read at `:271` in a JSX attribute), `TabPanel/TabHeaderPanel.tsx:22-23` (arguments to a local render call at `:94`), `FilterPanel/FilterPanel.tsx:258` (`:413`); polkadot `components/sections/migrate/deep-scan-modal.tsx:61` (a render-time `.map` at `:272` classed as event), `app-scan-item.tsx:132`; junto `sheet/SheetDetail.tsx:63` (evidence says render 0; read at `:176`)          | None yet: other gates abstain. But any rule that trusts these read kinds, such as `peek-unrendered-use-value`, would emit a false positive here                                                                       | Read classifier                                                                                                                                   |
| 9   | Legend `Memo` and `observer` bodies not analyzed                                                                        |    2 | gptme `webui/src/components/ChatMessage.tsx:580-795` (Memo children close over React state and props, frozen at first render: the TTS button, lightbox and avatar never update), `:612`, `:770`, `ConversationContent.tsx:918-938` (Memo reads the whole message on every token); zenborg `src/components/SettingsModal.tsx:84`                                                                                                                 | Stale UI plus per-token re-renders                                                                                                                                                                                    | No rule; `.get()` inside an observer is not in the inventory                                                                                      |
| 10  | Effect-only subscriptions in the root owner                                                                             |    1 | meron `desktop/frontend/src/useAppEffects.ts:47-59`, called at `App.tsx:54`; `keep-effect` at `:118`, `:160`, `:260` claims "useValue deps also render this owner", which is false                                                                                                                                                                                                                                                              | The whole app re-renders on every search keystroke, thread selection and j/k step                                                                                                                                     | `keep-effect` gates; no "move effect-only hook into a null-rendering child" action                                                                |
| 11  | A fresh-allocation selector used as a memo dependency                                                                   |    1 | pounce `packages/app/src/screens/Home.tsx:162`, `:180`, `:185`, `:187` → memo `:201`                                                                                                                                                                                                                                                                                                                                                            | The rows memo re-runs on every HomeScreen render                                                                                                                                                                      | No rule; the inverse of `snapshot-mutated-use-value`                                                                                              |
| 12  | The Legend v2 tracking gate is too broad                                                                                |    1 | zinnia `apps/zinnia-core/src/App.tsx:32` calls `enableReactTracking({ warnUnobserved: true })`, without `auto`                                                                                                                                                                                                                                                                                                                                  | Disables projection rules that would catch gap 5                                                                                                                                                                      | `legend-v2-tracking`                                                                                                                              |
| 13  | Stale closure in unmount cleanup                                                                                        |    1 | zinnia `components/FeedPanel/FeedControlPanel.tsx:63-68`                                                                                                                                                                                                                                                                                                                                                                                        | The live-update interval is never cleared (a lifecycle bug); the `use-unmount` candidate would keep it                                                                                                                | No rule                                                                                                                                           |
| 14  | Imported pure helpers inside selectors                                                                                  |    1 | polkadot `components/hooks/useMigration.ts:54`, `:241`, `:246`, `useSynchronization.ts:110-114`                                                                                                                                                                                                                                                                                                                                                 | Per-render wrapper overhead; 7 of 9 selectors track nothing                                                                                                                                                           | `selector-calls-unproven-function`                                                                                                                |

Not found in any app:

- observables recreated per render;
- `observe` without cleanup;
- `useEffect` mirroring an observable into React state (the Legend-native kind is already covered by
  `use-observe-effect`).

The only untracked render `.get()` reads found are masked by an enclosing subscription:

- habitquest `app/(tabs)/social.tsx:634`
- polkadot `components/hooks/useTokenLogo.ts:14` (caught)

## Recommended pins

1. **`gptme/gptme` web UI** (`webui/src`, MIT, 4.4k stars, several contributors).
   - Streaming chat with a global Map store updated per token, plus `Memo`, `useObserveEffect`, local computeds and a
     virtualized list.
   - Holds the largest verified false-positive class (FP1, 25 labels), the missing-`useValue` message defect, two
     per-token misses (gaps 3 and 9) and a frozen-`Memo` correctness bug.
   - Pinning it makes the concurrent-root fix measurable. Until the detector recognizes `createRoot`, its 25
     batch/assign practices fail as unlabeled `change`, which is the intended red state.
2. **`equanimitech/zenborg`** (`src`, MIT, Next.js, React 19).
   - 12 synced collection stores.
   - 9 correct `snapshot-mutated-use-value` findings, 5 of them live bugs the author half-fixed by hand elsewhere.
   - The highest-value keystroke cut (`CycleDeck.tsx:117`).
   - Clean adversarial fixtures for FP2, FP3 and FP5.
   - Row-selector and custom-hook misses in the timeline (gaps 1 and 2).
3. **`skastr0/junto`** (`src/renderer`, Apache-2.0, Electron, React 19).
   - The heaviest Legend usage: 358 subscriptions, 143 importing files.
   - 42 correct changes and the only verified FP4 atomic-split cluster (5).
   - Per-token (`ChatView.tsx:159`) and per-commit (`TerminalSurface.tsx:724`) misses.
   - The cost is a 14 MB report and 1,500-line components; labels need care around async continuations.

Next in line:

- **habitquest** (repo root; Expo new architecture, a missed stale memo on the main screen, and row-selector
  opportunities).
- **meron** (the retry-loop false positive and the root effect hook, but same author as NouTube and Nori, and AGPL).
- **zinnia** as a Legend v2 negative control for FP1.
- **anipoex** as a React Compiler negative control (FP6 and the element-type parent).

Nora adds little over NouTube.

## Reproduce

```bash
git clone --depth=1 https://github.com/<owner>/<repo>.git <dir>   # then check out the SHA above
node --max-old-space-size=16384 .cand-dist/src/cli.js <dir>/<scan root> --coverage > <app>.json
```

Checkouts used for this report live in `/Users/alialdhamen/dev/legend-doctor-corpus-candidates/<name>`. No
application source is copied into this repository.
