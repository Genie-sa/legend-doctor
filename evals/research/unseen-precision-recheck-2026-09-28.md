# Unseen-app precision recheck

Date: 2026-09-28. Analyzer: `origin/main` at `7f1d531`, built with `tsc -p tsconfig.json --outDir .out` in a detached
worktree after `npm ci --ignore-scripts`, and run as `node --max-old-space-size=16384 .out/src/cli.js <root>`. The
baseline is `28772c7`, the commit the [first audit](unoptimized-legend-apps-2026-09-28.md) scanned, rebuilt the same way.
Both builds scanned the same checkouts. No application dependencies were installed and no application code was run.

This recheck measures what the false-positive fixes merged since the first audit did on apps outside the pinned corpus:
#65 (React 18 roots), #69 (dead components), #71 and #80 (custom-hook subscriptions), #73 (split commits), #74
(test-only writes), #75 (`useObserveEffect` opaque calls), and #81 (parents that inspect `child.type`). gptme, zenborg,
and junto were pinned in #82 and are excluded.

## Summary

- The rebuilt baseline reproduces the first audit's `change` counts exactly on all eight remaining apps: 154 findings.
- On those eight apps, precision rose from **79.2% to 85.3%** (122/154 to 116/136). The fixes removed 12 of the 31
  audited false positives and created no new findings. They also removed 6 audited correct findings, all through #75.
- BBPlayer, audited here for the first time, has 44 `change` findings: 24 correct and 20 false positives (54.5%). Two
  causes dominate. The React Compiler already caches the siblings a cut would protect. A Babel plugin makes `<Computed>`
  element children reactive, and the analyzer does not model it.
- Across all nine apps: **140 correct, 39 false positives, 1 uncertain, 77.8%**.
- The largest remaining class is the React Compiler class (13), then leaf-is-owner (8) and owner-renders-anyway (7).

## Apps

| App                             | SHA        | Scan root              | Legend State  | React Compiler | `concurrentRoot` |
| ------------------------------- | ---------- | ---------------------- | ------------- | -------------- | ---------------- |
| `nonbili/meron`                 | `002b8791` | `desktop/frontend/src` | 3.0.0-beta.47 | no             | true             |
| `battisteb/habitquest`          | `1da8941d` | repo root              | 3.0.0-beta.46 | no             | true             |
| `pounce-ai/pounce`              | `e83d6daf` | `packages/app/src`     | 3.0.0-beta.47 | no             | true             |
| `karlprieb/reptikeep`           | `6e9756ea` | `src`                  | 3.0.0-beta.48 | yes            | true             |
| `plantaest/zinnia`              | `2b9a704b` | `apps/zinnia-core/src` | 2.1.15        | no             | true (was false) |
| `Zondax/polkadot-web-migration` | `11003922` | repo root              | 3.0.0-beta.48 | no             | true             |
| `Carloss616/anipoex`            | `e679af1e` | `src`                  | 3.0.0-beta.48 | yes            | true             |
| `nonbili/Nora`                  | `466900b6` | repo root              | 3.0.0-beta.47 | no             | true             |
| `bbplayer-app/BBPlayer` (MIT)   | `d19b0f26` | `apps/mobile/src`      | 3.0.0-beta.48 | yes            | false            |

BBPlayer full SHA: `d19b0f26558006383d5d8bd246fd0a1872604861`. The other full SHAs are in the first audit. Paths below are relative
to each scan root.

## Precision before and after

"Before" is the first audit's verdicts on `28772c7`. "After" is `7f1d531`, matched by file, line, and action. The one
uncertain finding (polkadot) stays in the denominator, as in the first audit.

| App                    | Before: change | Correct |  FP | Precision | After: change | Correct |  FP | Precision |
| ---------------------- | -------------: | ------: | --: | --------: | ------------: | ------: | --: | --------: |
| meron                  |             29 |      25 |   4 |     86.2% |            26 |      23 |   3 |     88.5% |
| habitquest             |             40 |      32 |   8 |     80.0% |            39 |      32 |   7 |     82.1% |
| pounce                 |             24 |      23 |   1 |     95.8% |            23 |      23 |   0 |      100% |
| reptikeep              |             18 |      13 |   5 |     72.2% |            17 |      13 |   4 |     76.5% |
| zinnia                 |              9 |       2 |   7 |     22.2% |             0 |       0 |   0 |         — |
| polkadot-web-migration |              8 |       7 |   0 |     87.5% |             8 |       7 |   0 |     87.5% |
| anipoex                |              4 |       0 |   4 |        0% |             3 |       0 |   3 |        0% |
| Nora                   |             22 |      20 |   2 |     90.9% |            20 |      18 |   2 |     90.0% |
| **Eight apps**         |        **154** | **122** |  31 | **79.2%** |       **136** | **116** |  19 | **85.3%** |
| BBPlayer               |  46, unaudited |       — |   — |         — |            44 |      24 |  20 |     54.5% |
| **All nine**           |                |         |     |           |       **180** | **140** |  39 | **77.8%** |

