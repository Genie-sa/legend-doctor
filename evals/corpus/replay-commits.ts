import type { ReplayCommit } from "./contracts.js";
import { legendMusicReplayCommits } from "./legend-music/replay-commits.js";

/** Expert commits replayed against their parent trees; CI fetches every `parent` by SHA. */
export const replayCommits: readonly ReplayCommit[] = [...legendMusicReplayCommits];
