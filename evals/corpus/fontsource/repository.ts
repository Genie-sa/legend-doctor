import type { CorpusRepository } from "../contracts.js";

/** Replay-only: the expert commits are scored against their parents and no target is scanned at the pin. */
export const fontsourceRepository = {
  commit: "b30d1d0088eb1ad995b657c2ecf31b1ae9300bb3",
  name: "fontsource",
  targets: [],
  url: "https://github.com/fontsource/fontsource.git",
} as const satisfies CorpusRepository;
