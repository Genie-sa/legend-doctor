import type { GoldPracticeCase } from "../contracts.js";

const LEGACY_USE_VALUE =
  "The pinned lockfile resolves @legendapp/state 3.0.0-beta.30, which predates `useValue`; the supported baseline is the latest v3, where `useValue` is an alias of useSelector, so the rename changes no subscription.";

const legacyUseValueLines = {
  "components/AdminView.tsx": [107],
  "components/AgentsList.tsx": [26],
  "components/BranchMapPanel.tsx": [15, 16],
  "components/ChatInput.tsx": [630, 631, 858, 881, 882],
  "components/CommandPalette.tsx": [213],
  "components/ConversationContent.tsx": [
    55, 56, 57, 58, 59, 60, 61, 62, 76, 77, 309, 310, 311, 692, 1098,
  ],
  "components/ConversationList.tsx": [109],
  "components/ExternalSessionDetail.tsx": [27],
  "components/ExternalSessionsView.tsx": [130],
  "components/HistoryView.tsx": [35, 51],
  "components/InlineToolConfirmation.tsx": [51],
  "components/InlineToolExecution.tsx": [22, 76],
  "components/MainLayout.tsx": [68, 70, 140, 141, 142, 148, 187, 688, 796, 797],
  "components/MenuBar.tsx": [42, 44],
  "components/MessageAvatar.tsx": [39, 40, 41, 42],
  "components/ProviderHealthDot.tsx": [29, 30, 31],
  "components/RightSidebar.tsx": [13],
  "components/ServerSelector.tsx": [50, 72, 73, 74, 75],
  "components/SessionCostSummary.tsx": [21],
  "components/SettingsModal.tsx": [27],
  "components/SetupWizard.tsx": [130, 153, 154],
  "components/ToolActivityPanel.tsx": [104, 105],
  "components/UnifiedSidebar.tsx": [136, 137, 141],
  "components/WelcomeView.tsx": [82, 83, 84, 85, 86, 87],
  "components/WorkspaceList.tsx": [20],
  "components/dashboard/ServerHealthPanel.tsx": [45],
  "components/settings/ServerConfiguration.tsx": [68, 83],
  "components/workspace/WorkspaceExplorer.tsx": [33],
  "contexts/ApiContext.tsx": [451],
  "hooks/useConversation.ts": [54, 55, 56, 57, 73],
  "hooks/useConversationSettings.ts": [45],
  "hooks/useConversationsInfiniteQuery.ts": [18],
  "hooks/useModels.ts": [30],
  "hooks/useMultiServerConversations.ts": [15],
  "hooks/useProviderHealth.ts": [18, 89, 90, 91],
  "hooks/useUserSettings.ts": [45],
  "pages/SettingsPage.tsx": [50],
  "pages/Skills.tsx": [72],
  "stores/tasks.ts": [76],
};

const EFFECT =
  "The read runs inside a React effect body, which Legend does not track, so the snapshot is explicit only.";
const HANDLER =
  "The read runs inside an event handler, which is not a Legend tracking context, so the snapshot is explicit only.";

const snapshotReads = [
  [
    "components/ChatMessage.tsx",
    735,
    "The edit ChatInput's `onChange` callback reads the draft once to apply a functional update; the callback runs on input, outside the enclosing Memo's tracking pass.",
  ],
  ["components/ConversationContent.tsx", 240, HANDLER],
  ["components/ConversationContent.tsx", 650, HANDLER],
  ["components/ConversationContent.tsx", 652, HANDLER],
  ["components/ConversationContent.tsx", 658, HANDLER],
  ["components/ConversationContent.tsx", 660, HANDLER],
  [
    "components/ConversationContent.tsx",
    894,
    "The scroll viewport's `onScroll` handler checks the auto-scroll flag once per event; handlers are not a Legend tracking context.",
  ],
  ["components/MainLayout.tsx", 124, EFFECT],
  ["components/MainLayout.tsx", 126, EFFECT],
  ["components/MainLayout.tsx", 130, EFFECT],
  ["components/MainLayout.tsx", 133, EFFECT],
  ["components/MainLayout.tsx", 295, HANDLER],
  ["components/MainLayout.tsx", 299, HANDLER],
  ["components/MainLayout.tsx", 393, EFFECT],
  ["components/MainLayout.tsx", 460, HANDLER],
  [
    "components/settings/ServerConfiguration.tsx",
    224,
    "The async delete handler reads the registry once after `removeServer` to pick the next server to connect.",
  ],
] as const;

export const gptmePracticeCases = [
  ...snapshotReads.map(([file, line, rationale]) => ({
    action: "use-peek-for-snapshot" as const,
    disposition: "style" as const,
    file,
    line,
    rationale,
    target: "gptme-webui",
  })),
  {
    action: "snapshot-mutated-use-value",
    disposition: "change",
    file: "hooks/useMultiServerConversations.ts",
    line: 15,
    rationale:
      "`use$(serverRegistry$)` returns the same registry object after in-place writes such as `connectedServerIds.push` (stores/servers.ts:274) and `splice` (:282), so the useMemo at line 18 keyed on `registry` keeps a stale secondary-server list while the hook's caller rerenders; selecting a copy changes the reference with the contents.",
    target: "gptme-webui",
  },
  {
    action: "use-computed-for-parent-reads",
    disposition: "change",
    file: "components/ChatMessage.tsx",
    line: 578,
    rationale:
      "`isSpeakingThis` (line 205) comes from `useSyncExternalStore(subscribeSpeaking, …)` and flips when playback starts or stops, but the Memo children close over it, so the TTS button at lines 684-692 keeps its first-render icon, label and click branch. `Computed` rerenders with ChatMessageComponent and still tracks `message$`.",
    target: "gptme-webui",
  },
  {
    action: "use-computed-for-parent-reads",
    disposition: "change",
    file: "components/ConversationContent.tsx",
    line: 1057,
    rationale:
      "`absoluteIndex` is `logOffsetValue + index` (line 968) inside rows keyed by `virtualItem.key` (line 1028); loading older messages moves `logOffset` (stores/conversations.ts:414), so a kept row's Memo still looks up `forkPoints$` at its old index and shows the branch indicator on the wrong message.",
    target: "gptme-webui",
  },
  ...Object.entries(legacyUseValueLines).flatMap(([file, lines]) =>
    lines.map((line) => ({
      action: "replace-legacy-use-value" as const,
      disposition: "style" as const,
      file,
      line,
      rationale: LEGACY_USE_VALUE,
      target: "gptme-webui",
    })),
  ),
] as const satisfies readonly GoldPracticeCase[];
