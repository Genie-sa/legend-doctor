import type { CorpusRepository } from "../contracts.js";

export const legendPhotosRepository = {
  commit: "e0e3d0094a12dc4e13be767c9fb6aadecc2aa929",
  name: "legend-photos",
  targets: [{ effects: 2, id: "legend-photos", root: "src", states: 8 }],
  url: "https://github.com/LegendApp/legend-photos.git",
} as const satisfies CorpusRepository;
