import type { CorpusRepository } from "../contracts.js";

export const legendAppsRepository = {
  commit: "8e4e230ef6a4c1c80384d6b86269e9ae219aeb6e",
  name: "legend-apps",
  targets: [
    { effects: 22, id: "legend-apps-music", root: "apps/music/src", states: 17 },
    { effects: 39, id: "legend-apps-diff", root: "apps/diff/src", states: 13 },
    { effects: 18, id: "legend-apps-markdown", root: "apps/markdown/src", states: 6 },
  ],
  url: "https://github.com/LegendApp/legend-apps.git",
} as const satisfies CorpusRepository;
