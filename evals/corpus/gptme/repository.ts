import type { CorpusRepository } from "../contracts.js";

/** The web UI declares react-dom ^18.3.1 but creates every root with `createRoot`. */
export const gptmeRepository = {
  commit: "f7bb34871442bb69d3cbecde49c7ce1f2e22517a",
  name: "gptme",
  targets: [{ effects: 132, id: "gptme-webui", root: "webui/src", states: 222 }],
  url: "https://github.com/gptme/gptme.git",
} as const satisfies CorpusRepository;
