import type { CorpusRepository } from "../contracts.js";

export const noriRepository = {
  commit: "2911e64c4a7ae746a178ccd7c18b5647b4456246",
  name: "nori",
  targets: [{ effects: 46, id: "nori", root: ".", states: 42 }],
  url: "https://github.com/nonbili/Nori.git",
} as const satisfies CorpusRepository;
