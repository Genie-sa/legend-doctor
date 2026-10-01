import type { ReplayCommit } from "../contracts.js";

const effect = "useEffect(() => {";
const progressNarrowedHookCallSite =
  "The call switches to the duration-only hook; the render saving comes from the hook's narrowed state, labeled at useTrackProgress.ts:20.";
const lyricSharedValueRewrite =
  "The lyric index moves from React state into a Reanimated shared value read by worklets, a shared-value rewrite with no hook-level recommendation.";
const modalHostEffectMerge =
  "The two effects merge into one keyed on the same modals change; both still run in the same passive-effect flush and set the same state, so no render is removed.";

const podcastProgressRerenders = {
  cases: [
    {
      expected: "excluded",
      file: "features/player/components/main/PlayerChaptersSheet.tsx",
      line: 16,
      rationale:
        "The sheet stops rendering data.position and instead subscribes to the progress emitter in a new hook whose state changes only when the chapter index changes, and only while isOpen. That event-driven projection of a non-Legend emitter has no vocabulary action at this custom-hook call.",
      source: "usePlayerChapters()",
    },
    {
      expected: "excluded",
      file: "features/player/components/main/PlayerMainTab.tsx",
      line: 77,
      rationale:
        "Deletes the PlayerProgress wrapper so PlayerSlider calls usePlayerChapters itself. The wrapper's per-tick renders came from the same useTrackProgress state, so removing it alone moves the subscription without removing its cost.",
      source: "usePlayerChapters()",
    },
    {
      expected: "excluded",
      file: "features/player/components/main/PlayerSlider.tsx",
      line: 117,
      rationale: progressNarrowedHookCallSite,
      source: "useTrackProgress()",
    },
    {
      expected: "excluded",
      file: "features/player/hooks/usePlayerChapters.ts",
      line: 18,
      rationale: progressNarrowedHookCallSite,
      source: "useTrackProgress()",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "hooks/player/useTrackProgress.ts",
      line: 20,
      rationale:
        "Every progress event writes a new { position, duration, buffered } object, so each caller renders per tick: PlayerSlider and usePlayerChapters read only duration, and only PlayerChaptersSheet renders position, through chapterIndexAt. Cutting those renders needs every consumer to subscribe to its own field and the sheet to a chapter-index projection, not this state edit alone.",
      source: "useState<Progress>(INITIAL)",
    },
    {
      expected: "excluded",
      file: "hooks/player/useTrackProgress.ts",
      line: 25,
      rationale:
        "The mounted-flag effect folds into a disposed flag inside the subscription effect, a refactor that removes no render or lifecycle cost.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "hooks/player/useTrackProgress.ts",
      line: 56,
      rationale:
        "The rewritten effect keeps the same AppState-gated emitter subscription and dependency; dropping the getPosition and getBuffered reads follows from the narrowed state and removes no render on its own.",
      source: effect,
    },
  ],
  commit: "7ee8ecfa6aa991cc3eaa65f889c70c5d6d98f1cc",
  parent: "38460c5734620250e7e3dba7867dcfeb1907b5c6",
  repository: "bbplayer",
  root: "apps/mobile/src",
} as const satisfies ReplayCommit;

const lyricProgressListener = {
  cases: [
    {
      expected: "excluded",
      file: "app/player/hooks/useLyricSync.ts",
      line: 16,
      rationale:
        "The hook stops rendering the per-tick position from useTrackProgress and listens to the player's progress event itself, setting state only when the lyric index changes. That event-driven projection of a non-Legend emitter has no vocabulary action at this custom-hook call.",
      source: "useTrackProgress()",
    },
    {
      action: "move-to-event",
      equivalents: ["delete-derived-state"],
      expected: "non-enforced",
      file: "app/player/hooks/useLyricSync.ts",
      line: 79,
      rationale:
        "currentLyricIndex is written only by this effect from the per-tick position, a second render whenever the line changes. Setting it in the progress listener needs the listener useTrackProgress owns in another module, and the commit's listener no longer resets to the first line for a non-positive offset position and waits for the next tick after an offset or lyrics change.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "app/player/player.tsx",
      line: 28,
      rationale:
        "TrackInfo's props omit isFavorite and onFavoritePress, so the state is never read and its setter never runs; deleting the dead cell removes no render.",
      source: "useState(false)",
    },
  ],
  commit: "c57811ea5f4a98dc95969ab58f841c6e76057b2e",
  parent: "8565bf935bc2a54668f2ec982a915c4f7a2c7e37",
  repository: "bbplayer",
  root: ".",
} as const satisfies ReplayCommit;

