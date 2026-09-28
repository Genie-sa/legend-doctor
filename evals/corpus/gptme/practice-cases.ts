import type { GoldPracticeCase } from "../contracts.js";

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
  {
    action: "use-value-for-render-read",
    enforced: false,
    file: "stores/tasks.ts",
    line: 79,
    rationale:
      "Known false positive (nothing stale): the analyzer asks useTasksQuery to subscribe to `showArchived$`, but the observable is declared at line 24 and never written anywhere in webui/src, so the untracked reads at lines 79-80 can never be stale and the subscription removes no bug.",
    target: "gptme-webui",
  },
] as const satisfies readonly GoldPracticeCase[];
