# Replay sweep audit — September 28, 2026

Scope: all 44 expert replay misses on `51f2d32` (23/67 enforced found, 0/126 non-enforced flagged). No detector, pin,
or target changed. A label stays enforced only when the analyzer's edit alone, at the commit's parent, removes a
render or lifecycle cost without changing behavior.

## Relabels

Four cases move from enforced to non-enforced. All four were misses, so found cases are unchanged.

| Case                                                                  | Why the edit alone saves nothing                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `52dcd1b` `components/MediaLibrary/TrackList.tsx:77` (narrow)         | `TrackList` also calls `useLibraryTrackList()` (line 70). That hook subscribes the same component to `localMusicState$.playlists` (`useLibraryTrackList.ts:476`), so every playlist edit still re-renders it. The saving comes from the commit's change inside the hook, which is already non-enforced.                                                     |
| `2e57a26` `src/DeckRenderer.tsx:253` (narrow)                         | Only the presenter previews pass a `targetIndex` (`PresenterWindow.tsx:125`). `PresenterDeckContent` subscribes to `currentSlide` (line 710) and passes both preview indices to `PresenterWorkspace` (lines 734-738), so every slide change re-renders both previews. The live preview's index is `currentSlide` itself, and the next preview's follows it. |
| `eb0d9f8` `CodeViewerWindow.tsx:132` (move down)                      | One `metadata$.set` writes `styles` and `timing` together (`virtualized-document/src/index.tsx:391-394`). A snapshot's first write notifies both: `timing` always changes and the metadata observable is recreated per snapshot. Moving `styles` alone leaves the window rendering through `sourceTiming`. The expert moved both.                           |
| `eb0d9f8` `CodeViewerWindow.tsx:133` (move into child, now move down) | The same write, from the other side. The subtitle is a host `<Text>` (line 301), not an existing child component, so the label's action is now `move-use-value-down`.                                                                                                                                                                                       |

## Kept after runtime evidence

`0d7ad12` `DiffViewerWindow.tsx:2966` (`compareRefInput`, `use-observable`) was the one uncertain case. The edit keeps
`compareRefPromptVisible` as React state and moves the typed ref to an owner observable, so
`closeCompareRefPrompt` writes one of each. If the flag update landed in a lower lane than the observable's
`useSyncExternalStore` update, the prompt could commit once with the cleared value while it is still visible.

`tests/runtime/mixed-lane-close.test.ts` runs that close under jsdom with React 19.2.8 and Legend State
`3.0.0-beta.48`, with and without StrictMode. It runs from a discrete click and from a default-priority callback
outside `act`. Neither commits the cleared value into a visible prompt. A control that defers the flag with
`startTransition` does commit it, which shows the harness would catch the tear. The label stays enforced.

## Kept as sound

Each remaining miss was checked against the parent tree: its writers, the owner's other subscriptions, the parents'
subscriptions, and the rest of the expert commit.

| Miss                                                                 | Proof the analyzer lacks                                                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `08bf281` `DragDropContext.tsx:83` (peek)                            | A compare-and-set guard: the snapshot is read only as `snap !== v` before `obs$.set(v)` on the same observable          |
| `a7a8e21` `DropdownMenu.tsx:412` (delete state)                      | Constant state: every write passes the initial literal and nothing renders it, so the observer that reads it is dead    |
| `a7a8e21` `PlaybackTimelineSlider.tsx:38`                            | A state read in one host prop, written by an observer, a drag handler, and layout                                       |
| `a7a8e21` `PlaybackControls.tsx:45-48`                               | Value flow through memo-only custom hooks in another module into one JSX element                                        |
| `a7a8e21` `Playlist.tsx:84`                                          | Per-field leaves for a whole-object snapshot read through fixed paths, a memo dependency, and a prop                    |
| `a7a8e21` `Sidebar.tsx:59`, `645718f` `Sidebar.tsx:62`               | Extracting a `.map` row that reads the value, then a per-row boolean selector; `645718f` also needs an owner-work proof |
| `b54f1f4` `AIButtons.tsx:132-133`                                    | Co-writes inside one discrete handler before any `await`, which commit together                                         |
| `ce09c33` `JumpSearchMenuDropdown/hooks.ts:153`                      | Passive-effect reconciliations keyed on the consumer's own inputs, and row-index equality reads                         |
| `248bda3` `PresenterWindow.tsx:489`, `0ea5341` `src/Effect.tsx:65`   | A render-cut proof for a single JSX expression or host prop whose other inputs are constants                            |
| `0ea5341` `src/PresenterWindow.tsx:358`                              | No render read: dependency-only sink effects become observers, and ref mirrors become `peek()`                          |
| `2e57a26` `AmbientAurora.tsx:36`                                     | Animation-frame writes read only in one shader's uniforms                                                               |
| `3447570` `DeckRenderer.tsx:138`, `:260`                             | Split on a subtree replaced wholesale from parsed data; the saving shows in presenter previews, on deck recompiles      |
| `81e856f` `useMarkdownDocumentSession.ts:46-49`                      | Hook returns whose only caller reads one property, or none                                                              |
| `aa999ef` `App.tsx:555`                                              | Mount identity, plus an opaque hint for the native document the observable would store                                  |
| `eb0d9f8` `CodeViewerWindow.tsx:257`                                 | An effect that calls a stable async loader and writes only refs                                                         |
| `f06e018` `DiffViewerWindow.tsx:2307-2309`, `cf061a2` `:2315`        | Observable binding through the model provider, and writes whose co-writes are guarded or equal-value no-ops             |
| `9235a4c` `DiffViewerWindow.tsx:1150`                                | A read that feeds only a boolean, with no ancestor subscribing                                                          |
| `0d7ad12` `DiffViewerWindow.tsx:2964-2965`                           | A single-call-site child contract, and a sibling co-write that renders only inside the gated subtree                    |
| `89514f3` `PlaybackArea.tsx:84`                                      | A write-only state whose setter only a child's hover callback receives                                                  |
| `84cdc0e` `DropdownMenu.tsx:497`, `CurrentSongOverlayWindow.tsx:124` | An observer for a comparison with a `useId` constant, and an effect body with no side effects                           |
| `f7d85c4` `Photo.tsx:22`                                             | A comparison bound to a `const` before it is rendered                                                                   |
| `767e37b` `FeedModal.tsx:31`                                         | A value that appears only in a memo dependency list                                                                     |
| `767e37b` `LibraryModal.tsx:36`, `:41`                               | One subscription per destructured field, since `syncedAt` is written alone                                              |

