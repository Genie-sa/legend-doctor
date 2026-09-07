import type { GoldHookCase } from "../contracts.js";

export const legendMusicHookCases = [
  {
    action: "review-state",
    file: "components/AlbumArt.tsx",
    hook: "useState",
    line: 153,
    name: "isLoading",
    rationale:
      "The download effect sets loading before awaiting, and clears it on both success and catch while also writing imageUri. The suspension and partial exception paths do not establish one synchronous atomic transition across these writes.",
    target: "legend-music",
  },
  {
    action: "use-observable",
    file: "components/PlaybackControls.tsx",
    hook: "useState",
    line: 50,
    name: "layoutWidth",
    rationale:
      "The deduplicated search branch is the only render consumer, so an owner-scoped observable can update one stable leaf without invalidating every playback control.",
    target: "legend-music",
  },
  {
    action: "use-observable",
    file: "components/PlaylistSelector.tsx",
    hook: "useState",
    line: 39,
    name: "layoutWidth",
    rationale:
      "The deduplicated search branch is the only render consumer, so an owner-scoped observable can update one stable leaf without invalidating the playlist owner.",
    target: "legend-music",
  },
  {
    action: "use-value",
    file: "components/DropdownMenu.tsx",
    hook: "useState",
    line: 492,
    name: "isOpen",
    rationale:
      "The React boolean is written only by a Legend reaction and mirrors an observable selector.",
    target: "legend-music",
  },
  {
    action: "keep-effect",
    file: "components/dnd/DroppableZone.tsx",
    hook: "useEffect",
    line: 52,
    name: null,
    rationale: "The effect owns an external registration and cleanup.",
    target: "legend-music",
  },
  {
    action: "keep-effect",
    file: "components/HotkeyCapture.tsx",
    hook: "useEffect",
    line: 126,
    name: null,
    rationale: "The effect owns native and observable subscriptions with teardown.",
    target: "legend-music",
  },
  {
    action: "keep-effect",
    file: "components/AlbumArt.tsx",
    hook: "useEffect",
    line: 156,
    name: null,
    rationale: "The async resource lifecycle has stale-result protection and cleanup.",
    target: "legend-music",
  },
  {
    action: "keep-effect",
    file: "settings/SettingsContainer.tsx",
    hook: "useEffect",
    line: 66,
    name: null,
    rationale:
      "The useValue result also renders the selected sidebar item, so an observable reaction keeps the subscription and only moves the window-title write ahead of commit.",
    target: "legend-music",
  },
  {
    action: "keep-effect",
    file: "components/SavePlaylistDropdown.tsx",
    hook: "useEffect",
    line: 54,
    name: null,
    rationale:
      "A second cleanup-owning effect also reads the same useValue result, so converting only this effect keeps the subscription and the owner render.",
    target: "legend-music",
  },
  {
    action: "review-state",
    file: "components/SavePlaylistDropdown.tsx",
    hook: "useState",
    line: 21,
    name: "isSaving",
    rationale:
      "The async guard renders transitively through canSave(), so replacing it with a ref would leave the Save button stale.",
    target: "legend-music",
  },
  {
    action: "keep-effect",
    file: "components/SkiaSpinner.tsx",
    hook: "useEffect",
    line: 52,
    name: null,
    rationale:
      "The spinner effect reads only a Reanimated shared value and a speed prop; no local React state or Legend binding participates, so no state migration in this owner can change its inputs or schedule.",
    target: "legend-music",
  },
  {
    action: "review-state",
    file: "components/DropdownMenu.tsx",
    hook: "useState",
    line: 409,
    name: "isOpen",
    rationale:
      "The value is captured by a Legend lifecycle callback; replacing React state with a ref has no proven render benefit and may change reaction invalidation timing.",
    target: "legend-music",
  },
  {
    action: "use-ref",
    file: "components/PlaybackTimelineSlider.tsx",
    hook: "useState",
    line: 44,
    name: "sliderWidth",
    rationale: "Layout width is read only by deferred gesture commands and never renders UI.",
    target: "legend-music",
  },
  {
    action: "delete-unused-state",
    enforced: false,
    file: "components/AlbumArt.tsx",
    hook: "useState",
    line: 154,
    name: "_hasError",
    rationale: "The setter causes renders, but the assigned error value is never consumed.",
    // The owner also renders calls or mutable reads; independent refresh is not yet proven.
    target: "legend-music",
  },
  {
    action: "review-state",
    file: "components/dnd/DraggableItem.tsx",
    hook: "useState",
    line: 44,
    name: "_layout",
    rationale:
      "The layout event writes childMeasurementsRef.current and setLayout; the portal reads that ref for its mount condition and dimensions. No proof establishes that another state update always refreshes those reads, so deleting the unread layout state is unsafe.",
    target: "legend-music",
  },
  ...[
    ["components/Playlist.tsx", 103, "isDragOver", "use-observable"],
    ["components/JumpSearchMenuDropdown/hooks.ts", 153, "highlightedIndex", "use-observable"],
    ["components/MediaLibrary/Sidebar.tsx", 67, "activeNativeDropPlaylistId", "use-observable"],
  ].map(([file, line, name, action]) => ({
    action: action as "use-observable",
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "A hot large owner can keep a stable handle while the exact row or drop surface subscribes.",
    target: "legend-music",
  })),
  ...[
    [65, "tempPlaylistId"],
    [66, "tempPlaylistName"],
    [68, "editingPlaylistId"],
    [69, "editingPlaylistName"],
  ].map(([line, name]) => ({
    action: "use-observable" as const,
    file: "components/MediaLibrary/Sidebar.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "The id and name form one create-or-rename transaction across the header, alternate platform rows, and async finalizer; migrate each pair as one owner-lifetime observable model, preserve paired transitions with atomic assignments, and subscribe only at leaf reads.",
    target: "legend-music",
  })),
  {
    action: "use-observable",
    file: "components/MediaLibrary/Sidebar.tsx",
    hook: "useState",
    line: 71,
    name: "outerWidth",
    rationale:
      "NativeSidebar source proves that onLayout is deferred to its native layout event; the numeric measurement is written alone and rendered only through two bounded, non-repeated width projections inside the native branch, so separate leaf subscribers avoid rebuilding the full sidebar while preserving the platform branch and callback timing.",
    target: "legend-music",
  },
  {
    action: "keep-effect",
    file: "components/JumpSearchMenuDropdown.tsx",
    hook: "useEffect",
    line: 82,
    name: null,
    rationale:
      "The effect focuses an input only after React commits its conditional mount; an observable reaction cannot replace that commit ordering.",
    target: "legend-music",
  },
  {
    action: "use-observable",
    file: "components/PlaybackArea.tsx",
    hook: "useState",
    line: 35,
    name: "isHovered",
    rationale:
      "The React Native hover events change one data prop on the stable root View; a reactive native component can update that prop without rebuilding the twelve-element playback owner.",
    target: "legend-music",
  },
  {
    action: "keep-effect",
    file: "components/JumpSearchMenuDropdown/hooks.ts",
    hook: "useEffect",
    line: 170,
    name: null,
    rationale:
      "The cursor reset effect only writes `highlightedIndex`, whose own finding migrates it to an observable while keeping every effect; the effect stays and its setter calls become observable writes.",
    target: "legend-music",
  },
] as const satisfies readonly GoldHookCase[];
