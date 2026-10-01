import type { CorpusRepository } from "../contracts.js";

/** Replay-only: the expert commits are scored against their parents and no target is scanned at the pin. */
export const fractalsRepository = {
  commit: "f5049fc8a24602a1f203fe08101d9e5dd0eabbf2",
  name: "fractals",
  targets: [],
  url: "https://github.com/skastr0/fractals.git",
} as const satisfies CorpusRepository;
