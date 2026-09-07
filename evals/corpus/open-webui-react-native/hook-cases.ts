import type { GoldHookCase } from "../contracts.js";

export const openWebuiReactNativeHookCases = [
  {
    action: "use-observable",
    file: "component.tsx",
    hook: "useState",
    line: 37,
    name: "isFocused",
    rationale:
      "One deferred interaction callback writes the reveal flag without branching or suspension. The full AnimatedView gate can subscribe independently while preserving the original effect and conditional mount; bounded path analysis must not lose this ordinary case.",
    target: "open-webui-search-archived-chats",
  },
  {
    action: "use-observable",
    file: "component.tsx",
    hook: "useState",
    line: 85,
    name: "options",
    rationale:
      "The generation-option toggles write the selection from event handlers, the submit command snapshots it, and both `includes` projections are read-only prototype calls inside one stable <View> boundary, so that boundary subscribes instead of the whole composer.",
    target: "open-webui-form-chat-input",
  },
  {
    action: "use-observable",
    file: "component.tsx",
    hook: "useState",
    line: 82,
    name: "isMicrophonePreparing",
    rationale:
      "The voice-mode command crosses ChatInputBottomRow's conditional event selection, IconButton, and two transparent rest-prop objects before reaching React Native Pressable; only the stable action leaf consumes the pending flag.",
    target: "open-webui-form-chat-input",
  },
] as const satisfies readonly GoldHookCase[];
