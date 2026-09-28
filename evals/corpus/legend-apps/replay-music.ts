import type { ReplayCommit } from "../contracts.js";

const repository = "legend-apps";
const musicRoot = "apps/music/src";
const observeEffect = "useObserveEffect(() => {";

const playbackControlSubscriptions = {
  cases: [
    {
      action: "split-use-value-leaves",
      expected: "non-enforced",
      file: "components/PlaybackControls.tsx",
      line: 45,
      rationale:
        "Only tracks and playlists are read, so scan progress ticks re-rendered the controls, but the whole object also feeds usePlaylistOptions, whose parameter is typed as the full LocalMusicState; the split needs that hook's signature changed in another module.",
      source: "useValue(localMusicState$)",
    },
    {
      action: "narrow-use-value-subscription",
      expected: "enforced",
      file: "components/PlaybackControls.tsx",
      line: 46,
      rationale:
        "library is read only as library.tracks, and the scan writes artists, albums, and lastScanTime in separate unbatched sets, each of which re-rendered the controls; a tracks leaf subscription keeps every read.",
      source: "useValue(library$)",
    },
    {
      expected: "excluded",
      file: "components/PlaybackControls.tsx",
      line: 47,
      rationale:
        "PlaybackQueueState has only the tracks field, so the leaf subscription notifies on the same changes and removes no render.",
      source: "useValue(queue$)",
    },
  ],
  commit: "b7b021dd7c022386206a3de22b0e7ac5e3ec56ae",
  parent: "08bf2810a77ea1d3d64c0dd42e9ac7ad949ee3b9",
  repository,
  root: "apps/music/src",
} as const satisfies ReplayCommit;

const dragProviderHover = {
  cases: [
    {
      action: "peek-unrendered-use-value",
      expected: "enforced",
      file: "DragDropContext.tsx",
      line: 83,
      rationale:
        "The provider reads activeDropZone only inside checkDropZones, a drag-move handler, so every hovered-zone change re-rendered the provider and, through its fresh context value, every drag consumer.",
      source: "useValue(activeDropZone$)",
    },
    {
      expected: "excluded",
      file: "DragDropContext.tsx",
      line: 194,
      rationale:
        "With the subscription gone the provider re-renders only with its parent; stabilizing the context value with useCallback and useMemo is identity memoization, which no action in the vocabulary expresses.",
      source: "const value: DragDropContextValue = {",
    },
  ],
  commit: "08bf2810a77ea1d3d64c0dd42e9ac7ad949ee3b9",
  parent: "5171da6c425b3981ea0acac535efedf1f3598a44",
  repository,
  root: "packages/reorder-controls/src",
} as const satisfies ReplayCommit;

const searchControlRationale =
  "The value feeds only the search dropdown, directly and through the memo-only usePlaylistOptions and usePlaylistQueueHandlers, so every library change re-rendered the whole toolbar; the dropdown wrapper now owns the subscription.";

const draftInputRationale =
  "The draft name renders only as the editing row's TextInput value and finalize reads it in an event, so every keystroke re-rendered the sidebar and all its rows; an owner observable with an input leaf keeps each write.";

