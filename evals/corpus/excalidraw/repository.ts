import type { CorpusRepository } from "../contracts.js";

export const excalidrawRepository = {
  commit: "abeeaeba217ab3b5193b78c8d8d63c373b518ced",
  name: "excalidraw",
  targets: [
    { effects: 103, id: "excalidraw", root: "packages/excalidraw", states: 80 },
    {
      effects: 1,
      id: "excalidraw-app-theme",
      root: "excalidraw-app/useHandleAppTheme.ts",
      states: 2,
    },
  ],
  url: "https://github.com/excalidraw/excalidraw.git",
} as const satisfies CorpusRepository;
