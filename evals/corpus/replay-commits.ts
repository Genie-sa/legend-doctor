import type { ReplayCommit } from "./contracts.js";
import { bbplayerReplayCommits } from "./bbplayer/replay-commits.js";
import { campusRallyeReplayCommits } from "./campus-rallye/replay-commits.js";
import { excalidrawReplayCommits } from "./excalidraw/replay-commits.js";
import { fontsourceReplayCommits } from "./fontsource/replay-commits.js";
import { foodAppExpoReplayCommits } from "./food-app-expo/replay-commits.js";
import { fractalsReplayCommits } from "./fractals/replay-commits.js";
import { juntoReplayCommits } from "./junto/replay-commits.js";
import { legendAppsDiffReplayCommits } from "./legend-apps/replay-diff.js";
import { legendAppsDocumentsReplayCommits } from "./legend-apps/replay-documents.js";
import { legendAppsMusicReplayCommits } from "./legend-apps/replay-music.js";
import { legendAppsSlidesReplayCommits } from "./legend-apps/replay-slides.js";
import { legendMusicReplayCommits } from "./legend-music/replay-commits.js";
import { legendPhotosReplayCommits } from "./legend-photos/replay-commits.js";
import { noriReplayCommits } from "./nori/replay-commits.js";
import { noutubeReplayCommits } from "./noutube/replay-commits.js";
import { socialAppReplayCommits } from "./social-app/replay-commits.js";
import { zenborgReplayCommits } from "./zenborg/replay-commits.js";

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
  ...juntoReplayCommits,
  ...zenborgReplayCommits,
  ...fractalsReplayCommits,
  ...excalidrawReplayCommits,
  ...socialAppReplayCommits,
  ...fontsourceReplayCommits,
  ...foodAppExpoReplayCommits,
  ...campusRallyeReplayCommits,
  ...bbplayerReplayCommits,
];
