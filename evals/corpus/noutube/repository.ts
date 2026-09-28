import type { CorpusRepository } from "../contracts.js";

/** The modal directory is scanned file by file. */
export const noutubeRepository = {
  commit: "8cb020814475ba5d3ad2499bf9d4a3dc128dc789",
  contextRoot: ".",
  name: "noutube",
  targets: [
    { effects: 23, id: "noutube-page", root: "components/page", states: 5 },
    { effects: 3, id: "noutube-header", root: "components/header", states: 3 },
    { effects: 7, id: "noutube-extension", root: "extension", states: 7 },
    { effects: 3, id: "noutube-feed-modal", root: "components/modal/FeedModal.tsx", states: 7 },
    {
      effects: 0,
      id: "noutube-settings-tabs",
      root: "components/modal/SettingsModalTabSettings.tsx",
      states: 2,
    },
    { effects: 2, id: "noutube-tools-modal", root: "components/modal/ToolsModal.tsx", states: 8 },
    { effects: 1, id: "noutube-cookie-modal", root: "components/modal/CookieModal.tsx", states: 1 },
    {
      effects: 0,
      id: "noutube-history-modal",
      root: "components/modal/HistoryModal.tsx",
      states: 0,
    },
    {
      effects: 1,
      id: "noutube-move-bookmark-modal",
      root: "components/modal/MoveBookmarkModal.tsx",
      states: 0,
    },
    {
      effects: 0,
      id: "noutube-playback-quality-modal",
      root: "components/modal/PlaybackQualityModal.tsx",
      states: 0,
    },
    {
      effects: 0,
      id: "noutube-playback-speed-modal",
      root: "components/modal/PlaybackSpeedModal.tsx",
      states: 0,
    },
    {
      effects: 0,
      id: "noutube-blocklist",
      root: "components/modal/SettingsBlocklistContent.tsx",
      states: 1,
    },
    {
      effects: 0,
      id: "noutube-user-styles",
      root: "components/modal/SettingsUserStylesContent.tsx",
      states: 3,
    },
    { effects: 1, id: "noutube-url-modal", root: "components/modal/UrlModal.tsx", states: 1 },
    {
      effects: 2,
      id: "noutube-settings-tree",
      root: "components/modal/SettingsTree.tsx",
      states: 5,
    },
  ],
  url: "https://github.com/nonbili/NouTube.git",
} as const satisfies CorpusRepository;
