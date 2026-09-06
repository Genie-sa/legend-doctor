import type {
  CorpusRepository,
  GoldHookCase,
  GoldPracticeCase,
  GoldStateGroupCase,
} from "./contracts.js";
import { URL } from "node:url";

/** Labels and pinned repositories for one set of applications. */
export interface CorpusSlice {
  readonly hookCases: readonly GoldHookCase[];
  readonly practiceCases: readonly GoldPracticeCase[];
  readonly repositories: readonly CorpusRepository[];
  readonly stateGroups: readonly GoldStateGroupCase[];
}

interface PrivateCorpusModule {
  readonly privateCorpus?: CorpusSlice;
}

/**
 * Labels for applications that cannot be published live in `evals/corpus/private/`, which git
 * ignores. When the directory is present the eval scores them too; when it is absent the public
 * corpus stands alone, so contributors and CI run the same command.
 */
export async function loadPrivateCorpus(): Promise<CorpusSlice | null> {
  const specifier = new URL("private/index.js", import.meta.url).href;
  try {
    // SAFETY: the module is authored in this repository against CorpusSlice; a missing file is caught below.
    const module = (await import(specifier)) as PrivateCorpusModule;
    return module.privateCorpus ?? null;
  } catch {
    return null;
  }
}
