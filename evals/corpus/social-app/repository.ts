import type { CorpusRepository } from "../contracts.js";

/** Replay-only: the expert commits are scored against their parents and no target is scanned at the pin. */
export const socialAppRepository = {
  commit: "e4f8ea71a9bfa7af1c0b03b315614c358e4f1317",
  name: "social-app",
  targets: [],
  url: "https://github.com/bluesky-social/social-app.git",
} as const satisfies CorpusRepository;
