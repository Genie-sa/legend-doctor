import type { CorpusRepository } from "../contracts.js";

export const zenborgRepository = {
  commit: "523af6cf9d18fa33941be971e057037283800ba0",
  name: "zenborg",
  targets: [{ effects: 60, id: "zenborg", root: "src", states: 151 }],
  url: "https://github.com/equanimitech/zenborg.git",
} as const satisfies CorpusRepository;
