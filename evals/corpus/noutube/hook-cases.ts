import type { GoldHookCase } from "../contracts.js";

export const noutubeHookCases = [
  {
    action: "use-observable",
    file: "FeedModal.tsx",
    hook: "useState",
    line: 82,
    name: "filterMenuQuery",
    rationale:
      "Every keystroke of the folder filter rerenders the whole feed owner and recomputes its bookmark filters; the query is read only inside the open folder menu, and the effect that clears it on menu change can write the observable in the same place.",
    target: "noutube-feed-modal",
  },
  {
    action: "use-observable",
    file: "SettingsModalTabSettings.tsx",
    hook: "useState",
    line: 903,
    name: "updatingYtDlp",
    rationale:
      "The pending flag feeds only the yt-dlp row's `loading` prop; subscribing at that call site keeps the other action rows out of both transitions of the awaited update.",
    target: "noutube-settings-tabs",
  },
  {
    action: "use-observable",
    file: "MainPageContent.tsx",
    hook: "useState",
    line: 413,
    name: "blocklistSynced",
    rationale:
      "The flag gates only the desktop tab list and is written once after the main process receives the blocklist, so a leaf subscriber mounts the tabs without rerendering the page owner.",
    target: "noutube-page",
  },
  {
    action: "keep-effect",
    file: "MainPageContent.tsx",
    hook: "useEffect",
    line: 345,
    name: null,
    rationale:
      "`preferH264` and `clickbaitThumbnail` feed only this reload effect, but `MainPageContent`, the one component that renders `DesktopTabView`, subscribes to both leaves itself and renders the unmemoized tab with a fresh `buildPrelude` every time, so each change already rerenders the tab and observing the settings directly removes no render.",
    target: "noutube-page",
  },
  {
    action: "use-observe-effect",
    file: "components/native/AppShell.tsx",
    hook: "useEffect",
    line: 70,
    name: null,
    rationale:
      "`language` is subscribed only to feed this effect, and neither parent subscribes to it; observing settings$.language directly applies the language without rerendering the provider shell.",
    target: "noutube-extension",
  },
  {
    action: "use-observable",
    file: "components/native/ExtensionHome.tsx",
    hook: "useState",
    line: 164,
    name: "busy",
    rationale:
      "The bookmark command's pending flag reaches only the header, while the owner also renders the feed list and six modals that rerender on both transitions today.",
    target: "noutube-extension",
  },
  {
    action: "use-observable",
    enforced: false,
    file: "components/native/SyncSection.tsx",
    hook: "useState",
    line: 19,
    name: "busy",
    rationale:
      "Uncertain: three status buttons read the flag, but the owner outside them is only four text rows, and the false write directly follows the awaited snapshot refresh that already rerenders the owner through context.",
    target: "noutube-extension",
  },
  {
    action: "move-state-down",
    file: "SettingsBlocklistContent.tsx",
    hook: "useState",
    line: 78,
    name: "value",
    rationale:
      "The draft is read and written only by the TextInput, the add button, and `add`, all inside the input row at line 91; a leaf around that row takes `kind` as a prop, so keystrokes stop rerendering the note, empty state, and every BlocklistRow.",
    target: "noutube-blocklist",
  },
] as const satisfies readonly GoldHookCase[];