If the two habitquest atomic-split verdicts are revised as argued under [Disputed verdicts](#disputed-verdicts), the
eight apps reach 118/136 (86.8%) and all nine reach 142/180 (78.9%).

BBPlayer's precision depends on how React Compiler cuts are judged. The first audit counted anipoex's three as false
positives and reptikeep's thirteen as correct. The table follows both precedents by owner size; see
[FP-A](#fp-a-the-react-compiler-already-caches-the-siblings-13-anipoex-3-bbplayer-10). Counting every
interaction-rate compiled cut as correct gives BBPlayer 34/44 (77.3%). Counting every one as false gives 11/44 (25.0%).

## What changed on the eight audited apps

Matched by file, line, and action: 18 findings disappeared and none appeared.

### Audited false positives now gone (12)

| App        | Location                                                                                                                                                                               | Action                           | Now                                                  | Fixed by |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------- | -------- |
| zinnia     | `components/HeroPanel/StartStateContent.tsx:95`, `NewTabPanel/NewTabPanel.tsx:40`, `TabPanel/DiffTab.tsx:244`, `TabPanel/ReadTab.tsx:65`, `hooks/useManageVersion.ts:24`, `:59`, `:84` | batch / assign-observable-fields | review: React already renders these writes once      | #65      |
| habitquest | `app/profile/[userId].tsx:188`                                                                                                                                                         | use-value-for-render-read        | no finding                                           | #71      |
| meron      | `useAppEffects.ts:281`                                                                                                                                                                 | use-observe-effect               | review-effect, `callback-timing-unresolved`          | #75      |
| anipoex    | `features/manga/hooks/use-manga-entry.ts:18`                                                                                                                                           | use-observable                   | review-state, `render-cut-unproven` (hook consumers) | #71, #80 |
| pounce     | `components/ChatList.tsx:68`                                                                                                                                                           | use-observable                   | review-state, `render-cut-unproven` (hook consumers) | #71, #80 |
| reptikeep  | `app/(index,reminders,settings,search)/search.tsx:27`                                                                                                                                  | snapshot-mutated-use-value       | `style` only                                         | #74      |

The pounce and anipoex findings are gone because the state lives in a custom hook whose consumers are unresolved. The
contracts that made them wrong still exist: two platform files share a hook interface, and a toolbar selects children
by `child.type`. #81 targets the second.

### Audited correct findings now gone (6): all #75

Each became `review-effect` with `callback-timing-unresolved`, which means the effect calls code the checker cannot see
through.

| App    | Location                              | Callee named                       | Why the check blocks                                                                                                                      | Loss justified? |
| ------ | ------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Nora   | `components/modal/NavModal.tsx:130`   | `selectProfile`                    | The callee runs `tab$.get()` before it returns. The extra trigger only reruns an effect that exits early, but no static proof shows that. | Yes             |
| meron  | `useAppEffects.ts:61`                 | `resolveI18nLanguageFromWebLocale` | `localeStr.replace(...)` on a `string` parameter. Methods of parameters are treated as possible application methods.                      | No              |
| meron  | `components/chat/useQuickReply.ts:94` | `quickReplyCaretOffset`            | Peek-only code, but it calls `text.replace(...)` on a destructured `string`, the same shape.                                              | No              |
| zinnia | `hooks/useSyncDirection.ts:15`        | `setDirection`                     | A value returned by Mantine's `useDirection`. Every hook return value blocks, including one from a package that never sees an observable. | No              |
| zinnia | `hooks/useSyncLanguage.ts:11`         | `i18n.getIntl`                     | A method of an application-built object.                                                                                                  | Partly          |
| Nora   | `components/page/MainPage.tsx:39`     | `reconcileIosTransactions`         | It calls methods of a local native-module wrapper and of an application-built logger, which the checker cannot follow.                    | Partly          |

A two-file fixture confirms the parameter case. `normalize(language)` blocks the rewrite when `normalize` calls
`value.replace` on its `string` parameter. The same call on a `const` string converts.

### Unchanged audited false positives (19)

Listed by class under [Remaining false-positive classes](#remaining-false-positive-classes).

## BBPlayer audit

At `28772c7` BBPlayer had 46 `change` findings. Two have since become reviews: `app/test.tsx:77` (#73, split commit)
and `features/playlist/remote/hooks/useCheckLinkedToLocalPlaylist.ts:17` (custom-hook consumers). All 44 current findings were
audited against source.

BBPlayer compiles every file with `babel-plugin-react-compiler` and `@legendapp/state/babel` (`apps/mobile/babel.config.js`).
It runs React 19.2 on React Native 0.86. The compiler's per-file bailouts were not checked, because that would mean
running the app's toolchain.

| Verdict                                     | Count | Findings                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correct: keystroke-rate cut or no render    |    11 | `app/settings/account.tsx:45`, `:47`, `:48`; `app/settings/appearance/theme-search.tsx:107`; `app/test.tsx:78`; `components/modals/login/CookieLoginModal.tsx:28` (`use-ref`); `components/modals/lyrics/ManualSearchLyrics.tsx:76`; `components/modals/player/SleepTimerModal.tsx:20`; `components/modals/playlist/ManualMatchExternalSync.tsx:93`; `components/modals/playlist/MergePlaylistsModal.tsx:72`; `features/library/favorite/FavoriteFolderList.tsx:28` |
| Correct: compiled owner of 20+ JSX elements |    13 | `app/downloaded.tsx:250`, `:262`; `app/performance.tsx:62`; `app/playlist/local/[id].tsx:253`, `:254`, `:274`, `:276`; `app/settings/account.tsx:50`; `app/share/playlist.tsx:88`, `:131`; `features/player/components/main/PlayerTrackInfo.tsx:54`; `features/playlist/local/components/LocalPlaylistHeader.tsx:106`; `features/theme/ThemeSection.tsx:117`                                                                                                        |
| FP-A: compiled owner under 20 JSX elements  |    10 | `refreshing` in `app/playlist/remote/collection/[id].tsx:62`, `favorite/[id].tsx:63`, `multipage/[bvid].tsx:74`, `search-result/fav/[query].tsx:69`, `search-result/global/[query].tsx:70`, `toview.tsx:76`, `uploader/[mid].tsx:80`, `app/settings/appearance/theme-search.tsx:108`; `components/modals/PlayerQueueModal.tsx:162`; `features/playlist/remote/components/PlaylistHeader.tsx:53`                                                                     |
| FP-B: leaf is the owner                     |     3 | `components/modals/login/CookieLoginModal.tsx:27`, `components/modals/playlist/DuplicateLocalPlaylistModal.tsx:17`, `SaveQueueToPlaylistModal.tsx:20`                                                                                                                                                                                                                                                                                                               |
| FP-C: owner renders anyway                  |     2 | `app/playlist/external-sync.tsx:227`, `features/comments/components/CommentItem.tsx:135`                                                                                                                                                                                                                                                                                                                                                                            |
| FP-D: Babel-plugin `Computed` children      |     5 | `app/player.tsx:330`, `:340`, `:345`, `:364`; `features/player/components/menu/PlayerFunctionalMenu.tsx:79`                                                                                                                                                                                                                                                                                                                                                         |

The 13 compiled-owner cuts each remove the owner function call and its hook re-runs on an interaction, such as opening
a sheet, a pull-to-refresh, or a title tap. They are correct in the same sense as reptikeep's thirteen: marginal.

## Remaining false-positive classes

Ranked by count across the nine apps (39 total).

### FP-A. The React Compiler already caches the siblings (13: anipoex 3, BBPlayer 10)

Unchanged anipoex sites: `components/layout/header/header.web.tsx:58`,
`features/manga/screens/manga-detail/components/source-picker.tsx:24`, `.../tracking.tsx:17`.

BBPlayer examples:

- `app/playlist/remote/toview.tsx:76`: `refreshing` set at the start and end of a pull-to-refresh in a 15-element owner.
- `features/playlist/remote/components/PlaylistHeader.tsx:53`: a title-expand toggle in a `memo` header of 13 elements.
- `components/modals/PlayerQueueModal.tsx:162`: `clearing`, written after the sheet has already been dismissed.

The analysis pass already knows which files compile (`compiledFiles` in
`src/project/analyze-path/analysis-pass.ts`), but only practice rules read it; no hook verdict does. A compiled owner reuses the cached JSX of every
unchanged sibling, so the cut saves only the owner's own function call. The first audit's precedents split at about 20
JSX elements. The false positives had owners of 4, 11, and 18 elements. The correct ones had owners of 27 to 57, with
one exception at 10 that is written once, on image load.

**Smallest fix.** Pass the per-file compiler flag into the hook verdict context. When it is true, demote a `use-observable` or
`move-state-down` cut to a candidate if both hold:

- the owner has fewer than 20 JSX elements;
- every write sits in an interaction handler, not in `onChangeText`, a timer, a subscription callback, or an effect.

Use a new abstention reason. About 40–60 source lines, plus fixtures from anipoex `tracking.tsx` and BBPlayer
`toview.tsx`. Pick the threshold and label it before enforcing, because the precedent is thin.

### FP-B. The leaf is the owner (8: reptikeep 3, meron 1, Nora 1, BBPlayer 3)

Unchanged: reptikeep `app/(index,reminders,settings,search)/backup-restore.android.tsx:72`, `:74`, `:79`; meron
`components/chat/ConversationDetailsPanel.tsx:89`; Nora `components/modal/ToolsModal.tsx:57`.

New in BBPlayer: `components/modals/playlist/DuplicateLocalPlaylistModal.tsx:17`, `SaveQueueToPlaylistModal.tsx:20`,
`components/modals/login/CookieLoginModal.tsx:27`. Each is a dialog of 6–8 JSX elements whose only dynamic element is a
`TextInput`. After the cut the owner renders `Dialog.Title`, `Dialog.Actions`, and two buttons.

A cut proven by a transported read skips the materiality tier (`--materiality` help text), so no minimum owner size
applies to these dialogs.

**Smallest fix.** For cuts proven by a transported read, count the owner elements left after removing the leaf
subtree and static host elements. Require that residual to meet the compact tier (8). About 30–50 lines in
`src/analysis/verdicts/transport-verdicts.ts` and `small-owner-verdicts.ts`.

### FP-C. The owner renders anyway on the same update (7: habitquest 3, reptikeep 1, meron 1, BBPlayer 2)

Unchanged: habitquest `src/features/habits/components/content-picker.tsx:209`, `:223`, `:226` (a prop callback runs in
the same handler); reptikeep `components/reptile-form-sheet.android.tsx:130` (co-written with owner state); meron
`components/kanban/KanbanBoardColumn.tsx:98` (`peek-unrendered-use-value` whose subscribed siblings
are written in the same stretch; should be `style`).

New in BBPlayer:

- `app/playlist/external-sync.tsx:227` (`etaSeconds`): every `setEtaSeconds` sits in the match callback next to
  `setResult` and `setProgress`. Those write a zustand store the owner reads whole, through
  `useExternalPlaylistSyncStore((state) => state)`, so the owner renders on every callback anyway.
- `features/comments/components/CommentItem.tsx:135` (`darkMode`): the state mirrors `Appearance`. The root provider
  derives the Paper theme from `useColorScheme()` (`components/providers.tsx:83`), and `CommentItem` calls `useTheme()`,
  so the same appearance event already re-renders it.

**Smallest fixes, by shape:**

- Prop callback or other owner state written in the same synchronous stretch: return a review. About 30–40 lines in the
  write-unit analysis.
- External store co-written and subscribed whole: model a store hook called with an identity or whole-object selector
  as an owner subscription. About 30 lines.
- `peek-unrendered-use-value` whose siblings are co-written: downgrade to `style`. About 20 lines.
- The `Appearance` case: label it non-enforced. A fix would need context provenance.

### FP-D. `@legendapp/state/babel` makes `<Computed>` element children reactive (5: BBPlayer)

Locations: BBPlayer `app/player.tsx:330`, `:340`, `:345`, `:364`, and
`features/player/components/menu/PlayerFunctionalMenu.tsx:79`, all `use-value-for-render-read`.

The `.get()` calls sit in element children of `<Computed>`. Legend's Babel plugin, enabled in
`apps/mobile/babel.config.js`, wraps those children in a function, so `Computed` tracks the reads and the output is
never stale. Following the edit would add a whole-page subscription to `PlayerPage`. The analyzer already handles
function children. It does not know about the plugin.

```tsx
// babel.config.js: plugins: ['@legendapp/state/babel', ...]
<Computed>
  {mode$.get() === "podcast" ? <PodcastMenu /> : <MusicMenu />}{" "}
  {/* tracked after the plugin runs */}
</Computed>
```

**Smallest fix.** Read the package's Babel config. `src/project/react-compiler-package.ts` already finds it. When the
config lists `@legendapp/state/babel`, treat element children of `Computed` and `Memo` like function children in
`src/rules/observable-tracking/render-reads.ts`. About 30 source lines.

### FP-E. Single occurrences (4)

| App        | Location                                              | Action                    | Smallest fix                                                                                              | Lines |
| ---------- | ----------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------- | ----: |
| meron      | `components/dialog/SignatureSettingsCard.tsx:232`     | move-use-value-into-child | Recommend a peek when the child uses the prop only as a mount-time initializer (`useEditor({ content })`) |   ~30 |
| Nora       | `components/modal/SettingsUsageLimitsContent.tsx:373` | peek-unrendered-use-value | None; this is a reachability claim. Label it non-enforced.                                                |     0 |
| habitquest | `src/ui/theme/theme-context.tsx:42`                   | use-observable            | Abstain when the only write also changes a `key` that remounts the consumers                              |   ~25 |
| habitquest | `app/paywall.tsx:199`                                 | use-observe-effect        | Keep an effect whose body navigates (`router.back`, `replace`, `push`)                                    |   ~15 |

### Disputed verdicts

The first audit marked habitquest `src/features/auth/components/auth-form.tsx:46` and `app/(tabs)/training.tsx:211` as
atomic-split false positives (FP4), reasoning from React 18 lane behavior. habitquest runs React 19.2 on React Native
0.83. The [split-commit audit](../audit-2026-09-28-split-commits.md) measured, on React DOM 19.2 with `createRoot`,
that both shapes commit once:

- `auth-form.tsx`: `setMode` and the `finally` `setLoading(false)` run in one stretch after `await signUp(...)`. The
  table row "Both writes in one stretch after an `await`" reads 1, then 1.
- `training.tsx`: `setTab` runs in the helper's last stretch, and `setImporting(false)` runs a microtask later in the
  caller. The row "React write resumes first, observable a microtask later" reads 1, then 1.

#73 deliberately leaves both as `change`. Fabric uses the same reconciler and microtask scheduling, but no runtime test
covers React Native. The primary numbers keep the first audit's verdicts. The revised numbers are given under the
precision table.

## Defects in correct findings

- **The `refreshControl` slot contract (BBPlayer, 9 `refreshing` findings).** React Native's Android `ScrollView`
  clones the `refreshControl` element and passes it `style` and the scroll view as `children`. A leaf around
  `<RefreshControl>` must forward both, or the list disappears on Android. The message does not say so. habitquest
  `app/(tabs)/today.tsx:485` has the same defect.
- **`concurrentRoot: false` on BBPlayer.** React Native 0.86 creates only concurrent roots. The likely cause, not
  verified, is `packages/bottom-tabs-react-navigation`, which declares `react-native: "*"` as a peer range that the
  renderer check cannot parse. No BBPlayer finding depends on it today. A batch rule would report false positives.
  Estimated fix: about 10 lines, treating an unbounded peer range as no constraint.

## Recall-loss fixes

All six losses come from #75's opaque-call check. They fall into three shapes.

| Shape                                                                  | Findings                                               | Smallest fix                                                                                                               |  Lines |
| ---------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -----: |
| Methods of a parameter or destructured value whose type is a primitive | meron `useAppEffects.ts:61`, `useQuickReply.ts:94`     | In `mayHoldApplicationMethods`, ask the type checker; a `string`, `number`, or `boolean` receiver runs no application code | ~15–20 |
| A value returned by a package hook                                     | zinnia `useSyncDirection.ts:15`                        | Treat it as external when the package does not depend on `@legendapp/state` and receives no observable or callback         |    ~15 |
| Methods of application-built objects                                   | zinnia `useSyncLanguage.ts:11`, Nora `MainPage.tsx:39` | Follow the method declaration when the object is a module `const` built from a literal or a resolvable factory             |    ~50 |

Nora `NavModal.tsx:130` is a sound abstention: the callee runs a real `.get()`.

## Reproduce

```bash
git worktree add --detach <dir> origin/main && cd <dir> && npm ci --ignore-scripts
npx tsc -p tsconfig.json --outDir .out
node --max-old-space-size=16384 .out/src/cli.js <checkout>/<scan root> > <app>.json
jq -r '(.findings[] | select(.disposition == "change") | [.location.file, .location.line, .action]),
       (.practices[] | select(.disposition == "change") | [.location.file, .location.line, .action]) | @tsv' <app>.json
```

Repeat with `28772c7` for the baseline. The checkouts live outside this repository. No application source is copied
into it.
