import type { ReplayCommit } from "./contracts.js";
import { legendAppsDiffReplayCommits } from "./legend-apps/replay-diff.js";
import { legendAppsDocumentsReplayCommits } from "./legend-apps/replay-documents.js";
import { legendAppsMusicReplayCommits } from "./legend-apps/replay-music.js";
import { legendAppsSlidesReplayCommits } from "./legend-apps/replay-slides.js";
import { legendMusicReplayCommits } from "./legend-music/replay-commits.js";
import { legendPhotosReplayCommits } from "./legend-photos/replay-commits.js";
import { noriReplayCommits } from "./nori/replay-commits.js";
import { noutubeReplayCommits } from "./noutube/replay-commits.js";

/** Expert commits replayed against their parent trees; CI fetches every `parent` by SHA. */
export const replayCommits: readonly ReplayCommit[] = [
  ...legendAppsMusicReplayCommits,
  ...legendAppsSlidesReplayCommits,
  ...legendAppsDocumentsReplayCommits,
  ...legendAppsDiffReplayCommits,
  ...legendMusicReplayCommits,
  ...legendPhotosReplayCommits,
  ...noutubeReplayCommits,
  ...noriReplayCommits,
];
