import type { CorpusRepository } from "../contracts.js";

export const hoaluRepository = {
  commit: "65a93432254c255a2be75a829b7316874a3aa22f",
  name: "hoalu",
  targets: [{ effects: 24, id: "hoalu-app", root: "apps/app/src", states: 53 }],
  url: "https://github.com/quanphm/hoalu.git",
} as const satisfies CorpusRepository;
