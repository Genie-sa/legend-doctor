import type { GoldPracticeCase } from "../contracts.js";

export const hoaluPracticeCases = [
  {
    action: "batch-observable-writes",
    file: "atoms/filters.ts",
    line: 94,
    rationale:
      "The selected date-range mode and its custom range form one computed snapshot and must publish as one transaction.",
    target: "hoalu-app",
  },
  {
    action: "narrow-use-value-subscription",
    file: "components/categories/category-actions.tsx",
    line: 136,
    rationale:
      "The edit form reads only the selected category id, so name-only updates must not invalidate its query and form owner.",
    target: "hoalu-app",
  },
  {
    action: "narrow-use-value-subscription",
    file: "components/categories/category-table.tsx",
    line: 44,
    rationale:
      "The table selection surface reads only the selected category id; the name belongs to the separate detail leaf.",
    target: "hoalu-app",
  },
  {
    action: "narrow-use-value-subscription",
    file: "components/charts/dashboard-date-filter.tsx",
    line: 110,
    rationale:
      "The group-by effect reads only the optional custom range, so changes to the selected range mode should not invalidate this control.",
    target: "hoalu-app",
  },
  {
    action: "narrow-use-value-subscription",
    file: "components/receipt/scan-queue-review-dialog.tsx",
    line: 83,
    rationale:
      "The review dialog reads only the optional scan job id, so unrelated dialog metadata should not invalidate its editor and queries.",
    target: "hoalu-app",
  },
  {
    action: "move-use-value-down",
    file: "components/expenses/expense-filter-dropdown.tsx",
    line: 67,
    enforced: false,
    rationale:
      "The transaction kind is rendered only by the category panel's conditional child slot, so an always-mounted wrapper can retain the subscription while preventing kind changes from rebuilding the full filter dropdown. This remains non-enforced: the owner also computes memo inputs from live-query hooks and a fresh date-range projection. Their identities and render-time refresh behavior need structural proof before removing owner renders; unstable memo dependencies conservatively block this cut.",
    target: "hoalu-app",
  },
  ...[
    ["components/expenses/expense-actions.tsx", 70, "expense deletion"],
    ["components/incomes/income-actions.tsx", 64, "income deletion"],
    ["components/events/event-actions.tsx", 254, "event deletion"],
    ["components/wallets/wallet-actions.tsx", 246, "wallet editing"],
    ["components/wallets/wallet-actions.tsx", 260, "wallet deletion"],
    ["components/recurring-bills/recurring-bill-actions.tsx", 373, "bill archiving"],
    ["components/recurring-bills/recurring-bill-actions.tsx", 408, "bill restoration"],
  ].map(([file, line, purpose]) => ({
    action: "narrow-use-value-subscription" as const,
    file: file as string,
    line: line as number,
    rationale: `The dialog owner reads only the optional data id for ${purpose}; sibling dialog data should not invalidate it.`,
    target: "hoalu-app",
  })),
  {
    action: "narrow-use-value-subscription",
    file: "components/events/event-actions.tsx",
    line: 147,
    rationale:
      "The edit dialog uses only the optional event id to select its record, so unrelated dialog data should not invalidate its query owner.",
    target: "hoalu-app",
  },
  {
    action: "batch-observable-writes",
    file: "hooks/use-auth.ts",
    line: 31,
    rationale:
      "Sign-out resets the expense and income drafts as one user-visible transition before navigation.",
    target: "hoalu-app",
  },
  {
    action: "move-use-value-into-child",
    file: "components/providers/workspace-action-provider.tsx",
    line: 32,
    rationale:
      "The provider unwraps commandPaletteOpen$ only to transport its value into one stable source-resolved CommandPalette child; subscribing in that existing child removes the provider render while preserving the child's render and lifetime. Its useEffect import is unused: there are no React effect calls, JSX refs, or direct imperative render snapshots that require the removed render.",
    target: "hoalu-app",
  },
] as const satisfies readonly GoldPracticeCase[];
