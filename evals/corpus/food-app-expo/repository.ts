import type { CorpusRepository } from "../contracts.js";

/**
 * Replay-only: the expert commits are scored against their parents and no target is scanned at the pin. The pin is the
 * last commit before `src/app/cook/[id].tsx` overflows the stack in `expressionDependsOnBinding`.
 */
export const foodAppExpoRepository = {
  commit: "5aeb1d0ead183d6f0e8e38c1a2dc0561414a1afc",
  name: "food-app-expo",
  targets: [],
  url: "https://github.com/danieltafjord/food-app-expo.git",
} as const satisfies CorpusRepository;
