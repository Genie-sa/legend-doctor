import type { CorpusRepository } from "../contracts.js";

export const openWebuiReactNativeRepository = {
  commit: "7a277e6eac790db034204688bb9130d457545caa",
  contextRoot: ".",
  name: "open-webui-react-native",
  targets: [
    {
      effects: 0,
      id: "open-webui-attached-files",
      root: "libs/mobile/shared/features/use-attached-files/src/use-attached-files.ts",
      states: 0,
    },
    {
      effects: 1,
      id: "open-webui-search-archived-chats",
      root: "libs/mobile/chat/features/search-archived-chats/src/lib/component.tsx",
      states: 1,
    },
    {
      effects: 0,
      id: "open-webui-form-chat-input",
      root: "libs/mobile/chat/features/form-chat-input/src/lib/component.tsx",
      states: 3,
    },
  ],
  url: "https://github.com/RonasIT/open-webui-react-native.git",
} as const satisfies CorpusRepository;
