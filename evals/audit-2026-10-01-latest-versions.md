# Latest-versions baseline audit — October 1, 2026

Policy change: legend-doctor supports only current releases. Every analysis assumes React 19 or later, the React Native
New Architecture, current Expo and Next.js, and the latest `@legendapp/state` v3, where `useValue` exists and `use$` and
`useSelector` are legacy aliases of it. The capability probes for installed or locked Legend State versions, concurrent
DOM roots, the Native architecture, and legacy-root host-event dispatch are deleted. React Compiler detection stays: it
is a per-project configuration fact, not version support. Analysis baseline: `9a9ff81`. No pin or target changed.

This supersedes the version and root findings of the [September 28 audit](audit-2026-09-28.md), the
[lockfile version audit](audit-2026-09-28-lockfile-versions.md), and the
[legacy-root handler audit](audit-2026-09-28-legacy-root-handlers.md). The
[split-commit audit](audit-2026-09-28-split-commits.md) still holds: a companion write that a promise settlement resumes
in another function commits in a separate render even under React 19.

## Renderer facts

- React 19 renders every update from one synchronous stretch in one commit; an observable's `useSyncExternalStore`
  notification and a `useState` update in the same stretch no longer split. Converting one co-written state alone
  tears nothing unless the writes settle apart.
- A Legend `batch` or `assign` therefore never removes a React render. It pays off only when a non-React observer
  (`observe`, `useObserveEffect`, a computed, or an `onChange` listener) reads several of the written paths and would
  otherwise run once per write, on torn state in between. Persistence already saves the writes together.
- `replace-legacy-use-value` is a style edit on every pin: `useValue` is an alias of `useSelector`, so the rename
  changes no subscription.

## Transaction labels

