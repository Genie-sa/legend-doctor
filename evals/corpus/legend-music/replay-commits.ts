import type { ReplayCommit, ScoredReplayCase } from "../contracts.js";

const repository = "legend-music";
const root = "src";
const effect = "useEffect(() => {";

const observeEffectConversions = {
  cases: [
    {
      expected: "excluded",
      file: "components/CustomSlider.tsx",
      line: 61,
      rationale:
        "isHovered and isDragging still drive the thumb opacity in render, so both subscriptions stay and no render is removed; the observer only starts the thumb animation before commit.",
      source: effect,
    },
    {
      action: "use-observe-effect",
      expected: "non-enforced",
      file: "components/DropdownMenu.tsx",
      line: 414,
      rationale:
        "The effect writes React state and the observer drops the isOpen dependency. That is equivalent only because Sub never sets isOpen to true, a dead-state proof outside the observe-effect contract; deleting the dead state is the real edit.",
      source: effect,
    },
    {
      action: "use-observe-effect",
      expected: "enforced",
      file: "components/DropdownMenu.tsx",
      line: 497,
      rationale:
        "activeSubmenuId is read only by the effect, which sets isOpen to a comparison of that leaf with a useId constant. Observing it re-renders only the SubContent whose isOpen flips instead of every SubContent on each hover.",
      source: effect,
    },
    {
      action: "use-observe-effect",
      expected: "non-enforced",
      file: "components/MediaLibrary/LibraryTree.tsx",
      line: 145,
      rationale:
        "The observer rebuilds the fallback list without the search filter, so the auto-selected item changes while a query is active. A faithful observer needs React dependencies, and dependency-driven observers write libraryUI$ during render.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/MediaLibrary/useLibraryTrackList.ts",
      line: 107,
      rationale:
        "selectedItem and allTracks still feed the rendered track list; the observer adds runs on every tracks change and removes no render.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/Playlist.tsx",
      line: 158,
      rationale:
        "Deletes a perfLog instrumentation effect; removing logging is not a static recommendation.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/Playlist.tsx",
      line: 317,
      rationale:
        "The queue still renders; merging this effect into an observer moves a native window-rect measurement ahead of commit without removing a render.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/Playlist.tsx",
      line: 321,
      rationale:
        "queueLength still renders; the clamp merges into the observer at line 317 and no render is removed.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/Playlist.tsx",
      line: 325,
      rationale:
        "currentIndex and currentTrack still render row state; the observer scrolls before the list commits the new current row.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/Playlist.tsx",
      line: 354,
      rationale: "isPlaying still renders row state, so the observer removes no render.",
      source: effect,
    },
    {
      action: "use-observe-effect",
      expected: "non-enforced",
      file: "media-library/MediaLibraryWindowManager.tsx",
      line: 55,
      rationale:
        "useWindowManager builds a new object every render, so the React effect re-ran window open or close on every render. Dropping that dependency is equivalent only if the native window calls are idempotent.",
      source: effect,
    },
    {
      action: "use-observe-effect",
      equivalents: ["delete-effect"],
      expected: "enforced",
      file: "overlay/CurrentSongOverlayWindow.tsx",
      line: 124,
      rationale:
        "The effect has no side effects because both window-size setters are commented out, so moving the isExiting read out of render and deleting its useValue cannot change output.",
      source: effect,
    },
    {
      action: "use-observe-effect",
      expected: "non-enforced",
      file: "overlay/CurrentSongOverlayWindowManager.tsx",
      line: 54,
      rationale:
        "The observer tracks the whole persisted settings$.overlay.position and the raw window sizes, while the React dependencies compared derived primitives with ?? defaults; an object replacement or an undefined-to-default transition re-runs window placement.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "settings/CustomizeUISettings.tsx",
      line: 108,
      rationale:
        "The playback layout still renders through useNormalizedLayout, so no render is removed.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "settings/CustomizeUISettings.tsx",
      line: 112,
      rationale:
        "The bottom bar layout still renders through useNormalizedLayout, so no render is removed.",
      source: effect,
    },
    {
      action: "use-observe-effect",
      expected: "non-enforced",
      file: "settings/OverlaySettings.tsx",
      line: 31,
      rationale:
        "The draft write moves into the writer's call stack. It keeps the same final draft only because the one writer calls setDurationDraft before the observable write, and a global persisted observable admits other writers.",
      source: effect,
    },
    {
      action: "use-observe-effect",
      expected: "enforced",
      file: "visualizer/VisualizerWindowManager.tsx",
      line: 42,
      rationale:
        "The manager renders null and reads isOpen only in this effect, which drives native window calls. The committed observer also tracks visualizerPreferences$ through a get() before the first await; the sound rewrite peeks it.",
      source: effect,
    },
    {
      action: "use-observe-effect",
      expected: "enforced",
      file: "visualizer/VisualizerWindowManager.tsx",
      line: 72,
      rationale:
        "isPlaying and autoClose are boolean leaves read only by this effect in a null-rendering manager. The sound rewrite peeks isOpen, since tracking it would close a window opened while paused.",
      source: effect,
    },
  ],
  commit: "84cdc0efa853db616fe680b3a220dcc5ccff6bbc",
  parent: "e87d8088386383172eba6854d07c76603654e137",
  repository,
  root,
} as const satisfies ReplayCommit;