const playbackAndLibrarySubscriptions = {
  cases: [
    {
      action: "delete-unused-state",
      expected: "enforced",
      file: "components/DropdownMenu.tsx",
      line: 412,
      rationale:
        "Sub's isOpen starts false, every write passes false, and it never renders, so the observer guard that reads it is constant and the observer re-ran on every submenu hover without acting; deleting the state deletes that observer.",
      source: "useState(false)",
    },
    {
      expected: "excluded",
      file: "components/DropdownMenu.tsx",
      line: 416,
      rationale:
        "The observer is deleted with the constant isOpen at line 412, which carries the case.",
      source: observeEffect,
    },
    {
      action: "use-value",
      equivalents: ["delete-derived-state"],
      expected: "enforced",
      file: "components/DropdownMenu.tsx",
      line: 495,
      rationale:
        "SubContent's isOpen is written only by the observer as activeSubmenuId compared with the context submenuId; a useValue projection renders the same boolean without the stale first render when the submenu is already active at mount.",
      source: "useState(false)",
    },
    {
      expected: "excluded",
      file: "components/DropdownMenu.tsx",
      line: 499,
      rationale:
        "The observer's only work is writing the mirrored isOpen, so it goes with the mirror at line 495, which carries the case.",
      source: observeEffect,
    },
    {
      action: "use-observable",
      expected: "enforced",
      file: "components/PlaybackTimelineSlider.tsx",
      line: 38,
      rationale:
        "progress renders only in the fill View, so each playback tick re-rendered the whole slider; an owner observable with a fill leaf keeps every writer. The expert's derived leaf also drops the drag write, which differs when the maximum does not exceed the minimum.",
      source: "useState(0)",
    },
    {
      expected: "excluded",
      file: "components/PlaybackTimelineSlider.tsx",
      line: 51,
      rationale:
        "The per-tick progress computation moves from this observer into the fill's useValue selector, so no run is removed; the render saving belongs to the progress state.",
      source: "useObserveEffect(updateProgress)",
    },
    {
      action: "move-use-value-into-child",
      equivalents: ["move-use-value-down"],
      expected: "enforced",
      file: "components/PlaybackControls.tsx",
      line: 45,
      rationale: searchControlRationale,
      source: "useValue(localMusicState$.tracks)",
    },
    {
      action: "move-use-value-into-child",
      equivalents: ["move-use-value-down"],
      expected: "enforced",
      file: "components/PlaybackControls.tsx",
      line: 46,
      rationale: searchControlRationale,
      source: "useValue(localMusicState$.playlists)",
    },
    {
      action: "move-use-value-into-child",
      equivalents: ["move-use-value-down"],
      expected: "enforced",
      file: "components/PlaybackControls.tsx",
      line: 47,
      rationale: searchControlRationale,
      source: "useValue(library$.tracks)",
    },
    {
      action: "move-use-value-into-child",
      equivalents: ["move-use-value-down"],
      expected: "enforced",
      file: "components/PlaybackControls.tsx",
      line: 48,
      rationale:
        "queueTracks feeds only the save dropdown's disabled flag and, through useQueueExporter, its onSave, so every queue edit re-rendered the toolbar. The emptiness projection and save-time peek go further by changing useQueueExporter's API.",
      source: "useValue(queue$.tracks)",
    },
    {
      action: "split-use-value-leaves",
      equivalents: ["move-use-value-down"],
      expected: "enforced",
      file: "components/Playlist.tsx",
      line: 84,
      rationale:
        "The whole-object subscription re-rendered Playlist for playlists, thumbnailVersion, and error, which it never reads, and for scan counters read only by the empty-state subtree; leaf reads plus a scan-status child keep every read.",
      source: "useValue(localMusicState$)",
    },
    {
      action: "move-use-value-down",
      expected: "enforced",
      file: "components/MediaLibrary/Sidebar.tsx",
      line: 59,
      rationale:
        "selectedPlaylistId is read only in the inline playlist .map row's isSelected, so each selection re-rendered the sidebar; the extracted row subscribes to its own boolean.",
      source: "useValue(libraryUI$.selectedPlaylistId)",
    },
    {
      expected: "excluded",
      file: "components/MediaLibrary/Sidebar.tsx",
      line: 67,
      rationale:
        "Both tempPlaylistId writers also write localMusicState$.playlists, which the sidebar still renders, in the same handler, so the observable removes no render.",
      source: "setTempPlaylistId] = useState<string | null>(null)",
    },
    {
      action: "use-observable",
      expected: "enforced",
      file: "components/MediaLibrary/Sidebar.tsx",
      line: 68,
      rationale: draftInputRationale,
      source: 'setTempPlaylistName] = useState("")',
    },
    {
      action: "use-observable",
      expected: "enforced",
      file: "components/MediaLibrary/Sidebar.tsx",
      line: 69,
      rationale:
        "activeNativeDropPlaylistId renders only in each macOS row's drop highlight and is written by drag enter and leave, so every native drag crossing re-rendered the sidebar; row selectors on an owner observable keep each write.",
      source: "setActiveNativeDropPlaylistId] = useState<string | null>(null)",
    },
    {
      action: "use-observable",
      expected: "enforced",
      file: "components/MediaLibrary/Sidebar.tsx",
      line: 70,
      rationale:
        "editingPlaylistId renders only as a row's isEditing and its writers touch no owner-rendered value, so starting or ending a rename re-rendered the sidebar; row selectors keep each write.",
      source: "setEditingPlaylistId] = useState<string | null>(null)",
    },
    {
      action: "use-observable",
      expected: "enforced",
      file: "components/MediaLibrary/Sidebar.tsx",
      line: 71,
      rationale: draftInputRationale,
      source: 'setEditingPlaylistName] = useState("")',
    },
  ],
  commit: "a7a8e2185a17e03595777b2048a94a1dd17c7aff",
  parent: "0d7ad12aba25306c67cf362a15cf0a523e0ebc2c",
  repository,
  root: musicRoot,
} as const satisfies ReplayCommit;

