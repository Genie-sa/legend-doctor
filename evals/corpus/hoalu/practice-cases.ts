import type { GoldPracticeCase } from "../contracts.js";

export const hoaluPracticeCases = [
  {
    action: "move-use-value-into-child",
    file: "components/providers/workspace-action-provider.tsx",
    line: 32,
    rationale:
      "The provider unwraps commandPaletteOpen$ only to transport its value into one stable source-resolved CommandPalette child; subscribing in that existing child removes the provider render while preserving the child's render and lifetime.",
    target: "hoalu-app",
  },
] as const satisfies readonly GoldPracticeCase[];
