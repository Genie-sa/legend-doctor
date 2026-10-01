import type { CorpusRepository } from "../contracts.js";

/** Replay-only: the expert commits are scored against their parents and no target is scanned at the pin. */
export const campusRallyeRepository = {
  commit: "df4968d1c07c912deb6fc0fbe1c447c723dfba1b",
  name: "campus-rallye",
  targets: [],
  url: "https://github.com/DHBWLoerrach/CampusRallyeApp.git",
} as const satisfies CorpusRepository;
