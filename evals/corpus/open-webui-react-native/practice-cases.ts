import type { GoldPracticeCase } from "../contracts.js";

export const openWebuiReactNativePracticeCases = ([79, 80] as const).map((line) => ({
  action: "replace-legacy-use-value" as const,
  disposition: "style" as const,
  file: "component.tsx",
  line,
  rationale:
    "The pin resolves @legendapp/state 2.1.15; the supported baseline is the latest v3, where `useValue` is an alias of useSelector, so the rename changes no subscription.",
  target: "open-webui-form-chat-input",
})) satisfies readonly GoldPracticeCase[];