`3447570` `runtime.tsx:46` was audited in the [Slides parent-tree audit](audit-2026-09-28-slides-parent-tree.md) and is
unchanged.

## Candidate proofs

Each candidate was measured with a deliberately unsound scratch build that bypasses its gate. Every build scanned the
replay parents, the 11 pinned applications, and BBPlayer, an unpinned Legend State app. The counts are upper bounds.
A proof is built only when its audited-correct yield, replay plus pinned, is at least 5. None qualified.

| Proof                                              | Oracle hits                                                                                                                                                                                                                                                | Audited correct                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Narrow a multi-field destructure, field by field   | Replay: `LibraryModal.tsx:36`, `:41`. Pinned: legend-photos `ThemeProvider.tsx:43`, noutube `SettingsTree.tsx:159`. BBPlayer: 0                                                                                                                            | At most 3: the two replay cases plus the unlabeled `SettingsModalTabSync.tsx:15`. `{ light, dark }` reads every field of `customColors`. Every `auth$` write that skips `plan` also writes `user`, so no static sibling write exists for `{ user, plan }`.                                                                                     |
| Split optional-chain reads without a common prefix | Dropping only the optional-chain gate: 0 anywhere. Dropping every gate: replay `DeckRenderer.tsx:138`; pinned hoalu `date-range-picker.tsx:23`, `dialog-provider.tsx:42`, noutube `SettingsBlocklistContent.tsx:132`, nori `SettingsSheetSections.tsx:114` | At most 2: `DeckRenderer.tsx:138` and `:260`, and `:260` also collides with the owner's `width`, `height`, and `aspectRatio` locals. The four pinned hits read every field, read a computed, or have no write that changes an unread field alone.                                                                                              |
| Move down into a `.map` row                        | Replay: `a7a8e21` and `645718f` `Sidebar.tsx`. Pinned: legend-apps `Sidebar.tsx:59`, noutube `MainPageContent.tsx:375`, `SettingsModalTabSettings.tsx:348`                                                                                                 | About 2, or at most 5 with an owner-work proof, which three hits need. A row mounts only when its item renders, so moving a subscription into it is sound only on a plainly seeded observable. `PlaybackControls` also reads lazily persisted settings, falls under the 12-element owner floor, and re-renders with its parent on `isPlaying`. |
| Peek a snapshot-safe callback read                 | 173 pinned, 533 replay                                                                                                                                                                                                                                     | About 3: the compare-and-set guard (`DragDropContext.tsx` in the replay and in pinned legend-music) and the dependency-list-only read (`FeedModal.tsx:31`). The rest are rendered through unclassified flow, read after an `await`, or feed an effect or a revision memo.                                                                      |

## Totals

legend-apps replay labels: enforced 47 → 43, non-enforced 100 → 104, excluded 115. Replay recall is 23/63 enforced
found, with 0/130 non-enforced flagged. Scored hook, group, and practice results are unchanged in every application.
