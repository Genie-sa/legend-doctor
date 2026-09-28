import type { GoldPracticeCase } from "../contracts.js";

const diffDirectObservableLines = [
  929, 971, 972, 973, 974, 975, 1736, 2151, 2152, 2153, 2154, 2155, 2156, 2157, 2158, 2159, 2237,
] as const;

export const legendAppsPracticeCases = [
  {
    action: "split-use-value-leaves",
    disposition: "change",
    file: "components/AIButtons.tsx",
    line: 145,
    rationale:
      "Only `enabled` and `authenticated` are read, while connect and disconnect toggle the unread `isLoading` and `error` fields of spotifyStatus$ on their own, so leaf subscriptions skip those renders.",
    target: "legend-apps-music",
  },
  {
    action: "split-use-value-leaves",
    disposition: "change",
    file: "components/AIButtons.tsx",
    line: 146,
    rationale:
      "Only `enabled` and `authenticated` are read, while authorization toggles the unread `isLoading` and `error` fields of appleMusicStatus$ on their own, so leaf subscriptions skip those renders.",
    target: "legend-apps-music",
  },
  {
    action: "use-peek-for-snapshot",
    disposition: "style",
    file: "components/DropdownMenu.tsx",
    line: 416,
    rationale:
      "The read runs inside an `onChange` listener registered on mount, which is not a tracking context.",
    target: "legend-apps-music",
  },
  {
    action: "split-use-value-leaves",
    disposition: "change",
    file: "components/JumpSearchMenuDropdown.tsx",
    line: 43,
    rationale:
      "The search reads only `albums` and `artists`; library$.lastScanTime is written on its own whenever the library settings record a scan, so leaf subscriptions skip that render.",
    target: "legend-apps-music",
  },
  {
    action: "split-use-value-leaves",
    disposition: "change",
    file: "components/MediaLibrary/Sidebar.tsx",
    line: 62,
    rationale:
      "The sidebar renders only `enabled` and `authenticated`, while spotifyStatus$.isLoading and `error` change on their own during connect and disconnect.",
    target: "legend-apps-music",
  },
  {
    action: "split-use-value-leaves",
    disposition: "change",
    file: "components/MediaLibrary/Sidebar.tsx",
    line: 63,
    rationale:
      "The sidebar renders only `enabled` and `authenticated`, while appleMusicStatus$.isLoading and `error` change on their own during authorization.",
    target: "legend-apps-music",
  },
  {
    action: "use-peek-for-snapshot",
    disposition: "style",
    file: "components/NativeSidebar.tsx",
    line: 63,
    rationale:
      "The React effect compares one snapshot of the local selection before writing it; effects are not a Legend tracking context.",
    target: "legend-apps-music",
  },
  {
    action: "use-peek-for-snapshot",
    disposition: "style",
    file: "components/TitleBar.tsx",
    line: 31,
    rationale:
      "The `onHover` pointer handler reads the showTitleBarOnHover setting once before writing the hover flag; an event handler is not a tracking context. settings$ comes from createObservableFile in the linked @legend-apps/storage workspace package.",
    target: "legend-apps-music",
  },
  {
    action: "use-peek-for-snapshot",
    disposition: "style",
    file: "components/TitleBar.tsx",
    line: 39,
    rationale:
      "The `onHoverLeave` handler reads the showTitleBarOnHover setting once before clearing the hover flag; an event handler is not a tracking context.",
    target: "legend-apps-music",
  },
  {
    action: "split-use-value-leaves",
    disposition: "change",
    file: "settings/LibrarySettings.tsx",
    line: 38,
    rationale:
      "The page reads six scan and track leaves; the unread `thumbnailVersion` and `playlists` fields of localMusicState$ are written independently and rerender the whole page today.",
    target: "legend-apps-music",
  },
  {
    action: "use-peek-for-snapshot",
    disposition: "style",
    file: "settings/SettingsWindowManager.tsx",
    line: 20,
    rationale:
      "The initial settings page is read once inside a showSettings `onChange` listener before opening the window.",
    target: "legend-apps-music",
  },
  {
    action: "move-use-value-down",
    disposition: "change",
    file: "settings/SpotifySettings.tsx",
    line: 21,
    rationale:
      "Toggling Spotify rerenders the 18-element settings owner, yet `enabled` is read only by the Checkbox and the Connect Button. The owner's two useCallbacks depend only on useToast, an imported hook whose body is `return useContext(ToastContext)`, so an enabled-only render cannot recreate them; there are no refs, effects, or render snapshots.",
    target: "legend-apps-music",
  },
  {
    action: "move-use-value-down",
    disposition: "change",
    file: "settings/SpotifySettings.tsx",
    line: 22,
    rationale:
      "Every Client ID keystroke writes settings$.providers.spotify.clientId and rerenders the 18-element owner; only the controlled TextInput reads it. The handlers are useCallbacks keyed on the useContext-only useToast result, so a keystroke-only render recreates nothing the owner keeps.",
    target: "legend-apps-music",
  },
  {
    action: "use-peek-for-snapshot",
    disposition: "style",
    file: "systems/AppMenu.macos.tsx",
    line: 219,
    rationale:
      "The library-open flag is read inside the stateSaved$.libraryIsOpen `onChange` listener that patches the native menu, outside any tracking context. stateSaved$ comes from createObservableFile in the linked @legend-apps/storage workspace package.",
    target: "legend-apps-music",
  },
  {
    action: "use-peek-for-snapshot",
    disposition: "style",
    file: "systems/AppMenu.macos.tsx",
    line: 222,
    rationale:
      "The queue length is read inside the queue `onChange` listener that patches the native menu, outside any tracking context.",
    target: "legend-apps-music",
  },
  {
    action: "use-peek-for-snapshot",
    disposition: "style",
    file: "systems/LocalMusicState.ts",
    line: 1343,
    rationale:
      "The scanning flag is read once inside the librarySettings$.paths `onChange` listener to decide whether to start a scan, outside any tracking context; the listener is proven once librarySettings$ resolves through the linked @legend-apps/storage workspace package.",
    target: "legend-apps-music",
  },
  ...diffDirectObservableLines.map((line) => ({
    action: "pass-observable-to-use-value" as const,
    disposition: "style" as const,
    file: "DiffViewerWindow.tsx",
    line,
    rationale:
      "The selector returns one static `.get()` of an Observable-typed prop or local observable, so passing the observable subscribes to the same path through the same useSelector code path.",
    target: "legend-apps-diff",
  })),
] as const satisfies readonly GoldPracticeCase[];
