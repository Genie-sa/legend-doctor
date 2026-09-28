# In-place memo key audit — September 28, 2026

Rule: `snapshot-mutated-use-value`. A `const x = useValue(source$)` whose raw result keys a `useMemo`, while an indexed
write mutates `source$` in place below the path the memo reads. Analysis baseline: `7f01394`. No pin, target, or label
changed.

## Runtime evidence

`tests/runtime/in-place-memo-identity.test.ts` mounts the pattern under jsdom with the pinned React and Legend State,
with and without StrictMode. For `push`, `splice`, an element field `set`, `assign`, and a member `delete`, the owner
rerenders and the memo keyed on the raw result renders its previous output. Selecting a copy inside `useValue` renders
the new contents in every case. Both `3.0.0-beta.48` and `2.1.15` rerender on the same reference through the selector
rule `newValue !== prev || (!isPrimitive(newValue) && newValue === value)`.

## Pinned candidates

The pinned corpus produces no `change` finding. Candidates are not precision-scored and cannot carry labels.

| Source                                                 | Audit                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| legend-music `MediaLibrary/TrackList.tsx:71`           | Masked. The only in-place write, `Sidebar.tsx:92` `push`, runs in a handler that also calls `selectLibraryPlaylist` |
| legend-music `MediaLibrary/useLibraryTrackList.ts:460` | Masked by the same handler: `selectedPlaylistId`, a memo dependency, changes in the same event batch                |

## Replay evidence

Three public Legend-native applications fixed this bug by hand. Running the rule at each fix's parent commit and at the
fix commit:

| Repository      | Fix commit | `change` at parent, gone at fix                                                                                               | Real `candidate` at parent, gone at fix                                                                       |
| --------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| nonbili/NouTube | `c6aebca`  | `FeedEditorSheet.tsx:33`                                                                                                      | `BookmarkModal.tsx:29`                                                                                        |
| nonbili/meron   | `4c32e58`  | none                                                                                                                          | `KanbanBoardColumn.tsx:87`, `KanbanColumnMinimized.tsx:39`, `KanbanView.tsx:39`, `SearchScopeDropdown.tsx:26` |
| nonbili/Nora    | `2ead1fc`  | `DesktopWorkspace.native.tsx:24`, `DesktopWorkspace.tsx:19`, `DesktopTabsSidebar.native.tsx:366`, `DesktopTabsSidebar.tsx:39` | none                                                                                                          |

Candidates present at both commits: NouTube `HistoryModal.tsx:23`, whose memo keys on `bookmarks.length` as a
workaround; meron `MessagePane.tsx:49` and `:58`, whose `compose.ts:1040` push has no co-write and may be real; Nora's
four `tabs$.orders` sites, which key on a `tabIdsKey` workaround, and `SavedViewsPicker.tsx:33`.

## Per-application deltas

| Application             | Delta                                        |
| ----------------------- | -------------------------------------------- |
| legend-music            | `snapshot-mutated-use-value` candidate 0 → 2 |
| legend-photos           | 0                                            |
| hoalu                   | 0                                            |
| open-webui-react-native | 0                                            |
| excalidraw              | 0                                            |
| expensify               | 0                                            |
| formbricks              | 0                                            |
| outline                 | 0                                            |

Unpinned: NouTube gains one candidate, `HistoryModal.tsx:24`, which is the workaround site above. legend-apps, Nori, and
BBPlayer are unchanged.
