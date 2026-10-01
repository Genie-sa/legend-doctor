import type { ReplayCommit } from "../contracts.js";

const effect = "useEffect(() => {";

const flatVirtualization = {
  cases: [
    {
      expected: "excluded",
      file: "components/session/message-list.tsx",
      line: 77,
      rationale:
        "Rekeys the active turn from an index to a user-message id as part of the flat virtualization rewrite, a refactor.",
      source: "const [activeIndex, setActiveIndex] = useState",
    },
    {
      expected: "excluded",
      file: "components/session/message-list.tsx",
      line: 86,
      rationale:
        "Splits the turn grouping memo into a flattening memo and a fork-count memo; compute-only inside renders that still happen.",
      source: "const { userMessages, assistantByParent, forkCounts } = useMemo(",
    },
    {
      expected: "excluded",
      file: "components/session/message-list.tsx",
      line: 132,
      rationale:
        "Keeps the selected message when the list changes instead of clamping an index, a behavior change that follows the refactor.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/session/message-list.tsx",
      line: 159,
      rationale: "Renames the auto-scroll dependency to the flat item count.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/session/typewriter-effect.tsx",
      line: 24,
      rationale:
        "Deletes the typewriter animation and its 16ms interval renders, a visible UX change.",
      source: "useState(text)",
    },
    {
      expected: "excluded",
      file: "components/session/typewriter-effect.tsx",
      line: 26,
      rationale:
        "Deletes the typewriter animation and its 16ms interval renders, a visible UX change.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "context/SyncProvider.tsx",
      line: 524,
      rationale:
        "syncSession now skips the fetch when messages are cached, a data-freshness policy that removes network work, not a render.",
      source: "const syncSession = useCallback(",
    },
    {
      action: "narrow-use-value-subscription",
      expected: "non-enforced",
      file: "hooks/useSessionGraph.ts",
      line: 161,
      rationale:
        "Structure mode needs the commit's slice selector in useSessions, and the graph reads time.updated for the most-recent highlight and the hours filter, which structure mode stops tracking.",
      source: "useSessions()",
    },
    {
      expected: "excluded",
      file: "hooks/useSessionGraph.ts",
      line: 342,
      rationale:
        "Debounces the ELK layout by 100ms, a timing change that defers layout work; no action covers it.",
      source: effect,
    },
    {
      action: "narrow-use-value-subscription",
      expected: "non-enforced",
      file: "hooks/useSessions.ts",
      line: 57,
      rationale:
        "The slice selector returns fresh objects on every tracked change, and callers receive whole sessions read through a peek, so a field outside the slice such as summary goes stale; whether any caller renders one is a cross-module fact.",
      source: "use$(() => state$.data.sessions.get())",
    },
  ],
  commit: "44a672798c9f84a54b2b236c1b9107f9bd038a71",
  parent: "5c4a36cb4c1fa37df2ed949643a777f7b61c0a00",
  repository: "fractals",
  root: ".",
} as const satisfies ReplayCommit;

const sessionPaneChurn = {
  cases: [
    {
      expected: "excluded",
      file: "components/panes/session-pane.tsx",
      line: 392,
      rationale:
        "Pins the open session against the new cache eviction, a memory policy with no render cost.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/session/message-list.tsx",
      line: 27,
      rationale:
        "The call site destructures the new return shape; the narrowing is labeled at useParts.ts:25.",
      source: "usePartsForMessages(messageIds)",
    },
    {
      expected: "excluded",
      file: "components/session/message-list.tsx",
      line: 39,
      rationale: "Collapses text and edit parts by default, a UX change.",
      source: "const shouldExpandByDefault = useCallback(",
    },
    {
      expected: "excluded",
      file: "components/session/message-list.tsx",
      line: 91,
      rationale:
        "Caches flat items by content signature so memoized rows keep their identity, a memo-boundary saving.",
      source: "const flatItems = useMemo(",
    },
    {
      expected: "excluded",
      file: "components/ui/streaming-markdown.tsx",
      line: 74,
      rationale: "Deletes a ref that is written and never read; it caused no render.",
      source: "const prevLengthRef = useRef(0)",
    },
    {
      expected: "excluded",
      file: "components/ui/streaming-markdown.tsx",
      line: 78,
      rationale:
        "Throttles streamed content through new state and a 120ms timer, which delays visible text; a timing change no action covers.",
      source: "const repairedContent = useMemo(() => {",
    },
    {
      expected: "excluded",
      file: "context/SyncProvider.tsx",
      line: 571,
      rationale:
        "syncSession now touches an LRU cache that evicts inactive sessions' messages and parts, a memory policy with no render cost.",
      source: "const syncSession = useCallback(",
    },
    {
      action: "narrow-use-value-subscription",
      expected: "enforced",
      file: "hooks/useParts.ts",
      line: 25,
      rationale:
        "MessageList, the only caller, passes the getter to flattenMessages, which calls it only with ids of the same messages it derived messageIds from, so a selector over parts[messageId] for those ids keeps every read. The whole-store subscription re-rendered the memoized list whenever another session's parts streamed.",
      source: "use$(state$.data.parts)",
    },
    {
      expected: "excluded",
      file: "hooks/usePreloadPreviews.ts",
      line: 68,
      rationale:
        "Skips preloading sessions marked for hydration, a fetch policy with no render cost.",
      source: effect,
    },
  ],
  commit: "c0950409ab8ba3620013f7f6c19094987d661f3f",
  parent: "e1a91bc0cce8f22aeb24fa46725784aa1a114a8a",
  repository: "fractals",
  root: ".",
} as const satisfies ReplayCommit;

/** Every hook edit in the fractals maintainer's Legend State render-churn commits, classified against each parent tree. */
export const fractalsReplayCommits: readonly ReplayCommit[] = [
  flatVirtualization,
  sessionPaneChurn,
];
