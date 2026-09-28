import type { GoldPracticeCase } from "../contracts.js";

const MESSAGE_HANDLER =
  "The read runs inside the webview message handler, an event command outside any Legend tracking context.";
const MOUNT_EFFECT =
  "The read runs inside a React effect body, which Legend does not track, so the snapshot is explicit only.";

const snapshotReads = [
  ["noutube-page", "MainPageContent.tsx", 480, MOUNT_EFFECT],
  ["noutube-page", "MainPageContent.tsx", 570, MOUNT_EFFECT],
  ["noutube-page", "MainPageContent.tsx", 576, MOUNT_EFFECT],
  ["noutube-page", "MainPageContent.tsx", 618, MESSAGE_HANDLER],
  ["noutube-page", "MainPageContent.tsx", 637, MESSAGE_HANDLER],
  ["noutube-page", "MainPageContent.tsx", 665, MESSAGE_HANDLER],
  ["noutube-page", "MainPageContent.tsx", 728, MESSAGE_HANDLER],
  ["noutube-page", "MainPageContent.tsx", 778, MESSAGE_HANDLER],
  ["noutube-page", "MainPageContent.tsx", 817, MOUNT_EFFECT],
  ["noutube-page", "MainPageContent.tsx", 820, MOUNT_EFFECT],
  ["noutube-page", "MainPageContent.tsx", 829, MOUNT_EFFECT],
  ...(["playerPageUrl", "playerUrl", "browsePageUrl", "pageUrl"] as const).map(
    (leaf) =>
      [
        "noutube-page",
        "MainPageContent.tsx",
        930,
        `The split-view effect reads \`ui$.${leaf}\` once to pick the page to reload; React effects are not tracked.`,
      ] as const,
  ),
  ...(["pageUrl", "browsePageUrl"] as const).map(
    (leaf) =>
      [
        "noutube-page",
        "MainPageContent.tsx",
        937,
        `The same split-view effect reads \`ui$.${leaf}\` once to decide whether to move a video into the player.`,
      ] as const,
  ),
  ...(["playerPageUrl", "browsePageUrl"] as const).map(
    (leaf) =>
      [
        "noutube-page",
        "MainPageContent.tsx",
        1186,
        `The load-error retry handler reads \`ui$.${leaf}\` for the failed view once when pressed.`,
      ] as const,
  ),
  [
    "noutube-page",
    "MainPageContent.tsx",
    1187,
    "The retry handler falls back to the current url once when pressed.",
  ],
  [
    "noutube-page",
    "MainPageContent.tsx",
    1188,
    "The retry handler reads the current url once for the unsplit layout.",
  ],
  [
    "noutube-header",
    "NouHeader.tsx",
    429,
    "The queue button's press handler flips the modal flag from one snapshot.",
  ],
  [
    "noutube-extension",
    "components/native/useProjection.ts",
    59,
    "The layout effect fingerprints the projected bookmarks once after assigning the background snapshot.",
  ],
  [
    "noutube-extension",
    "components/native/useProjection.ts",
    60,
    "The same layout effect fingerprints the projected folders once.",
  ],
  [
    "noutube-extension",
    "components/native/useProjection.ts",
    61,
    "The same layout effect fingerprints the projected feed bookmarks once.",
  ],
  [
    "noutube-cookie-modal",
    "CookieModal.tsx",
    72,
    "The submit handler resolves the active webview once before injecting cookies.",
  ],
  [
    "noutube-history-modal",
    "HistoryModal.tsx",
    53,
    "The clear button's handler filters the current history once before writing it back.",
  ],
  [
    "noutube-move-bookmark-modal",
    "MoveBookmarkModal.tsx",
    38,
    "The effect looks up the pending folder once after the folder modal closes.",
  ],
  [
    "noutube-playback-quality-modal",
    "PlaybackQualityModal.tsx",
    19,
    "The selection handler resolves the active webview once to apply the chosen quality.",
  ],
  [
    "noutube-playback-speed-modal",
    "PlaybackSpeedModal.tsx",
    19,
    "The selection handler resolves the active webview once to apply the chosen rate.",
  ],
  [
    "noutube-user-styles",
    "SettingsUserStylesContent.tsx",
    200,
    "The run-script handler resolves the active webview once before executing the draft.",
  ],
  [
    "noutube-url-modal",
    "UrlModal.tsx",
    19,
    "The open-state effect copies the pending url into the input once and then clears it.",
  ],
] as const;

export const noutubePracticeCases = [
  ...snapshotReads.map(([target, file, line, rationale]) => ({
    action: "use-peek-for-snapshot" as const,
    disposition: "style" as const,
    file,
    line,
    rationale,
    target,
  })),
  {
    action: "split-use-value-leaves",
    disposition: "change",
    file: "SettingsModalTabSettings.tsx",
    line: 249,
    rationale:
      "The preferences page reads eight leaves of the persisted settings$ store, while the webview message handler writes the unread `playbackRate` and `playbackQuality` siblings and the background updater writes `lastYtDlpUpdate`, each rerendering the page today.",
    target: "noutube-settings-tabs",
  },
  {
    action: "toggle-observable",
    disposition: "style",
    file: "ToolsModal.tsx",
    line: 208,
    rationale:
      "The switch writes the negation of a peeked boolean leaf, which `toggle()` expresses with the same result.",
    target: "noutube-tools-modal",
  },
] as const satisfies readonly GoldPracticeCase[];
