import type { GoldPracticeCase } from "../contracts.js";

export const legendMusicPracticeCases = [
  {
    action: "replace-legacy-use-value",
    disposition: "style",
    file: "legend-kit/react-native/windowDimensions.tsx",
    line: 40,
    rationale:
      "The pinned bun.lock resolves @legendapp/state 3.0.0-beta.42, whose useValue is an alias of useSelector: the rename changes no subscription.",
    target: "legend-music",
  },
  {
    action: "use-peek-for-snapshot",
    file: "components/NativeSidebar.tsx",
    line: 53,
    rationale:
      "The React effect compares one current observable snapshot before synchronizing the local selection handle.",
    target: "legend-music",
  },
  {
    action: "use-peek-for-snapshot",
    file: "components/TitleBar.tsx",
    line: 31,
    rationale:
      "The hover event checks the current preference without creating a Legend dependency.",
    target: "legend-music",
  },
  {
    action: "use-peek-for-snapshot",
    file: "components/TitleBar.tsx",
    line: 39,
    rationale:
      "The hover-leave event checks the current preference without creating a Legend dependency.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    enforced: "known-miss",
    file: "components/MediaLibrary/TrackList.tsx",
    line: 155,
    rationale:
      "Known miss (non-React observer): the observer at hooks/useLibraryTrackList.ts:543 reads playlistSort and playlistSortDirection, so separate writes resort the list once on torn state.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    enforced: "known-miss",
    file: "components/LocalAudioPlayer.tsx",
    line: 359,
    rationale:
      "Known miss (non-React observer): the useObserveEffect at components/Playlist.tsx:319 reads currentIndex and currentTrack, and the observer at components/CurrentSongOverlayController.tsx:16 reads currentTrack and isPlaying, so separate writes run them on torn state; the analyzer does not yet prove an observer spans the written paths.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    enforced: "known-miss",
    file: "components/LocalAudioPlayer.tsx",
    line: 771,
    rationale:
      "Known miss (non-React observer): the Playlist scroll observer at components/Playlist.tsx:319 reads the index and track this transition writes, so a separate write runs it on torn state and skips scrolling to the new index.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    enforced: "known-miss",
    file: "components/LocalAudioPlayer.tsx",
    line: 785,
    rationale:
      "Known miss (non-React observer): the Playlist scroll observer at components/Playlist.tsx:319 reads the index and track this transition writes, so separate writes run it twice, once on torn state.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    enforced: "known-miss",
    file: "systems/LibraryState.ts",
    line: 52,
    rationale:
      "Known miss (non-React observer): the observer at hooks/useLibraryTrackList.ts:543 reads selectedView and selectedPlaylistId, so separate writes rebuild the track list once on torn state.",
    target: "legend-music",
  },
  {
    action: "pass-observable-to-use-value",
    disposition: "style",
    file: "components/TrackItem.tsx",
    line: 62,
    rationale:
      "At the pinned source, this synchronous selector without options returns only themeState$.customColors.dark.accent.primary.get(). Direct input selects the same value; subscription ownership can depend on observer context. No independent render or lifecycle saving is proven, so this is style.",
    target: "legend-music",
  },
  {
    action: "pass-observable-to-use-value",
    disposition: "style",
    file: "components/MediaLibrary/TrackList.tsx",
    line: 438,
    rationale:
      "At the pinned source, this synchronous selector without options returns only themeState$.customColors.dark.accent.primary.get(). Direct input selects the same value; subscription ownership can depend on observer context. No independent render or lifecycle saving is proven, so this is style.",
    target: "legend-music",
  },
  {
    action: "use-peek-for-snapshot",
    file: "legend-kit/react-native/windowDimensions.tsx",
    line: 30,
    rationale:
      "The source-proven HookToObservable contract invokes getValue only from a React layout effect, so the settings check needs a non-tracking snapshot.",
    target: "legend-music",
  },
  {
    action: "use-peek-for-snapshot",
    file: "components/ResizablePanels.tsx",
    line: 285,
    rationale:
      "The imported Legend useMount callback is a non-tracking lifecycle effect, so the initial panel-size read needs a snapshot rather than a reactive dependency.",
    target: "legend-music",
  },
  {
    action: "narrow-use-value-subscription",
    disposition: "change",
    file: "components/PlaybackControls.tsx",
    line: 47,
    rationale:
      "Playback controls read only library tracks, while the librarySettings$.lastScanTime listener in LibraryState.ts writes library$.lastScanTime alone after every scan and rerenders the whole-library subscriber.",
    target: "legend-music",
  },
  {
    action: "narrow-use-value-subscription",
    disposition: "change",
    file: "components/PlaylistSelector.tsx",
    line: 36,
    rationale:
      "The selector reads only library tracks, while the librarySettings$.lastScanTime listener in LibraryState.ts writes library$.lastScanTime alone after every scan and rerenders the whole-library subscriber.",
    target: "legend-music",
  },
  {
    action: "use-peek-for-snapshot",
    file: "components/DropdownMenu.tsx",
    line: 422,
    rationale:
      "The direct observable onChange listener reads the latest dropdown flag as a snapshot and does not establish another tracked dependency.",
    target: "legend-music",
  },
  {
    action: "use-peek-for-snapshot",
    file: "systems/LocalMusicState.ts",
    line: 1334,
    rationale:
      "The library-path onChange listener snapshots the independent scanning flag before deciding whether to start a scan.",
    target: "legend-music",
  },
  ...[145, 146, 155, 156].map((line): GoldPracticeCase => ({
    action: "use-peek-for-snapshot",
    file: "components/PlaybackTimelineSlider.tsx",
    line,
    rationale:
      "The hover command reads the latest disabled flag without creating a reactive dependency.",
    target: "legend-music",
  })),
  {
    action: "move-use-value-down",
    file: "components/PlaybackArea.tsx",
    line: 29,
    rationale:
      "Playback toggles update only the one-icon play surface. Independent class projections call the source-visible cn wrapper, which only composes clsx/twMerge with primitive literal/conditional arguments; argument reads remain subject to snapshot checks. Render-count instrumentation measures the removed work rather than owning UI state.",
    target: "legend-music",
  },
  {
    action: "move-use-value-down",
    file: "components/PlaybackArea.tsx",
    line: 31,
    rationale:
      "Thumbnail invalidation is consumed only by AlbumArt. The independent cn wrapper is source-proven class composition with primitive arguments, not an arbitrary helper exemption; all argument reads and other owner snapshots still need validation.",
    target: "legend-music",
  },
  {
    action: "move-use-value-down",
    file: "settings/GeneralSettings.tsx",
    line: 14,
    rationale:
      "The enabled flag is transported only to HotkeyCapture inside a stable one-element leaf of the twenty-element settings owner.",
    target: "legend-music",
  },
  {
    action: "move-use-value-down",
    file: "settings/GeneralSettings.tsx",
    line: 15,
    rationale:
      "The hotkey value is transported only to HotkeyCapture, so updates need not rerender unrelated settings sections.",
    target: "legend-music",
  },
  {
    action: "move-use-value-down",
    disposition: "change",
    file: "settings/GeneralSettings.tsx",
    line: 16,
    rationale:
      "The error subscription is read only by HotkeyCapture.className and its adjacent conditional error Text inside the stable View at line 58. One wrapper retains all reads and ordinary hotkey inputs while skipping the other settings sections; there are no event or effect consumers.",
    target: "legend-music",
  },
  {
    action: "move-use-value-down",
    file: "visualizer/VisualizerWindow.tsx",
    line: 13,
    rationale:
      "Playback state controls only the two-element stopped overlay. The independent bin-count subscription has a source-proven numeric domain and a nullish-default derivation; its unshadowed String conversion cannot invoke object coercion. Moving playback into an always-mounted wrapper preserves that independent input and the control panel.",
    target: "legend-music",
  },
  {
    action: "move-use-value-down",
    disposition: "change",
    file: "visualizer/VisualizerWindow.tsx",
    line: 15,
    rationale:
      "The numeric bin-count subscription has only the pure nullish-default derivation at line 16, consumed by PresetComponent.binCountOverride and Select.value. Two stable call-site wrappers cover every read, keep the dynamic preset component as a parent prop, and avoid rerendering track metadata and preset controls; callbacks write through the observable handle.",
    target: "legend-music",
  },
  {
    action: "split-use-value-leaves",
    file: "components/JumpSearchMenuDropdown.tsx",
    line: 42,
    rationale:
      "The dropdown consumes only library.albums and library.artists, so unrelated library fields should not invalidate it.",
    target: "legend-music",
  },
  {
    action: "split-use-value-leaves",
    file: "settings/LibrarySettings.tsx",
    line: 30,
    rationale:
      "Scan progress fields update at a different cadence than tracks and isScanning, and every read is a static leaf path.",
    target: "legend-music",
  },
  {
    action: "peek-unrendered-use-value",
    file: "components/Playlist.tsx",
    line: 87,
    rationale:
      "isPlayerActive only seeds wasPlayingRef, which an observe effect refreshes later, so every play or pause rerenders the queue for a value no render reads.",
    target: "legend-music",
  },
  {
    action: "use-peek-for-snapshot",
    disposition: "style",
    file: "components/Playlist.tsx",
    line: 509,
    rationale:
      "The native drag-hover handler reads the zone checkDropZones just hit-tested; the handler is no tracking context.",
    target: "legend-music",
  },
  {
    action: "use-peek-for-snapshot",
    disposition: "style",
    file: "components/Playlist.tsx",
    line: 525,
    rationale:
      "The native drop handler snapshots the hit-tested zone to pick the drop index; the handler is no tracking context.",
    target: "legend-music",
  },
] as const satisfies readonly GoldPracticeCase[];