type SubscriptionLocation = Pick<ScoredReplayCase, "file" | "line" | "source">;

function deadSubscription(
  { file, line, source }: SubscriptionLocation,
  binding: string,
): ScoredReplayCase {
  return {
    action: "peek-unrendered-use-value",
    expected: "enforced",
    file,
    line,
    rationale: `After the observer conversion ${binding} has no read, so the subscription only re-renders its owner.`,
    source,
  };
}

function persistedSubscription(
  { file, line, source }: SubscriptionLocation,
  store: string,
): ScoredReplayCase {
  return {
    action: "peek-unrendered-use-value",
    expected: "non-enforced",
    file,
    line,
    rationale: `${store} is a createJSONManager store, a synced observable with an async persist plugin that loads on first access. Deleting this unread subscription removes the mount-time activation, so the first later peek() starts the load and reads the default instead of the persisted value, as tests/runtime/lazy-persisted-subscription.test.ts reproduces.`,
    source,
  };
}

const deadUseValueCleanup = {
  cases: [
    deadSubscription(
      {
        file: "components/DropdownMenu.tsx",
        line: 410,
        source: "useValue(state$.activeSubmenuId)",
      },
      "Sub's activeSubmenuId",
    ),
    deadSubscription(
      {
        file: "components/DropdownMenu.tsx",
        line: 494,
        source: "useValue(state$.activeSubmenuId)",
      },
      "SubContent's activeSubmenuId",
    ),
    persistedSubscription(
      {
        file: "media-library/MediaLibraryWindowManager.tsx",
        line: 30,
        source: "useValue(stateSaved$.libraryIsOpen)",
      },
      "stateSaved$",
    ),
    deadSubscription(
      {
        file: "overlay/CurrentSongOverlayWindow.tsx",
        line: 91,
        source: "useValue(currentSongOverlay$.isExiting)",
      },
      "isOverlayExiting",
    ),
    deadSubscription(
      {
        file: "overlay/CurrentSongOverlayWindowManager.tsx",
        line: 33,
        source: "useValue(currentSongOverlay$.isWindowOpen)",
      },
      "isWindowOpen",
    ),
    deadSubscription(
      {
        file: "overlay/CurrentSongOverlayWindowManager.tsx",
        line: 34,
        source: "useValue(currentSongOverlay$.isExiting)",
      },
      "isOverlayExiting",
    ),
    persistedSubscription(
      {
        file: "overlay/CurrentSongOverlayWindowManager.tsx",
        line: 35,
        source: "useValue(settings$.overlay.position)",
      },
      "settings$",
    ),
    deadSubscription(
      {
        file: "overlay/CurrentSongOverlayWindowManager.tsx",
        line: 36,
        source: "useValue(currentSongOverlay$.windowHeight)",
      },
      "windowHeight",
    ),
    deadSubscription(
      {
        file: "overlay/CurrentSongOverlayWindowManager.tsx",
        line: 37,
        source: "useValue(currentSongOverlay$.windowWidth)",
      },
      "windowWidth",
    ),
    deadSubscription(
      {
        file: "visualizer/VisualizerWindowManager.tsx",
        line: 26,
        source: "useValue(visualizerWindowState$.isOpen)",
      },
      "isOpen",
    ),
    persistedSubscription(
      {
        file: "visualizer/VisualizerWindowManager.tsx",
        line: 27,
        source: "useValue(visualizerPreferences$.window.autoClose)",
      },
      "visualizerPreferences$",
    ),
    deadSubscription(
      {
        file: "visualizer/VisualizerWindowManager.tsx",
        line: 28,
        source: "useValue(localPlayerState$.isPlaying)",
      },
      "isPlaying",
    ),
  ],
  commit: "9793642399ced24dc09f4bdb4dd742ef2a6b4406",
  parent: "0b8ab30c55da9e1f1577811d8148e99bb148a104",
  repository,
  root,
} as const satisfies ReplayCommit;

