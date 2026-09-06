import type { CorpusRepository } from "../contracts.js";

export const legendMusicRepository = {
  commit: "59d02afc11d6b27bc53ddecf1a69501626f8487f",
  name: "legend-music",
  targets: [{ effects: 19, id: "legend-music", root: "src", states: 32 }],
  url: "https://github.com/LegendApp/legend-music.git",
} as const satisfies CorpusRepository;
