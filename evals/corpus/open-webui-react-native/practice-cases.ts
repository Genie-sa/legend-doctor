import type { GoldPracticeCase } from "../contracts.js";

export const openWebuiReactNativePracticeCases = [
  ...([79, 80] as const).map((line) => ({
    action: "replace-legacy-use-value" as const,
    file: "component.tsx",
    line,
    rationale:
      "Legend State documents useValue as the supported replacement for the legacy useSelector hook, with the observable argument unchanged.",
    target: "open-webui-form-chat-input",
  })),
  {
    action: "batch-observable-writes",
    file: "use-attached-files.ts",
    line: 39,
    rationale:
      "Resetting files and images is one attachment transaction across two observable roots.",
    target: "open-webui-attached-files",
  },
] as const satisfies readonly GoldPracticeCase[];