const setupCleanupRationale =
  "The effect owns setup and cleanup; useMount suppresses the development replay and defers cleanup to Legend's dispose, so cleanup ownership changes and no production cost is removed.";

const emptyEffectMounts = {
  cases: [
    {
      action: "use-mount",
      expected: "non-enforced",
      file: "App.tsx",
      line: 37,
      rationale: setupCleanupRationale,
      source: effect,
    },
    {
      action: "use-unmount",
      expected: "non-enforced",
      file: "components/Button.tsx",
      line: 63,
      rationale:
        "A cleanup-only effect clears a ref-held timeout. useUnmount is equivalent in production and removes no cost there; it only drops the development replay, which rests on intent rather than proof.",
      source: "useEffect(() => () => clearTooltipTimeout(), []);",
    },
    {
      action: "use-mount",
      expected: "non-enforced",
      file: "components/DropdownMenu.tsx",
      line: 420,
      rationale: setupCleanupRationale,
      source: effect,
    },
    {
      action: "use-mount",
      expected: "non-enforced",
      file: "systems/keyboard/HookKeyboard.tsx",
      line: 21,
      rationale: setupCleanupRationale,
      source: effect,
    },
    {
      action: "use-mount",
      expected: "non-enforced",
      file: "systems/keyboard/HookKeyboard.tsx",
      line: 42,
      rationale: setupCleanupRationale,
      source: effect,
    },
  ],
  commit: "96b1e2822817e12ba65ec89630e86dd8e700e472",
  parent: "9782c8b7653bc7b71e4bf76d23dd21979d687320",
  repository,
  root,
} as const satisfies ReplayCommit;

const windowListenerRationale =
  "useWindowManager returns a new object each render, so the [windowManager] effect resubscribed on every render; proving the fresh object behaves identically needs cross-module identity reasoning, and useMount moves cleanup to Legend's deferred dispose.";

const windowListenerMounts = {
  cases: [
    {
      action: "use-mount",
      expected: "non-enforced",
      file: "media-library/MediaLibraryWindowManager.tsx",
      line: 41,
      rationale: windowListenerRationale,
      source: effect,
    },
    {
      expected: "excluded",
      file: "media-library/MediaLibraryWindowManager.tsx",
      line: 54,
      rationale: "Restructures an existing observer as an async function; no cost changes.",
      source: "useObserveEffect(() => {",
    },
    {
      action: "use-mount",
      expected: "non-enforced",
      file: "overlay/CurrentSongOverlayWindowManager.tsx",
      line: 35,
      rationale: windowListenerRationale,
      source: effect,
    },
    {
      action: "use-mount",
      expected: "non-enforced",
      file: "visualizer/VisualizerWindowManager.tsx",
      line: 27,
      rationale: windowListenerRationale,
      source: effect,
    },
    {
      expected: "excluded",
      file: "visualizer/VisualizerWindowManager.tsx",
      line: 69,
      rationale:
        "Deletes the auto-close observer together with its preference, which removes a feature.",
      source: "useObserveEffect(() => {",
    },
    {
      action: "use-mount",
      expected: "non-enforced",
      file: "windows/useWindowFocusEffect.ts",
      line: 11,
      rationale:
        "Dropping callback from the dependencies keeps the first render's callback in the listener unless every caller passes a stable function.",
      source: effect,
    },
  ],
  commit: "9347c1b962ed83377d2de003b7803e9cea8df821",
  parent: "e67e1d5ea7b960a7a894e3e3a6d41f9ff801453f",
  repository,
  root,
} as const satisfies ReplayCommit;