const aiPromptState = {
  cases: [
    {
      action: "use-observable",
      expected: "enforced",
      file: "components/AIButtons.tsx",
      line: 131,
      rationale:
        "isSourcePickerOpen only gates the picker subtree and is written by clicks, so opening or closing the picker re-rendered the toolbar; Show on an owner observable keeps the gate.",
      source: "setIsSourcePickerOpen] = useState(false)",
    },
    {
      action: "use-observable",
      expected: "enforced",
      file: "components/AIButtons.tsx",
      line: 132,
      rationale:
        "isPromptOpen only gates the prompt subtree; the open click and Cancel write nothing else, so they re-rendered the toolbar for the gate alone.",
      source: "setIsPromptOpen] = useState(false)",
    },
    {
      action: "use-observable",
      expected: "enforced",
      file: "components/AIButtons.tsx",
      line: 133,
      rationale:
        "prompt renders only as the TextInput value and the Generate button's disabled state, and submit reads it in an event, so every keystroke re-rendered the toolbar; input and submit leaves on an owner observable keep each read.",
      source: 'setPrompt] = useState("")',
    },
    {
      expected: "excluded",
      file: "components/AIButtons.tsx",
      line: 134,
      rationale:
        "isGenerating still renders the status and button states through an owner useValue; peeking it in handleGenerate fixes duplicate concurrent requests, a bug fix.",
      source: "setIsGenerating] = useState(false)",
    },
    {
      expected: "excluded",
      file: "components/AIButtons.tsx",
      line: 135,
      rationale:
        "generationError still renders the status message through an owner useValue, so the granularity is unchanged.",
      source: "setGenerationError] = useState<string | null>(null)",
    },
    {
      expected: "excluded",
      file: "components/AIButtons.tsx",
      line: 136,
      rationale:
        "aiToolState still drives the unavailable message through an owner useValue, so the granularity is unchanged.",
      source: "setAIToolState] = useState<AIToolState>",
    },
    {
      expected: "excluded",
      file: "components/AIButtons.tsx",
      line: 181,
      rationale: "Adds the stable state$ to the dependencies; no cost changes.",
      source: "useEffect(() => {",
    },
  ],
  commit: "b54f1f4eedd3d0161eb9ac7334ae609b204682f1",
  parent: "2e57a26171722656e9be002df6e32a732d431dea",
  repository,
  root: musicRoot,
} as const satisfies ReplayCommit;

const searchResultHighlighting = {
  cases: [
    {
      action: "use-observable",
      expected: "enforced",
      file: "components/JumpSearchMenuDropdown/hooks.ts",
      line: 153,
      rationale:
        "The hook's only consumer renders the highlight cursor solely in list rows through renderItem and extraData, so each arrow key re-rendered the dropdown and re-registered the keyboard listeners; an observable cursor with a per-row equality selector re-renders only the two rows whose highlight flips.",
      source: "useState(-1)",
    },
  ],
  commit: "ce09c337053785a4387dbf421246e50bea66491f",
  parent: "51ae3eb36e807204bb00bbbbec0c6a01052a57ef",
  repository,
  root: musicRoot,
} as const satisfies ReplayCommit;

const affectedDropZones = {
  cases: [
    {
      action: "select-primitive-projection",
      equivalents: ["narrow-use-value-subscription"],
      expected: "enforced",
      file: "DroppableZone.tsx",
      line: 40,
      rationale:
        "activeDropZone is read only in the isActive comparison with the zone's id, so every zone re-rendered whenever the hovered zone changed; a boolean selector re-renders only the zones whose isActive flips.",
      source: "useValue(activeDropZone$)",
    },
  ],
  commit: "3bac1e19de2d988808a9c985cb28b3003c3885d5",
  parent: "ce09c337053785a4387dbf421246e50bea66491f",
  repository,
  root: "packages/reorder-controls/src",
} as const satisfies ReplayCommit;

const songRowIsolation = {
  cases: [
    {
      action: "narrow-use-value-subscription",
      expected: "non-enforced",
      file: "components/MediaLibrary/TrackList.tsx",
      line: 77,
      rationale:
        "playlists feeds only a memo that finds the selected playlist, but TrackList also calls useLibraryTrackList, which subscribes the same component to localMusicState$.playlists, so narrowing this call alone still re-renders on every playlist edit; the saving needs this commit's change inside the hook.",
      source: "useValue(localMusicState$.playlists)",
    },
    {
      action: "narrow-use-value-subscription",
      expected: "non-enforced",
      file: "components/MediaLibrary/useLibraryTrackList.ts",
      line: 476,
      rationale:
        "Narrowing needs a cross-function proof that buildTrackItems only looks up the selected playlist, and the async context-menu command must switch to an event-time peek, which changes the snapshot a retained menu reads.",
      source: "useValue(localMusicState$.playlists)",
    },
  ],
  commit: "52dcd1b862fb9b6a461f7fe8e7fa1cf685523319",
  parent: "403c23f51f71f8e4e496d3019ab4bd03664c79b7",
  repository,
  root: musicRoot,
} as const satisfies ReplayCommit;

const selectedStreamingRows = {
  cases: [
    {
      action: "move-use-value-down",
      expected: "enforced",
      file: "components/MediaLibrary/Sidebar.tsx",
      line: 62,
      rationale:
        "selectedPlaylist is read only by the inline streaming-playlist rows' isSelected comparison, so selecting another provider playlist re-rendered the whole sidebar; a memo row with a per-row boolean selector re-renders only the rows whose selection flips.",
      source: "useValue(providerLibrary$.selectedPlaylist)",
    },
  ],
  commit: "645718fd35a42352c4841bf48b407c1576fe8c5b",
  parent: "52dcd1b862fb9b6a461f7fe8e7fa1cf685523319",
  repository,
  root: musicRoot,
} as const satisfies ReplayCommit;

/** Jay Meistrich's Music and reorder-controls subscription commits, classified against each parent tree. */
export const legendAppsMusicReplayCommits: readonly ReplayCommit[] = [
  playbackControlSubscriptions,
  dragProviderHover,
  playbackAndLibrarySubscriptions,
  aiPromptState,
  searchResultHighlighting,
  affectedDropZones,
  songRowIsolation,
  selectedStreamingRows,
];
