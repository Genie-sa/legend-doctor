import type { CorpusRepository } from "../contracts.js";

export const juntoRepository = {
  commit: "f30adbb946421f8606f27b6e8a5e9e37c7e0fb85",
  name: "junto",
  targets: [{ effects: 242, id: "junto-renderer", root: "src/renderer", states: 417 }],
  url: "https://github.com/skastr0/junto.git",
} as const satisfies CorpusRepository;