const effectMounts = {
  cases: [
    {
      action: "use-observe-effect",
      expected: "non-enforced",
      file: "components/DropdownMenu.tsx",
      line: 101,
      rationale:
        "Replaces a manual onChange subscription. The resubscription it saves depends on the caller's onOpenChange identity, and the observe-effect proof covers useValue snapshots, not listeners.",
      source: effect,
    },
    persistedSubscription(
      {
        file: "components/MediaLibrary/LibraryTree.tsx",
        line: 28,
        source: "useValue(libraryUI$.selectedItem)",
      },
      "libraryUI$",
    ),
    {
      expected: "excluded",
      file: "components/MediaLibrary/useLibraryTrackList.ts",
      line: 108,
      rationale:
        "Removes the clearSelection ref mirror the same author added in 84cdc0e; useObserveEffect already calls the latest closure, and the net change against the pre-replay source is zero.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/PlaybackArea.tsx",
      line: 44,
      rationale:
        "Replaces an onChange effect feeding a formatted observable with a computed useObservable; per-tick work is unchanged, and useObservable(fn) keeps the first currentLocalTime$ prop.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/PlaybackArea.tsx",
      line: 58,
      rationale:
        "The same computed-observable idiom for the duration; per-update work is unchanged.",
      source: effect,
    },
    {
      action: "use-mount",
      expected: "non-enforced",
      file: "components/ResizablePanels.tsx",
      line: 282,
      rationale:
        "Drops eight dependencies, including sizes, order, and context callbacks; equivalent only if every one is stable for the panel's lifetime.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/SkiaText.tsx",
      line: 57,
      rationale: "Removes the text prop from the component API.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/SkiaText.tsx",
      line: 63,
      rationale:
        "Rewrites the text$ listener and fixes its width check, which compared the new text's length with itself and never re-measured.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/Toast.tsx",
      line: 43,
      rationale:
        "The toast still renders; the observer tracks the whole toast object and restarts the animation on any field change.",
      source: effect,
    },
    {
      action: "move-to-event",
      expected: "non-enforced",
      file: "components/TooltipProvider.tsx",
      line: 25,
      rationale:
        "hideTooltip is the only null writer, but when a hide and a show land in one batch the event resets the measured size the effect would keep.",
      source: effect,
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "settings/OverlaySettings.tsx",
      line: 29,
      rationale:
        "Rewrites the draft as a linked observable bound to $TextInput and drops blur normalization, which changes input behavior.",
      source: "useState(String(durationSeconds))",
    },
    {
      action: "use-mount",
      expected: "non-enforced",
      file: "windows/createWindowsNavigator.tsx",
      line: 144,
      rationale:
        "componentWrapper is written only by this effect, always with a component, so the dependency re-run is a proven no-op. The saving is one no-op effect per window mount, and useMount also drops the development replay, which rests on intent.",
      source: effect,
    },
  ],
  commit: "b8eb93ba8ff44b7cf8512812c2b98ba535b9191a",
  parent: "9347c1b962ed83377d2de003b7803e9cea8df821",
  repository,
  root,
} as const satisfies ReplayCommit;

const playlistSubscriptions = {
  cases: [
    {
      expected: "excluded",
      file: "components/LocalAudioPlayer.tsx",
      line: 36,
      rationale: "Gates console.log calls behind __DEV__, which changes logging only.",
      source: 'console.log("Loading track:"',
    },
    {
      expected: "excluded",
      file: "components/LocalAudioPlayer.tsx",
      line: 204,
      rationale:
        "Skips an unchanged duration write; Legend already suppresses notifications for identical primitive sets.",
      source: "localPlayerState$.duration.set(data.duration);",
    },
    {
      action: "peek-unrendered-use-value",
      expected: "enforced",
      file: "components/Playlist.tsx",
      line: 33,
      rationale:
        "TrackItem's whole-object use$(localPlayerState$) has no read, so every row re-rendered on each playback progress tick.",
      source: "use$(localPlayerState$)",
    },
    {
      action: "split-use-value-leaves",
      expected: "enforced",
      file: "components/Playlist.tsx",
      line: 144,
      rationale:
        "Playlist reads only currentIndex and isPlaying from the whole-object subscription, so currentTime ticks re-rendered it; two leaf subscriptions keep every read.",
      source: "use$(localPlayerState$)",
    },
  ],
  commit: "c5aaca535ac8c69989ac9ab7ad53228fa1974c41",
  parent: "26c65688cf2253f09e60ccb8a2c9095b872df107",
  repository,
  root,
} as const satisfies ReplayCommit;

