import type { GoldPracticeCase } from "../contracts.js";

export const noriPracticeCases = [
  {
    action: "use-peek-for-snapshot",
    disposition: "style",
    file: "components/sheet/RecentlyUsedSheet.tsx",
    line: 141,
    rationale:
      "The clear handler captures the opened bookmarks once for undo before clearing them, outside any tracking context.",
    target: "nori",
  },
  {
    action: "narrow-use-value-subscription",
    disposition: "change",
    file: "components/sheet/SettingsSheetSections.tsx",
    line: 171,
    rationale:
      "The plan section reads only `ios?.expiresAt`, while entitlement refreshes can change the unread `status`, `willRenew`, and `linkedEmail` fields of auth$.ios; the leaf also yields undefined when `ios` is null.",
    target: "nori",
  },
  {
    action: "narrow-observable-write",
    disposition: "change",
    file: "lib/webview-title-resolver.ts",
    line: 59,
    rationale:
      "The queue is only peeked, never rendered, and the package does not enable the React Compiler; a single-argument `push` sets one new index instead of copying and diffing the whole pending queue.",
    target: "nori",
  },
] as const satisfies readonly GoldPracticeCase[];
