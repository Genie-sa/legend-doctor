# Legacy-root event handler transaction audit — September 28, 2026

Detector change: on a workspace that is not proven concurrent-only, `batch-observable-writes` and
`assign-observable-fields` report a review (`candidate`) instead of a `change` when the writes run synchronously inside
a React host event handler. Analysis baseline: `31a4415`. No pin or target changed.

## Runtime evidence

Two Legend writes to separate observables, each read through `useSelector`/`useValue` (a `useSyncExternalStore`
subscription) by one component, measured outside `act`. The React Native rows run the real legacy renderer shipped in
`react-native-macos` (`Libraries/Renderer/implementations/ReactNativeRenderer-dev.js`) on its native event entry point,
`RCTEventEmitter.receiveEvent`, with only the native `UIManager` stubbed.

| Trigger                                                   | React DOM 18.3.1 `ReactDOM.render`, beta.30 and beta.42 | RN-macos 0.76.9 renderer, React 18.3.1, beta.30 | RN-macos 0.78.3 renderer, React 19.0.0, beta.42 |
| --------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| Host event prop handler                                   | 1 render                                                | 1 render                                        | 1 render                                        |
| Handler a child forwards to its host event prop           | 1 render                                                | 1 render                                        | 1 render                                        |
| Native direct event (`onDrop`-style)                      | —                                                       | 1 render                                        | 1 render                                        |
| `setTimeout`                                              | 2 renders, first commits `1/false`                      | 2 renders, first commits `1/false`              | 2 renders, first commits `1/false`              |
| Promise continuation                                      | 2 renders, torn first commit                            | 2 renders, torn first commit                    | 2 renders, torn first commit                    |
| Handler that awaits before writing                        | 2 renders, torn first commit                            | 2 renders, torn first commit                    | 2 renders, torn first commit                    |
| Handler that writes inside `setTimeout`                   | 2 renders, torn first commit                            | 2 renders, torn first commit                    | 2 renders, torn first commit                    |
| `addEventListener` listener                               | 2 renders, torn first commit                            | —                                               | —                                               |
| `unstable_batchedUpdates` or Legend `batch` outside event | 1 render                                                | 1 render                                        | 1 render                                        |

Inside the event, React commits only the final state. A non-React `observe` reading both observables still runs once
per write and sees the intermediate state in every row, as on a concurrent root.

The source shows why. The renderer wraps every native event in `batchedUpdates$1`, whose implementation sets
`executionContext |= BatchedContext` and flushes synchronous work only when it restores `NoContext`. `useSyncExternalStore`
schedules its rerender on the synchronous lane through `forceStoreRerender`, and `scheduleUpdateOnFiber` flushes a
legacy-mode update immediately only when `executionContext === NoContext`. React DOM dispatches every listener through
the same `batchedUpdates`.

`Pressable`'s `onPress` also runs synchronously inside the responder, click, or key event (`Pressability.js` in
`react-native-macos` 0.78.3), but `onPressIn`, `onPressOut`, `onLongPress`, and hover callbacks can fire from timers.
The pinned checkouts carry no `node_modules`, so no component whose source is invisible counts as a host.

## Proof

The writes' function must be reachable only through host event props: an `on*` prop on a lowercase JSX element or on a
module constant created by React Native's `requireNativeComponent`. It may get there directly, through `useCallback`, a
plain `const` alias, a call made before any suspension point in such a handler, or a child component whose destructured
prop reaches only such props. Any other reference fails the proof: an effect, a third-party or unresolved component,
`addEventListener`, an object, or an export. An `await` or `yield` before the writes, a loop in an async handler, or a
timer around the writes also fails it.

## Classification of legacy-root labels

| Application   | Labels | Synchronous React event handler | Outside events | Unknown or mixed callers |
| ------------- | -----: | ------------------------------: | -------------: | -----------------------: |
| legend-music  |     30 |                               5 |             15 |                       10 |
| legend-photos |      4 |                               1 |              2 |                        1 |

- legend-music handlers: `Playlist.tsx:284`, `:500`, `:529` (native `requireNativeComponent` drag events, proven), plus
  `Unregistered.tsx:27` and `MediaLibrary/TrackList.tsx:155` (`Pressable` `onPress`, directly and through the app's
  `Button` and `TableHeader`; unproven, so they stay changes).
- legend-music outside events: `LocalAudioPlayer.tsx:257`, `:269`, `:771`, `:785`, `:1112`, `:1123`, `:1169`
  (post-`await` load failures, cache initialization, and native audio listeners); `LibraryState.ts:317`, `:395`
  (library sync and hydration); `LocalMusicState.ts:139`, `:856`, `:863`, `:866`, `:893`, `:972` (an `onChange`
  listener, native scan callbacks, and post-`await` scan results).
- legend-music unknown or mixed: `JumpSearchMenuDropdown/hooks.ts:32`, `hooks/usePlaylistSelection.ts:43`, `:48`,
  `LocalAudioPlayer.tsx:359`, `:423`, `:972`, `LibraryState.ts:52`, `LocalMusicState.ts:933`, `:941`, `:948`. Each
  function is shared by UI callbacks, keyboard or menu listeners, and system code.
- legend-photos handler: `settings/HotkeySettings.tsx:104` (`Pressable` `onPress`). A `useObserveEffect` there reads both
  `isEditing$` and `accumulatedKeys$`, so separate writes still run it on a torn state and the change stays correct.
- legend-photos outside events: `features/FullscreenPhoto.tsx:175`, `:197` (`measureLayout` and `Animated` callbacks).
- legend-photos unknown: `features/FullscreenPhoto.tsx:118`, an `onLoad` that reaches a native image only through the
  app's `Img` and a React Native `Image` branch.

## Retired labels

Each target keeps its other labels, and the runner lists each review.

| Pinned source                   | Audit                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| legend-music `Playlist.tsx:284` | `handleNativeDragStart` is reached only from an inline `onDragStart` arrow on `TrackDragSource`, which passes the prop to the `RNTrackDragSource` native view. Only `useValue` in `DroppableZone` and `DragDropContext` reads `draggedItem$` and `activeDropZone$`; no observer spans both. |
| legend-music `Playlist.tsx:500` | `handleTrackDragLeave` is passed only as `onTrackDragLeave` to `DragDropView`, which hands it to the `RNDragDrop` native view. Same readers.                                                                                                                                                |
| legend-music `Playlist.tsx:529` | `handleTrackDrop` is passed only as `onTrackDrop` through `DragDropView` to `RNDragDrop`. Nothing before the writes suspends. Same readers.                                                                                                                                                 |

## Per-application deltas

| Application             | Delta                                                     |
| ----------------------- | --------------------------------------------------------- |
| legend-music            | `batch-observable-writes` change 15 → 12, candidate 0 → 3 |
| legend-photos           | 0                                                         |
| hoalu                   | 0                                                         |
| open-webui-react-native | 0                                                         |
| excalidraw              | 0                                                         |
| expensify               | 0                                                         |
| formbricks              | 0                                                         |
| outline                 | 0                                                         |
| legend-apps             | 0                                                         |
| noutube                 | 0                                                         |
| nori                    | 0                                                         |

Expert replay recall stays 23/84, and 0/109 non-enforced cases are flagged.