const playbackTimeMemo = {
  cases: [
    {
      expected: "excluded",
      file: "components/CustomSlider.tsx",
      line: 127,
      rationale: "Removes a Reanimated style from the thumb, a visual change.",
      source: "trackAnimatedStyle,",
    },
    {
      expected: "excluded",
      file: "components/PlaybackArea.tsx",
      line: 67,
      rationale:
        "Splits one Memo in two; the time Memo still renders every tick, so no render is removed.",
      source: "<Memo>",
    },
  ],
  commit: "fe1f37e7c3e4d42719c8996f4ce765a195df5e3f",
  parent: "843904f7285d0e71f1dae8970de5091d50348a62",
  repository,
  root,
} as const satisfies ReplayCommit;

const playbackAreaObservables = {
  cases: [
    {
      action: "move-use-value-down",
      expected: "non-enforced",
      file: "components/PlaybackArea.tsx",
      line: 14,
      rationale:
        "currentTime renders as text and as the slider value, so the cut needs a Memo leaf plus observable props on CustomSlider, which changes that component's API.",
      source: "use$(localPlayerState$)",
    },
    {
      expected: "excluded",
      file: "components/CustomSlider.tsx",
      line: 38,
      rationale:
        "Rebuilds the slider around observable props; dragging now writes the playback time observable directly, which changes seek behavior.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/MainContainer.tsx",
      line: 23,
      rationale:
        "Mounts the YouTube Music player only when its setting is enabled, a product behavior change.",
      source: "<YouTubeMusicPlayer />",
    },
  ],
  commit: "44614cc1f958bbc073d09bed205a7cf457a02d49",
  parent: "8308a5bf03415ec47d087fb4ab86bc9af086b914",
  repository,
  root,
} as const satisfies ReplayCommit;

const hoverGatedTime = {
  cases: [
    {
      expected: "excluded",
      file: "components/PlaybackArea.tsx",
      line: 18,
      rationale:
        "CurrentTime switches to imperative setNativeProps and hover-gated display, a UX change.",
      source: "const CurrentTime = memo(",
    },
    {
      expected: "excluded",
      file: "components/PlaybackArea.tsx",
      line: 80,
      rationale: "isLoading's only render read is a perfLog call the commit deletes.",
      source: "use$(localPlayerState$.isLoading)",
    },
    {
      action: "move-use-value-into-child",
      expected: "non-enforced",
      file: "components/PlaybackArea.tsx",
      line: 83,
      rationale:
        "duration feeds a render-phase perfLog and a CurrentTime prop; moving it needs the log deleted and CurrentTime's props redesigned.",
      source: "use$(localPlayerState$.duration)",
    },
    {
      action: "use-observable",
      equivalents: ["delete-unused-state", "use-ref"],
      expected: "enforced",
      file: "components/PlaybackArea.tsx",
      line: 84,
      rationale:
        "isSliderHovered is written from CustomSlider hover handlers and one effect but never read, so every hover change re-rendered PlaybackArea for nothing.",
      source: "useState(false)",
    },
  ],
  commit: "89514f39256ea893424c73c7f4f401425c7b1ce7",
  parent: "a145dcec2379519aff576b90801579af908f5a5a",
  repository,
  root,
} as const satisfies ReplayCommit;

const windowHoverTimeline = {
  cases: [
    {
      expected: "excluded",
      file: "components/PlaybackArea.tsx",
      line: 41,
      rationale: "Shows the time readouts only while the window is hovered, a UX change.",
      source: "const CurrentTime = memo(",
    },
  ],
  commit: "01ef26d900f379e1cb3eac98ea7b9c8e48b2046d",
  parent: "05d79e2da13ebf2f02f2f174f58b45244c316517",
  repository,
  root,
} as const satisfies ReplayCommit;

/** Every hunk of Jay Meistrich's performance commits, classified against the parent tree. */
export const legendMusicReplayCommits: readonly ReplayCommit[] = [
  playbackAreaObservables,
  playlistSubscriptions,
  playbackTimeMemo,
  hoverGatedTime,
  observeEffectConversions,
  deadUseValueCleanup,
  emptyEffectMounts,
  windowListenerMounts,
  effectMounts,
  windowHoverTimeline,
];
