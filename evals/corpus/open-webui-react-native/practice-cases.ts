import type { GoldPracticeCase } from "../contracts.js";

export const openWebuiReactNativePracticeCases = ([79, 80] as const).map((line) => ({
  action: "replace-legacy-use-value" as const,
  file: "component.tsx",
  line,
  rationale:
    "Legend State documents useValue as the supported replacement for the legacy useSelector hook, with the observable argument unchanged.",
  target: "open-webui-form-chat-input",
})) satisfies readonly GoldPracticeCase[];
