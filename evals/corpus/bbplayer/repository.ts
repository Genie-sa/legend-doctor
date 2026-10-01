import type { CorpusRepository } from "../contracts.js";

/** Replay-only: the expert commits are scored against their parents and no target is scanned at the pin. */
export const bbplayerRepository = {
  commit: "d19b0f26558006383d5d8bd246fd0a1872604861",
  name: "bbplayer",
  targets: [],
  url: "https://github.com/bbplayer-app/BBPlayer.git",
} as const satisfies CorpusRepository;
