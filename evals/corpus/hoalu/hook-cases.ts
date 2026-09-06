import type { GoldHookCase } from "../contracts.js";

export const hoaluHookCases = [
  {
    action: "use-observable",
    file: "hooks/use-screenshot.ts",
    hook: "useState",
    line: 11,
    name: "status",
    rationale:
      "The screenshot hook owns every async status write but never reads the value; publishing a hook-lifetime observable lets the sole broad chart consumer subscribe only around its screenshot button.",
    target: "hoalu-app",
  },
  {
    action: "use-observable",
    file: "components/forms/select-category.tsx",
    hook: "useState",
    line: 36,
    name: "comboboxOpen",
    rationale:
      "The field owner performs category queries and option derivation while only the combobox renders this independently commanded open state.",
    target: "hoalu-app",
  },
  {
    action: "move-state-down",
    file: "components/forms/select-event.tsx",
    hook: "useState",
    line: 46,
    name: "dialogOpen",
    rationale:
      "Every value and setter use belongs to the stable Dialog subtree, so that extracted leaf can retain cohesive React ownership.",
    target: "hoalu-app",
  },
  ...[
    ["components/forms/select-event.tsx", 47],
    ["components/forms/select-recurring-bill.tsx", 49],
    ["components/forms/select-with-search.tsx", 27],
  ].map(([file, line]) => ({
    action: "use-observable" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: "comboboxOpen",
    rationale:
      "Opening the controlled combobox should update its stable leaf without rerunning the field owner, query hooks, or option derivation.",
    target: "hoalu-app",
  })),
  {
    action: "use-observable",
    file: "components/receipt/receipt-scanner.tsx",
    hook: "useState",
    line: 89,
    name: "isDragging",
    rationale:
      "Drag events update only the stable drop-zone presentation, so an owner observable and leaf subscription avoid rebuilding the scanner and queue UI.",
    target: "hoalu-app",
  },
  {
    action: "use-observable",
    enforced: false,
    file: "components/receipt/receipt-scanner.tsx",
    hook: "useState",
    line: 90,
    name: "isEncoding",
    rationale:
      "Encoding starts before awaited file work and clears in finally, while one stable queue button renders the flag through a pure disabled projection; a leaf subscription removes the pre-await scanner render without moving the pending-files gate or async boundary.",
    target: "hoalu-app",
  },
  {
    action: "use-unmount",
    file: "components/files/use-files-upload.ts",
    hook: "useEffect",
    line: 129,
    name: null,
    rationale:
      "The empty-dependency effect performs no setup and only revokes object URLs from a stable ref during teardown.",
    target: "hoalu-app",
  },
  ...[
    ["components/providers/ui-provider.tsx", 9],
    ["hooks/use-theme.ts", 117],
  ].map(([file, line]) => ({
    action: "use-mount" as const,
    file: file as string,
    hook: "useEffect" as const,
    line: line as number,
    name: null,
    rationale:
      "The empty-dependency setup invokes stable module initialization and has no cleanup or render-time capture.",
    target: "hoalu-app",
  })),
  {
    action: "review-state",
    file: "components/braille-spinner.tsx",
    hook: "useState",
    line: 21,
    name: "i",
    rationale:
      "The interval-owned frame cursor is the animation hook's returned value and requires timer and owner-lifetime reasoning before changing its state model.",
    target: "hoalu-app",
  },
  {
    action: "keep-effect",
    file: "components/braille-spinner.tsx",
    hook: "useEffect",
    line: 22,
    name: null,
    rationale:
      "The effect owns a dependency-sensitive interval and its paired cleanup, so React must retain the lifecycle.",
    target: "hoalu-app",
  },
  {
    action: "review-state",
    file: "components/input-with-copy.tsx",
    hook: "useState",
    line: 10,
    name: "copied",
    rationale:
      "The short feedback timer updates several parts of an already-small input control, so no material narrower boundary is proven.",
    target: "hoalu-app",
  },
  {
    action: "keep-state",
    file: "components/emoji-picker.tsx",
    hook: "useState",
    line: 13,
    name: "isOpen",
    rationale:
      "The visibility value and every close command already belong to the one root Popover subtree, so another subscriber would rebuild the same cohesive render boundary.",
    target: "hoalu-app",
  },
  {
    action: "review-state",
    file: "components/forms/datepicker.tsx",
    hook: "useState",
    line: 16,
    name: "month",
    rationale:
      "The calendar's editable month is synchronized from a changing controlled value and remains coupled to the cohesive date-picker boundary.",
    target: "hoalu-app",
  },
  {
    action: "review-effect",
    file: "components/forms/datepicker.tsx",
    hook: "useEffect",
    line: 18,
    name: null,
    rationale:
      "The effect synchronizes an editable calendar cursor from a controlled prop; no Legend observable source or event relocation is proven.",
    target: "hoalu-app",
  },
  {
    action: "keep-effect",
    file: "components/charts/cash-flow-chart.tsx",
    hook: "useEffect",
    line: 179,
    name: null,
    rationale:
      "The tooltip forwards recharts props to a parent-owned setter; the owner has no React state, so no Legend migration applies to this effect.",
    target: "hoalu-app",
  },
  {
    action: "review-effect",
    abstentionReason: "effect-causal-owner-unresolved",
    file: "components/forms/transaction-amount.tsx",
    hook: "useEffect",
    line: 62,
    name: null,
    rationale:
      "The focus and expression reset reacts to the local calculator-mode state, so the mutation site of that state or an observable reaction may own it once the state migrates.",
    target: "hoalu-app",
  },
  {
    abstentionReason: "render-cut-unproven",
    action: "review-state",
    assumption: { ifConfirmed: "use-observable" },
    file: "components/charts/expenses-overview.tsx",
    hook: "useState",
    line: 103,
    name: "clampOutliers",
    rationale:
      "The clamp toggle is read in a derived axis cap and inside the scale button of a 50-element chart card; only a human can confirm that both read sites can become leaf subscribers, so the finding must ask exactly that question.",
    target: "hoalu-app",
  },
  {
    abstentionReason: "render-cut-unproven",
    action: "review-state",
    assumption: { ifConfirmed: "use-observable" },
    file: "components/queue-panel.tsx",
    hook: "useState",
    line: 228,
    name: "collapsed",
    rationale:
      "The collapse flag drives the header label, the caret rotation, and the body gate of the queue panel; the finding must ask whether those three read sites can each become a leaf subscriber.",
    target: "hoalu-app",
  },
  {
    abstentionReason: "atomic-transition-unproven",
    action: "review-state",
    assumption: { ifConfirmed: "move-state-down" },
    file: "components/expenses/expense-filter-dropdown.tsx",
    hook: "useState",
    line: 56,
    name: "open",
    rationale:
      "The dropdown flag is written together with the menu view when the popover closes, so the finding must ask the co-written group question and name that a yes moves the flag down while the view stays under review.",
    target: "hoalu-app",
  },
  {
    abstentionReason: "ownership-flow-unresolved",
    action: "review-state",
    assumption: { ifConfirmed: "use-observable" },
    file: "components/command-palette/command-palette.tsx",
    hook: "useState",
    line: 31,
    name: "search",
    rationale:
      "The search text is handed to an unknown search hook and read in several render sites of a broad palette; the finding must ask both facts, the escaped consumer and the leaf-wrapped read sites, in one question.",
    target: "hoalu-app",
  },
] as const satisfies readonly GoldHookCase[];
