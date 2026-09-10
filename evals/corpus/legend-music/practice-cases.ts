import type { GoldPracticeCase } from "../contracts.js";

export const legendMusicPracticeCases = [
  {
    action: "replace-legacy-use-value",
    file: "legend-kit/react-native/windowDimensions.tsx",
    line: 40,
    rationale:
      "Legend State documents useValue as the supported replacement for the legacy useSelector hook, with the observable argument unchanged.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    file: "components/LocalAudioPlayer.tsx",
    line: 257,
    rationale: "One player failure publishes error, loading, and playback state together.",
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
    action: "batch-observable-writes",
    file: "components/JumpSearchMenuDropdown/hooks.ts",
    line: 32,
    rationale: "Local and shared search-open flags represent one dropdown transition.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    file: "components/MediaLibrary/TrackList.tsx",
    line: 155,
    rationale: "Changing the sort field and its default direction is one list transition.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    file: "components/Unregistered.tsx",
    line: 27,
    rationale: "Selecting the account page and opening settings is one navigation transition.",
    target: "legend-music",
  },
  {
    action: "batch-observable-writes",
    file: "hooks/usePlaylistSelection.ts",
    line: 43,
    rationale: "Selection membership and its shared nonempty flag publish together.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    file: "components/LocalAudioPlayer.tsx",
    line: 359,
    rationale: "Clearing the player is one five-field state transition.",
    target: "legend-music",
  },
  {
    action: "batch-observable-writes",
    file: "hooks/usePlaylistSelection.ts",
    line: 48,
    rationale: "Selection anchor and focus change as one cursor transition.",
    target: "legend-music",
  },
  {
    action: "batch-observable-writes",
    file: "systems/LibraryState.ts",
    line: 317,
    rationale:
      "Tracks, artists, and albums are one normalized library snapshot; batching preserves sequential helper evaluation.",
    target: "legend-music",
  },
  {
    action: "batch-observable-writes",
    file: "systems/LocalMusicState.ts",
    line: 948,
    rationale: "Starting a scan publishes one six-field status transition.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    file: "components/LocalAudioPlayer.tsx",
    line: 269,
    rationale: "A load failure publishes error, loading, and playback fields on one player object.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    file: "components/LocalAudioPlayer.tsx",
    line: 423,
    rationale: "Starting a track replaces five direct player fields with independent values.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    file: "components/LocalAudioPlayer.tsx",
    line: 771,
    rationale: "Restoring a cached queue publishes its current track and index together.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    file: "components/LocalAudioPlayer.tsx",
    line: 785,
    rationale: "An empty cached queue clears the current track and index together.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    file: "components/LocalAudioPlayer.tsx",
    line: 972,
    rationale: "Reaching the queue end publishes final time and stopped playback together.",
    target: "legend-music",
  },
  {
    action: "batch-observable-writes",
    file: "components/LocalAudioPlayer.tsx",
    line: 1112,
    rationale:
      "A successful load publishes duration, loading, and error fields together while preserving property evaluation order.",
    target: "legend-music",
  },
  {
    action: "batch-observable-writes",
    file: "components/LocalAudioPlayer.tsx",
    line: 1123,
    rationale:
      "A native load error publishes error, loading, and playback fields together while preserving property evaluation order.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    file: "components/LocalAudioPlayer.tsx",
    line: 1169,
    rationale: "Track completion publishes final time and stopped playback together.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    file: "systems/LibraryState.ts",
    line: 52,
    rationale: "Selecting a playlist publishes the view and playlist id on one UI object.",
    target: "legend-music",
  },
  {
    action: "batch-observable-writes",
    file: "systems/LibraryState.ts",
    line: 395,
    rationale:
      "Restoring a library snapshot publishes four fields together while preserving sequential helper evaluation.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    file: "systems/LocalMusicState.ts",
    line: 856,
    rationale: "One scan progress event publishes total and completed roots together.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    file: "systems/LocalMusicState.ts",
    line: 863,
    rationale: "Scan completion publishes root total and progress on one state object.",
    target: "legend-music",
  },
  {
    action: "batch-observable-writes",
    file: "systems/LocalMusicState.ts",
    line: 866,
    rationale:
      "Scan completion publishes track total and progress together while preserving sequential property evaluation.",
    target: "legend-music",
  },
  {
    action: "batch-observable-writes",
    file: "systems/LocalMusicState.ts",
    line: 893,
    rationale:
      "The scan result includes an updater function, so batch preserves its evaluation semantics.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    file: "systems/LocalMusicState.ts",
    line: 933,
    rationale: "A missing-path failure publishes progress, total, and error fields together.",
    target: "legend-music",
  },
  {
    action: "assign-observable-fields",
    file: "systems/LocalMusicState.ts",
    line: 941,
    rationale: "An unavailable-path failure publishes progress, total, and error fields together.",
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
    file: "components/PlaybackControls.tsx",
    line: 47,
    rationale:
      "Playback controls read only library tracks, so sibling library fields should not invalidate the component.",
    target: "legend-music",
  },
  {
    action: "narrow-use-value-subscription",
    file: "components/PlaylistSelector.tsx",
    line: 36,
    rationale:
      "The selector reads only library tracks, making the child observable the exact subscription boundary.",
    target: "legend-music",
  },
  {
    action: "narrow-use-value-subscription",
    file: "components/SkiaText.tsx",
    line: 53,
    rationale:
      "The component destructures only width, so it can subscribe directly to the width child observable.",
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
    action: "batch-observable-writes",
    file: "systems/LocalMusicState.ts",
    line: 139,
    rationale:
      "Clearing cached tracks publishes the scan timestamp, track list, and both counters as one transaction.",
    target: "legend-music",
  },
  {
    action: "batch-observable-writes",
    file: "systems/LocalMusicState.ts",
    line: 972,
    rationale:
      "Scan completion publishes tracks, timestamp, and progress totals together while preserving value evaluation order.",
    target: "legend-music",
  },
  {
    action: "narrow-use-value-subscription",
    file: "theme/ThemeProvider.tsx",
    line: 40,
    rationale:
      "The provider reads only customColors.dark, so sibling color updates should not invalidate it.",
    target: "legend-music",
  },
  {
    action: "move-use-value-down",
    file: "components/PlaybackArea.tsx",
    line: 29,
    rationale:
      "Playback toggles update only the one-icon play surface; subscribing there avoids rerendering the twelve-element playback owner.",
    target: "legend-music",
  },
  {
    action: "move-use-value-down",
    file: "components/PlaybackArea.tsx",
    line: 31,
    rationale:
      "Thumbnail invalidation is consumed only by AlbumArt, so its leaf wrapper can update without rerendering playback controls and metadata.",
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
    file: "visualizer/VisualizerWindow.tsx",
    line: 13,
    rationale:
      "Playback state controls only the two-element stopped overlay, so an always-mounted wrapper can subscribe without rebuilding the visualizer and control panel.",
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
] as const satisfies readonly GoldPracticeCase[];