const playerSharedValues = {
  cases: [
    {
      expected: "excluded",
      file: "features/player/components/PlayerSlider.tsx",
      line: 30,
      rationale:
        "The duration label moves from React state set through scheduleOnRN to a shared value rendered by AnimateableText, a Reanimated rewrite with no hook-level recommendation.",
      source: "useState(0)",
    },
    {
      expected: "excluded",
      file: "features/player/components/PlayerSlider.tsx",
      line: 31,
      rationale:
        "The per-second position label moves from React state set through scheduleOnRN to a shared value rendered by AnimateableText, a Reanimated rewrite with no hook-level recommendation.",
      source: "useState(0)",
    },
    {
      expected: "excluded",
      file: "features/player/components/lyrics/LyricLineItem.tsx",
      line: 43,
      rationale:
        "The effect mirrored the isHighlighted prop into a shared value; a useDerivedValue over the shared index replaces it, a Reanimated rewrite.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "features/player/components/lyrics/LyricLineItem.tsx",
      line: 140,
      rationale:
        "The effect mirrored the isHighlighted prop into a shared value; a useDerivedValue over the shared index replaces it, a Reanimated rewrite.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "features/player/hooks/useLyricSync.ts",
      line: 14,
      rationale: lyricSharedValueRewrite,
      source: "useState(0)",
    },
    {
      action: "use-ref",
      expected: "non-enforced",
      file: "features/player/hooks/useLyricSync.ts",
      line: 19,
      rationale:
        "isActive is read only inside the progress listener and the getPosition callback, so each app-state change re-rendered Lyrics just to re-run both effects. A ref drops that render, but the dependency also re-ran the getPosition effect on resume to resync the index, which the ref version leaves to the next progress event.",
      source: "useState(true)",
    },
    {
      expected: "excluded",
      file: "features/player/hooks/useLyricSync.ts",
      line: 90,
      rationale:
        "The listener stops resubscribing on every index and app-state change because both values left React state; the saving follows from the shared-value rewrite and the isActive edit at line 19.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "features/player/hooks/useLyricSync.ts",
      line: 125,
      rationale:
        "The getPosition effect stops re-running on every lyric change because the index left React state; the saving follows from the shared-value rewrite and the isActive edit at line 19.",
      source: effect,
    },
  ],
  commit: "7b77796c3503c58161a12dd7369b18603805c64a",
  parent: "c705ddaa46428eb526454e24df3948f098638fa5",
  repository: "bbplayer",
  root: "apps/mobile/src",
} as const satisfies ReplayCommit;

const reactDoctorPass = {
  cases: [
    {
      expected: "excluded",
      file: "app/modal.tsx",
      line: 24,
      rationale: modalHostEffectMerge,
      source: effect,
    },
    {
      expected: "excluded",
      file: "app/modal.tsx",
      line: 29,
      rationale: modalHostEffectMerge,
      source: effect,
    },
    {
      action: "delete-derived-state",
      expected: "non-enforced",
      file: "app/playlist/local/[id].tsx",
      line: 78,
      rationale:
        "The payloads are written only by the effect from selected and playlistData, a second render on every selection toggle, and are read only by the batch-add press handler. The effect toasts and keeps the previous payloads when a selected track is missing from the loaded pages, where the derivation returns [] silently.",
      source: "useState<{ track: CreateTrackPayload",
    },
    {
      action: "delete-effect",
      expected: "non-enforced",
      file: "app/playlist/local/[id].tsx",
      line: 219,
      rationale:
        "Deleting the effect also deletes its missing-track toast, a visible side effect the derivation at line 78 does not keep.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/modals/playlist/UpdateTrackLocalPlaylistsModal.tsx",
      line: 117,
      rationale:
        "checkedPlaylistIds is also written by checkbox presses, so it is not derived state; resetting it during render when the server list changes saves the stale commit but has no vocabulary action.",
      source: effect,
    },
  ],
  commit: "be3de3a6bf2cd7b07f7ec65e039042e047cd4be6",
  parent: "5b3fbd086b80ea5a83f4b7af53030b89d8f17c73",
  repository: "bbplayer",
  root: "apps/mobile/src",
} as const satisfies ReplayCommit;

/** The BBPlayer maintainer's playback re-render commits, classified against each parent tree. */
export const bbplayerReplayCommits: readonly ReplayCommit[] = [
  podcastProgressRerenders,
  lyricProgressListener,
  playerSharedValues,
  reactDoctorPass,
];
