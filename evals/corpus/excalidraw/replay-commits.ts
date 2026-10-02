import type { ReplayCommit } from "../contracts.js";

const libraryRenderingPerformance = {
  cases: [
    {
      action: "move-state-down",
      expected: "enforced",
      file: "components/LibraryMenu.tsx",
      line: 146,
      rationale:
        "LibraryMenu only forwards selectedItems and its setter to LibraryMenuContent, its unkeyed root with no other call site, which forwards both to LibraryMenuItems, the only reader and writer. Moving the constant-initialized state into LibraryMenuContent already stops each item toggle from re-rendering LibraryMenu and recomputing getSelectedElements over every element; the expert's deeper move into LibraryMenuItems also skips LibraryMenuContent.",
      source: 'useState<LibraryItem["id"][]>([])',
    },
    {
      expected: "excluded",
      file: "components/LibraryUnit.tsx",
      line: 29,
      rationale:
        "The svg export moves into a cached useLibraryItemSvg hook whose state adds a render; the cache saves export work and the effect still writes the node on every elements change.",
      source: "useEffect(() => {",
    },
  ],
  commit: "7340c70a0697bcdafe3eebab33ffecb116c8bc5f",
  parent: "a4f05339aa0cbaecdb619f3de11f5e40d8c37e3e",
  repository: "excalidraw",
  root: "src",
} as const satisfies ReplayCommit;

/** The excalidraw maintainers' library rendering commit, classified against each parent tree. */
export const excalidrawReplayCommits: readonly ReplayCommit[] = [libraryRenderingPerformance];
