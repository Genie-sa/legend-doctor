import type { ReplayCommit } from "../contracts.js";

const observerConversion =
  "The component becomes an observer that reads the same path with get(), so the subscription keeps its granularity and no render is removed.";

const libraryAndFeedModals = {
  cases: [
    {
      action: "narrow-use-value-subscription",
      expected: "non-enforced",
      file: "components/feed/FeedItem.tsx",
      line: 22,
      rationale:
        "Every feed row subscribed to the whole bookmark list to find its channel. Cutting those renders needs a per-row find selector whose result keeps identity across unrelated writes, or the maintainer's parent lookup map plus a new channel prop.",
      source: "useValue(bookmarks$.bookmarks)",
    },
    {
      expected: "excluded",
      file: "components/modal/FeedModal.tsx",
      line: 28,
      rationale: observerConversion,
      source: "useValue(ui$.feedModalOpen)",
    },
    {
      expected: "excluded",
      file: "components/modal/FeedModal.tsx",
      line: 29,
      rationale: observerConversion,
      source: "useValue(bookmarks$.bookmarks)",
    },
    {
      expected: "excluded",
      file: "components/modal/FeedModal.tsx",
      line: 30,
      rationale: observerConversion,
      source: "useValue(feeds$.bookmarks)",
    },
    {
      action: "peek-unrendered-use-value",
      expected: "enforced",
      file: "components/modal/FeedModal.tsx",
      line: 31,
      rationale:
        "home appears only in the filteredBookmarks dependency list, never in the memo body or the output, so each home change re-rendered the modal and recomputed the filter for nothing. settings$ is persisted by an eager syncObservable over synchronous MMKV, so its load never waits on this subscription.",
      source: "useValue(settings$.home)",
    },
    {
      expected: "excluded",
      file: "components/modal/FeedModal.tsx",
      line: 32,
      rationale: observerConversion,
      source: "useValue(folders$.folders)",
    },
    {
      expected: "excluded",
      file: "components/modal/LibraryModal.tsx",
      line: 35,
      rationale:
        "The modal now returns null while closed instead of hiding its content, which unmounts the lists and changes mount behavior.",
      source: "useValue(ui$.libraryModalOpen)",
    },
    {
      action: "narrow-use-value-subscription",
      equivalents: ["split-use-value-leaves"],
      expected: "enforced",
      file: "components/modal/LibraryModal.tsx",
      line: 36,
      rationale:
        "The whole-store subscription also tracks syncedAt, which sync writes on its own, while updatedAt appears only in a memo dependency list; subscribing to bookmarks alone keeps every read and drops those renders.",
      source: "useValue(bookmarks$)",
    },
    {
      expected: "excluded",
      file: "components/modal/LibraryModal.tsx",
      line: 37,
      rationale: observerConversion,
      source: "useValue(settings$.home)",
    },
    {
      expected: "excluded",
      file: "components/modal/LibraryModal.tsx",
      line: 39,
      rationale: observerConversion,
      source: "useValue(settings$.isYTMusic)",
    },
    {
      action: "narrow-use-value-subscription",
      equivalents: ["split-use-value-leaves"],
      expected: "enforced",
      file: "components/modal/LibraryModal.tsx",
      line: 41,
      rationale:
        "The whole-store subscription also tracks syncedAt and a separately written updatedAt that appears only in a memo dependency list; subscribing to folders alone keeps every read and drops those renders.",
      source: "useValue(folders$)",
    },
    {
      expected: "excluded",
      file: "components/modal/LibraryModal.tsx",
      line: 63,
      rationale:
        "Keying the effect on the folder count instead of the filtered array stops it from resetting the selected folder whenever the array is rebuilt, a behavior fix.",
      source: "useEffect(() => {",
    },
  ],
  commit: "767e37bee10ee9b7302dd36b2454813989096ac3",
  parent: "7a665d3f31ba907ad8c8598598d5718a6694c114",
  repository: "noutube",
  root: ".",
} as const satisfies ReplayCommit;

/** Every hook edit in the maintainer's NouTube performance commit, classified against the parent tree. */
export const noutubeReplayCommits: readonly ReplayCommit[] = [libraryAndFeedModals];
