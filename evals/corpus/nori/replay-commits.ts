import type { ReplayCommit } from "../contracts.js";

const bookmarkSearchIndex = {
  cases: [
    {
      expected: "excluded",
      file: "components/drawer/AllBookmarksDrawerParts.tsx",
      line: 230,
      rationale:
        "Precomputes lowercased search fields once per bookmark change and keys the filter memo on the drawer's fields instead of the object rebuilt each render; it saves compute inside renders that still happen.",
      source: "const filteredBookmarks = useMemo(() => {",
    },
  ],
  commit: "735ec83a7ecaa6926092b6e155711bea324813e0",
  parent: "06549c4940a912810ac6b77aaacd95823e898e68",
  repository: "nori",
  root: ".",
} as const satisfies ReplayCommit;

/** The maintainer's Nori performance commit touching Legend-backed React code, classified against the parent tree. */
export const noriReplayCommits: readonly ReplayCommit[] = [bookmarkSearchIndex];
