import type { GoldHookCase } from "../contracts.js";

export const openWebuiReactNativeHookCases = [
  {
    abstentionReason: "render-cut-unproven",
    action: "review-state",
    file: "component.tsx",
    hook: "useState",
    line: 37,
    name: "isFocused",
    rationale:
      "One deferred interaction callback writes the reveal flag once, and path analysis reaches the render cut. Outside the AnimatedView gate the owner renders only its root view, search input, and filter sheet; `renderItem` runs inside the list the gate mounts either way. Three saved element renders on a one-time write fall below the five-element minimum for an effect-written presentation cut.",
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