Each label was audited for a non-React observer that reads two or more of the written paths. The
[tracker gate](#same-file-tracker-gate) below proves the same-file case; the other known misses need a cross-file proof.

| Pinned source                                                                                                                                                                                                                                                                                                                         | Relabel      | Audit                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| legend-music `LocalAudioPlayer.tsx:359`                                                                                                                                                                                                                                                                                               | `known-miss` | `Playlist.tsx:319` reads currentIndex and currentTrack; `CurrentSongOverlayController.tsx:16` reads currentTrack and isPlaying.                                                    |
| legend-music `LocalAudioPlayer.tsx:771`, `:785`                                                                                                                                                                                                                                                                                       | `known-miss` | The `Playlist.tsx:319` scroll observer reads the index and track both transitions write; torn state skips the scroll.                                                              |
| legend-music `systems/LibraryState.ts:52`                                                                                                                                                                                                                                                                                             | `known-miss` | `useLibraryTrackList.ts:543` reads selectedView and selectedPlaylistId.                                                                                                            |
| legend-music `MediaLibrary/TrackList.tsx:155`                                                                                                                                                                                                                                                                                         | `known-miss` | `useLibraryTrackList.ts:543` reads playlistSort and playlistSortDirection.                                                                                                         |
| legend-photos `settings/HotkeySettings.tsx:104`                                                                                                                                                                                                                                                                                       | enforced     | The `useObserveEffect` at line 110 reads isEditing$ and accumulatedKeys$; a torn run can save stale keys. Enforced by the tracker gate.                                            |
| legend-music `LocalAudioPlayer.tsx:257`, `:269`, `:423`, `:972`, `:1112`, `:1123`, `:1169`; `JumpSearchMenuDropdown/hooks.ts:32`; `Unregistered.tsx:27`; `usePlaylistSelection.ts:43`, `:48`; `systems/LibraryState.ts:317`, `:395`; `systems/LocalMusicState.ts:139`, `:856`, `:863`, `:866`, `:893`, `:933`, `:941`, `:948`, `:972` | retired      | No non-React observer reads two of the written paths: only React consumers, single-path `onChange` listeners, and debounced persistence, so React already renders the writes once. |
| legend-photos `features/FullscreenPhoto.tsx:118`, `:175`, `:197`                                                                                                                                                                                                                                                                      | retired      | Same audit: only React consumers read the written paths.                                                                                                                           |

Deleting a retired label makes the corpus assert absence: a later `change` finding there fails as unlabeled.

## Same-file tracker gate

A transaction finding is now emitted, as a `change`, only when one tracker in the same file reads two or more of the
written paths: the synchronous `get()` calls in an `observe`, `useObserve`, `useObserveEffect`, or `useComputed` body, or
an `onChange` listener on a parent of the written paths. Otherwise nothing is emitted; the transaction review is gone.

- legend-photos `settings/HotkeySettings.tsx:104`: `known-miss` → enforced `batch-observable-writes`. The tracker is
  the `useObserveEffect` at line 110, in the same component.
- The five legend-music known misses stay: each spanning observer lives in another file (`Playlist.tsx`,
  `CurrentSongOverlayController.tsx`, `useLibraryTrackList.ts`).
- Not proven yet: trackers in another module, and `computed()` observables.

Scored corpus, base `566aebb`: practice precision 99.5% (753/757 → 754/758), known practice misses 6/6 → 5/5, unscored
transaction reviews 198 → 0. Hook precision and recall and expert replay recall are unchanged.

| Application                                | Whole-application delta                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| legend-photos                              | `batch-observable-writes` review 4 → 0, change 0 → 1                              |
| legend-music                               | `assign-observable-fields` review 15 → 0; `batch-observable-writes` review 15 → 0 |
| legend-apps                                | `assign-observable-fields` review 19 → 0; `batch-observable-writes` review 19 → 0 |
| noutube                                    | `assign-observable-fields` review 12 → 0; `batch-observable-writes` review 7 → 0  |
| nori                                       | `assign-observable-fields` review 3 → 0; `batch-observable-writes` review 7 → 0   |
| hoalu                                      | `batch-observable-writes` review 2 → 0                                            |
| open-webui-react-native                    | `batch-observable-writes` review 1 → 0                                            |
| gptme                                      | `assign-observable-fields` review 9 → 0; `batch-observable-writes` review 20 → 0  |
| zenborg                                    | `assign-observable-fields` review 18 → 0; `batch-observable-writes` review 21 → 0 |
| junto                                      | `assign-observable-fields` review 9 → 0; `batch-observable-writes` review 32 → 0  |
| excalidraw, expensify, formbricks, outline | none                                                                              |

## Hook labels

| Pinned source                                       | Relabel                                  | Audit                                                                                                                                           |
| --------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| gptme `settings/ServerApiKeySettings.tsx:39` apiKey | `review-state` → `use-observable`        | The post-await clear at line 98 and the `finally` reset of `isSaving` at line 108 commit in one render; only the Input and Save button read it. |
| gptme `TaskCreationDialog.tsx:44` isLoading         | non-enforced → enforced `use-observable` | `setIsLoading(false)` at line 77 commits with the form reset at lines 65-73; only the Create Task button reads the flag.                        |
| gptme `SetupWizard.tsx:163` apiKey                  | non-enforced → enforced `use-observable` | The post-await clear at line 546 commits with any `step` write in that stretch; only the Input and Save button read the draft.                  |

## Legacy hook labels

| Pinned source                                        | Relabel                       | Audit                                                                                         |
| ---------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| legend-photos, 39 `replace-legacy-use-value` sites   | added, `disposition: "style"` | The pin locks `3.0.0-beta.30`; on the supported latest v3 the rename changes no subscription. |
| gptme `webui`, 97 `replace-legacy-use-value` sites   | `change` → `style`            | The pin locks `3.0.0-beta.30`; on the supported latest v3 the rename changes no subscription. |
| open-webui `form-chat-input/component.tsx:79`, `:80` | added, `disposition: "style"` | The pin locks `2.1.15`; on the supported latest v3 the rename changes no subscription.        |

## Whole-application deltas

Base `9a9ff81` against this change, `legend-doctor <root>` on each pinned checkout.

| Application                                                                                   | Delta                                                                                                           |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| legend-music                                                                                  | `assign-observable-fields` change 15 → 0, review 0 → 15; `batch-observable-writes` change 12 → 0, review 3 → 15 |
| legend-photos                                                                                 | `batch-observable-writes` change 4 → 0, review 0 → 4; `replace-legacy-use-value` style 0 → 39                   |
| open-webui-react-native                                                                       | `replace-legacy-use-value` style 0 → 17 (2 inside the labeled target)                                           |
| gptme                                                                                         | `replace-legacy-use-value` change 97 → style 97; `review-state` 182 → 179; `use-observable` 30 → 33             |
| excalidraw, expensify, formbricks, outline, hoalu, legend-apps, noutube, nori, zenborg, junto | none                                                                                                            |

Scored corpus: actionable precision 93.5% (286/306 → 289/309), actionable recall 88.0% → 88.4% (286/325 → 289/327),
Legend practice precision 99.4% → 99.5% (646/650 → 753/757), known practice misses 0/0 → 6/6, expert replay recall
unchanged at 22/63.
