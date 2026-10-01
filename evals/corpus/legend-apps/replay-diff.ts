import type { ReplayCommit } from "../contracts.js";

const repository = "legend-apps";
const root = "apps/diff/src";
const effect = "useEffect(() => {";

const collapsedSetRationale =
  "Every collapse also changes listExtraData and renderFields, which both carry the collapsed set, so the list re-renders every row anyway; moving the Set read into a header child removes no render in this tree.";

const collapseSubscriptions = {
  cases: [
    {
      expected: "excluded",
      file: "viewer/DiffRows.tsx",
      line: 634,
      rationale: collapsedSetRationale,
      source: "useValue(collapsedFileIndexes$)",
    },
    {
      expected: "excluded",
      file: "viewer/DiffRows.tsx",
      line: 781,
      rationale: collapsedSetRationale,
      source: "useValue(collapsedFileIndexes$)",
    },
  ],
  commit: "edd52f1195ed18d9dd21b4bc1680faebc5d1007a",
  parent: "790fc344afdd58216b731ae280c8b38c837f7b86",
  repository,
  root,
} as const satisfies ReplayCommit;

const resizeSubscriptions = {
  cases: [
    {
      action: "move-use-value-into-child",
      expected: "enforced",
      file: "DiffViewerWindow.tsx",
      line: 2315,
      rationale:
        "The owner reads splitPaneMetrics only to derive props for DiffLoadedBodyGate, which spreads them into DiffLoadedBody, so subscribing in DiffLoadedBody stops pane resizes from re-rendering DiffViewerWindowContent.",
      source: "useValue(splitPaneMetrics$)",
    },
    {
      action: "move-use-value-into-child",
      expected: "non-enforced",
      file: "DiffViewerWindow.tsx",
      line: 2316,
      rationale:
        "diffPaneHeight also feeds the side-by-side initial-range effect in useDiffSideBySideRuntime, so the owner render goes away only after that effect becomes an observer.",
      source: "useValue(diffPaneHeight$)",
    },
    {
      action: "use-observe-effect",
      expected: "non-enforced",
      file: "viewer/diffLoadedDocumentModel.tsx",
      line: 477,
      rationale:
        "The observer drops nativeSideBySideRows, rowHeight, sideBySideRowCount, viewMode, and requestSideBySideRange from the dependencies, so switching to side-by-side with an unchanged pane height no longer requests the initial range, and the request runs before commit.",
      source: effect,
    },
  ],
  commit: "cf061a28c034cfb8bf0e0904d1ee06dc8b8ce3e5",
  parent: "edd52f1195ed18d9dd21b4bc1680faebc5d1007a",
  repository,
  root,
} as const satisfies ReplayCommit;

const openStateSubscriptions = {
  cases: (
    [
      [2307, "useValue(urlInput$)", "urlInput"],
      [2308, "useValue(urlInputError$)", "urlInputError"],
      [2309, "useValue(openError$)", "openError"],
    ] as const
  ).map(([line, source, binding]) => ({
    action: "move-use-value-into-child" as const,
    expected: "enforced" as const,
    file: "DiffViewerWindow.tsx",
    line,
    rationale: `The owner reads ${binding} only as DiffOpenBody's ${binding} prop, and its handlers peek the observable, so a container that subscribes keeps each change from re-rendering DiffViewerWindowContent.`,
    source,
  })),
  commit: "f06e018aebd363d6d1689e01720368921d568ef3",
  parent: "cf061a28c034cfb8bf0e0904d1ee06dc8b8ce3e5",
  repository,
  root,
} as const satisfies ReplayCommit;

const noChangesSelector = {
  cases: [
    {
      action: "narrow-use-value-subscription",
      expected: "enforced",
      file: "DiffViewerWindow.tsx",
      line: 1150,
      rationale:
        "activeFileIndex is read only to compute the shouldShowNoChanges boolean through getActiveMergeFile, so a boolean selector stops scroll-driven active-file changes from re-rendering DiffLoadedBody.",
      source: "useValue(activeFileIndex$)",
    },
  ],
  commit: "9235a4c0a3f11fd086a7e902ace3b5769ddf78fa",
  parent: "ddf49938106babfcbf4c51bd9b166b2e74f04f7c",
  repository,
  root,
} as const satisfies ReplayCommit;

const scrollRerenders = {
  cases: [
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 1024,
      rationale:
        "Drops clearHighlightTimeouts from the document-reset effect because the commit deletes the visible-range highlight scheduler, a feature removal.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 1036,
      rationale: "Deletes the highlight-timeout cleanup together with the scheduler it served.",
      source: "useEffect(() => clearHighlightTimeouts, [clearHighlightTimeouts]);",
    },
    {
      expected: "excluded",
      file: "viewer/diffLoadedDocumentModel.tsx",
      line: 346,
      rationale:
        "Deletes the side-by-side token style state with background tokenization; side-by-side rows fall back to the unified style map, which changes output.",
      source: "useState<SideBySideTokenStyleState | null>(null)",
    },
    {
      expected: "excluded",
      file: "viewer/diffLoadedDocumentModel.tsx",
      line: 347,
      rationale:
        "Deletes the row-version observable that re-rendered side-by-side rows as tokens arrived; those rows no longer show background highlights.",
      source: "useObservable<Record<string, number>>({})",
    },
    {
      expected: "excluded",
      file: "viewer/diffLoadedDocumentModel.tsx",
      line: 377,
      rationale: "Deletes the theme refresh for the removed side-by-side style state.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "viewer/diffLoadedDocumentModel.tsx",
      line: 481,
      rationale: "Deletes the scroll-idle timeout cleanup for the removed tokenization flush.",
      source: "useEffect(() => () => {",
    },
    {
      expected: "excluded",
      file: "viewer/diffLoadedDocumentModel.tsx",
      line: 488,
      rationale: "Deletes background tokenization of side-by-side rows, a feature removal.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "viewer/DiffRows.tsx",
      line: 290,
      rationale:
        "Adds useTokenizedDiffRow, which tokenizes each normal row on a timer and stores the result in row state; it replaces shared invalidation with a per-row render, and no action in the vocabulary expresses it.",
      source: 'const marker = isAdd ? "+"',
    },
  ],
  commit: "af5d4871ba227219c04658114949c4bbdaa57cd0",
  parent: "9056d84d6f8564556b61eef78938e34e60b634c3",
  repository,
  root,
} as const satisfies ReplayCommit;

const scrollRerendersVirtualizedDocument = {
  cases: [
    {
      expected: "excluded",
      file: "index.tsx",
      line: 273,
      rationale:
        "Deletes the per-row version subscription with the invalidation feature; a row no longer re-renders when its tokenized content arrives, which changes what it shows.",
      source: "useValue(() => rowVersions$[String(props.index)].get() ?? 0)",
    },
    {
      expected: "excluded",
      file: "index.tsx",
      line: 337,
      rationale:
        "Deletes the row-version observable that let requestRange invalidate tokenized rows, removing the feature rather than narrowing a subscription.",
      source: "useObservable<Record<string, number>>({})",
    },
  ],
  commit: "af5d4871ba227219c04658114949c4bbdaa57cd0",
  parent: "9056d84d6f8564556b61eef78938e34e60b634c3",
  repository,
  root: "packages/virtualized-document/src",
} as const satisfies ReplayCommit;

const sidebarMemoRationale =
  "Wraps a sidebar row in memo with a custom comparator and passes a stable onPressFile; memoizing a component and its callback identity is not an action in the vocabulary.";

const tokenStyleDependencyRationale =
  "Drops tokenStyleById from the row fields; it is recomputed from the same inputs as syntaxStyleStore, which renderFields still carries, so rows re-render no less often.";

const nativeConfigMemoRationale =
  "Keys the native config memo on the document id instead of the document object; configId and configVersion are a string and a number, so renderFields changes no less often.";

const viewerMemoChurn = {
  cases: [
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 526,
      rationale: sidebarMemoRationale,
      source: "function DiffSidebarFolderRow(",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 536,
      rationale: sidebarMemoRationale,
      source: "function DiffSidebarFileRow({",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 2064,
      rationale:
        "Deletes a memoized extraData object that no caller reads; it cost only memo bookkeeping.",
      source: "const mergeListExtraData = useMemo(() => ({",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 3493,
      rationale: tokenStyleDependencyRationale,
      source: "const listExtraData = useMemo",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 3534,
      rationale: nativeConfigMemoRationale,
      source: "const nativeUnifiedRowConfig = useMemo<DiffNativeRowConfigProps>(() => {",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 3588,
      rationale: nativeConfigMemoRationale,
      source: "const nativeSideBySideRowConfig = useMemo<DiffNativeRowConfigProps>(() => {",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 3645,
      rationale: tokenStyleDependencyRationale,
      source: "const renderFields = useMemo<DiffRenderFields>(",
    },
  ],
  commit: "6fadc9405d7fbeabf1c35482359ec0bd4d5bb994",
  parent: "bb325a532c9ef2d1cb993284767fc37c30db32b2",
  repository,
  root,
} as const satisfies ReplayCommit;

const rowSplitRationale =
  "Line rows read this presentation leaf only in the file-header or hunk-header branch, but it changes together with the other presentation leaves, so line rows stop re-rendering only once every header read moves into header children and isFileHeader and hasHunkHeader become owner-computed props.";

const unifiedFileLookupRationale =
  "This computed leaf builds a new Map or Set on every state$ change, and the line row uses it only to find its file header; line rows stop re-rendering on those changes only when fileByIndex, fileByRowStart, and fileHeaderRowIndexes all leave the line path, which the commit does with an owner-computed isFileHeader prop.";

const sideBySideFileLookupRationale =
  "This computed leaf builds a new Map on every state$ change, and the line row uses it only to find its file header; line rows stop re-rendering on those changes only when fileByIndex, fileByRowStart, and sideBySideFileHeaderByListIndex all leave the line path, which the commit does with an owner-computed isFileHeader prop.";

const sideBySideHunkLayoutRationale =
  "The line row reads this leaf only for hunk-header info, but a collapse also rebuilds sideBySideFileHeaderByListIndex, so line rows stop re-rendering on collapse only after the whole header split.";

const rowHeightRationale =
  "rowHeight renders only the no-document placeholder, and a font change moves it together with fontSize and fontFamily, so the line row stops re-rendering only after the whole header split.";

const showOnlyHunksRationale =
  "showOnlyHunks decides whether a line row shows a hunk header, so the row must re-render when it toggles; the commit reads it in renderRow instead, which moves the read without removing a needed render.";

const documentReadRationale =
  "The document read moves into the native child as a documentReady flag, so each line row still re-renders on a document change.";

const nativeRowConsolidationRationale =
  "Folds three leaf subscriptions into one object selector, which re-renders on every change of any leaf, and adds a document read; the row renders on the same changes as before.";

const ownerRowPropsRationale =
  "The owner half of the row split: renderRow now computes isFileHeader and hasHunkHeader, and the list reads renderRow through a ref, so this callback's new dependencies remove no render by themselves.";

type RowSplitEntry = readonly [
  line: number,
  source: string,
  rationale: string,
  action?: "move-use-value-down" | "narrow-use-value-subscription",
];

const rowPresentation = (leaf: string): string =>
  `useValue(() => rowRender$.presentation.${leaf}.get())`;
const rowDocument = (leaf: string): string => `useValue(() => rowRender$.document.${leaf}.get())`;

const unifiedRowSplit: readonly RowSplitEntry[] = [
  [439, rowPresentation("borderColor"), rowSplitRationale],
  [441, rowPresentation("fileHeaderBackgroundColor"), rowSplitRationale],
  [442, rowDocument("fileByIndex"), unifiedFileLookupRationale],
  [443, rowDocument("fileByRowStart"), unifiedFileLookupRationale],
  [
    444,
    rowDocument("fileHeaderRowIndexes"),
    unifiedFileLookupRationale,
    "narrow-use-value-subscription",
  ],
  [445, rowPresentation("fontFamily"), rowSplitRationale],
  [446, rowPresentation("fontSize"), rowSplitRationale],
  [447, rowPresentation("foregroundColor"), rowSplitRationale],
  [448, rowPresentation("hunkHeaderBackgroundColor"), rowSplitRationale],
  [449, rowPresentation("mutedColor"), rowSplitRationale],
  [450, rowPresentation("rowHeight"), rowHeightRationale],
  [452, rowPresentation("syntaxAppearance"), rowSplitRationale],
];

const sideBySideRowSplit: readonly RowSplitEntry[] = [
  [517, rowPresentation("borderColor"), rowSplitRationale],
  [518, rowDocument("collapsedFileIndexList"), sideBySideHunkLayoutRationale],
  [520, rowPresentation("fileHeaderBackgroundColor"), rowSplitRationale],
  [521, rowDocument("fileByIndex"), sideBySideFileLookupRationale],
  [522, rowDocument("fileByRowStart"), sideBySideFileLookupRationale],
  [523, rowPresentation("fontFamily"), rowSplitRationale],
  [524, rowPresentation("fontSize"), rowSplitRationale],
  [525, rowPresentation("foregroundColor"), rowSplitRationale],
  [526, rowPresentation("hunkHeaderBackgroundColor"), rowSplitRationale],
  [527, rowPresentation("mutedColor"), rowSplitRationale],
  [528, rowPresentation("rowHeight"), rowHeightRationale],
  [530, rowDocument("sideBySideFileHeaderByListIndex"), sideBySideFileLookupRationale],
  [531, rowDocument("sideBySideRowCount"), sideBySideHunkLayoutRationale],
  [532, rowPresentation("syntaxAppearance"), rowSplitRationale],
];

const narrowRowSubscriptions = {
  cases: [
    ...[...unifiedRowSplit, ...sideBySideRowSplit].map(([line, source, rationale, action]) => ({
      action: action ?? ("move-use-value-down" as const),
      expected: "non-enforced" as const,
      file: "viewer/DiffRows.tsx",
      line,
      rationale,
      source,
    })),
    ...(
      [
        [440, documentReadRationale, rowDocument("current")],
        [451, showOnlyHunksRationale, rowPresentation("showOnlyHunks")],
        [519, documentReadRationale, rowDocument("current")],
        [529, showOnlyHunksRationale, rowPresentation("showOnlyHunks")],
      ] as const
    ).map(([line, rationale, source]) => ({
      expected: "excluded" as const,
      file: "viewer/DiffRows.tsx",
      line,
      rationale,
      source,
    })),
    {
      expected: "excluded",
      file: "viewer/DiffRows.tsx",
      line: 294,
      rationale: nativeRowConsolidationRationale,
      source: "useValue(() => rowRender$.nativeRows.unifiedConfigId.get())",
    },
    {
      expected: "excluded",
      file: "viewer/DiffRows.tsx",
      line: 318,
      rationale: nativeRowConsolidationRationale,
      source: "useValue(() => rowRender$.nativeRows.sideBySideConfigId.get())",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 5118,
      rationale: ownerRowPropsRationale,
      source: "const renderRow = useCallback(",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 5154,
      rationale: ownerRowPropsRationale,
      source: "const renderSideBySideRow = useCallback(",
    },
  ],
  commit: "aeaf01a3fda6360c485aa8eaf5a3dc3af9aec3e6",
  parent: "694be0a465add9a7ed75b7e7e77ad9e12bb4f23c",
  repository,
  root,
} as const satisfies ReplayCommit;

const headerFileSelectorRationale =
  "The header uses the two Maps only to pick its file, and a selector returning that file skips the Map rebuilt on every state$ change; the saving holds only if every state$ writer keeps the files entries' identity, a runtime fact.";

const consolidateRowSubscriptions = {
  cases: [
    {
      expected: "excluded",
      file: "viewer/DiffRows.tsx",
      line: 452,
      rationale:
        "Folds the file header's seven presentation leaves into one object selector, which re-renders on any leaf change, so no render is removed.",
      source: rowPresentation("borderColor"),
    },
    {
      action: "narrow-use-value-subscription",
      expected: "non-enforced",
      file: "viewer/DiffRows.tsx",
      line: 454,
      rationale: headerFileSelectorRationale,
      source: rowDocument("fileByIndex"),
    },
    {
      action: "narrow-use-value-subscription",
      expected: "non-enforced",
      file: "viewer/DiffRows.tsx",
      line: 455,
      rationale: headerFileSelectorRationale,
      source: rowDocument("fileByRowStart"),
    },
    {
      expected: "excluded",
      file: "viewer/DiffRows.tsx",
      line: 487,
      rationale:
        "Folds the hunk header's leaves and its info computation into one selector that returns a fresh object, so it re-renders on the same changes.",
      source: rowPresentation("borderColor"),
    },
    {
      expected: "excluded",
      file: "viewer/DiffRows.tsx",
      line: 531,
      rationale:
        "Folds the side-by-side file header's presentation leaves into one object selector, which re-renders on any leaf change, so no render is removed.",
      source: rowPresentation("borderColor"),
    },
    {
      expected: "excluded",
      file: "viewer/DiffRows.tsx",
      line: 533,
      rationale:
        "Folds fileByIndex, fileByRowStart, and sideBySideFileHeaderByListIndex into a selector that returns a fresh { file, fileHeader } object, so it still re-renders on every state$ change.",
      source: rowDocument("fileByIndex"),
    },
    {
      expected: "excluded",
      file: "viewer/DiffRows.tsx",
      line: 572,
      rationale:
        "Folds the side-by-side hunk header's leaves and its info computation into one selector that returns a fresh object, so it re-renders on the same changes.",
      source: rowPresentation("borderColor"),
    },
    {
      expected: "excluded",
      file: "viewer/DiffRows.tsx",
      line: 298,
      rationale:
        "Drops the documentReady read and its placeholder, rendering the native row even without a document, which is a rendering change rather than a narrower subscription.",
      source: "const nativeRow = useValue(() => ({",
    },
    {
      expected: "excluded",
      file: "viewer/DiffRows.tsx",
      line: 327,
      rationale:
        "Drops the documentReady read and its placeholder, rendering the native row even without a document, which is a rendering change rather than a narrower subscription.",
      source: "const nativeRow = useValue(() => ({",
    },
  ],
  commit: "553ae8c310a499e0a164291093289aa5d2e85556",
  parent: "aeaf01a3fda6360c485aa8eaf5a3dc3af9aec3e6",
  repository,
  root,
} as const satisfies ReplayCommit;

const nativeLineSubscriptionRationale =
  "configVersion and rowHeight are rendered into the native row; dropping them relies on the native config component redrawing rows and removes a native prop, which no hook action expresses.";

const removeLineSubscriptions = {
  cases: [
    {
      expected: "excluded",
      file: "viewer/DiffRows.tsx",
      line: 298,
      rationale: nativeLineSubscriptionRationale,
      source: "const nativeRow = useValue(() => ({",
    },
    {
      expected: "excluded",
      file: "viewer/DiffRows.tsx",
      line: 324,
      rationale: nativeLineSubscriptionRationale,
      source: "const nativeRow = useValue(() => ({",
    },
  ],
  commit: "8eb7049c4ec73c4ceee2059de67c10f25f5b0214",
  parent: "553ae8c310a499e0a164291093289aa5d2e85556",
  repository,
  root,
} as const satisfies ReplayCommit;

const tokenRangeRationale =
  "Sends the tokenized row ranges to the native config so native code redraws fewer rows; DiffNativeRowConfigView still re-renders on every tokenization version, so no React render is removed.";

const narrowTokenRedraws = {
  cases: [
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 1758,
      rationale: tokenRangeRationale,
      source: "useValue(() => syntaxTokenizationVersion$.get())",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 2809,
      rationale: tokenRangeRationale,
      source: "useObservable(0)",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 3225,
      rationale: tokenRangeRationale,
      source: effect,
    },
  ],
  commit: "1ee8820b62c5aefd40e7cbb00c633e4969f399fa",
  parent: "8eb7049c4ec73c4ceee2059de67c10f25f5b0214",
  repository,
  root,
} as const satisfies ReplayCommit;

const searchRefMirrorRationale =
  "A ref-mirror effect that the commit replaces with peek() on the new observable; it removes no render.";

const diffSearchCompareOwnership = {
  cases: [
    {
      action: "use-observable",
      expected: "enforced",
      file: "DiffViewerWindow.tsx",
      line: 2964,
      rationale:
        "compareRepoState renders only as DiffWindowChromeController's prop and is otherwise read by the compare command, so each repository-state load re-rendered the viewer owner.",
      source: "useState<DiffCompareRepoState | null>(null)",
    },
    {
      action: "use-observable",
      expected: "enforced",
      file: "DiffViewerWindow.tsx",
      line: 2965,
      rationale:
        "The flag only gates the compare prompt's mount; a gate leaf that returns null while hidden keeps the prompt's conditional mount and removes the owner render on open and close.",
      source: "useState(false)",
    },
    {
      action: "use-observable",
      expected: "enforced",
      file: "DiffViewerWindow.tsx",
      line: 2966,
      rationale:
        "compareRefInput renders only as the prompt's value and is read by the submit command, so every keystroke re-rendered the viewer owner; the prompt can subscribe to an owner-held observable.",
      source: 'useState("")',
    },
    {
      action: "use-observable",
      expected: "enforced",
      file: "DiffViewerWindow.tsx",
      line: 2967,
      rationale:
        "collapsedSidebarFolders is read only as the memoized sidebar pane's prop, so each folder toggle and document reset re-rendered the viewer owner.",
      source: "useState<ReadonlySet<string>>(() => new Set())",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "DiffViewerWindow.tsx",
      line: 2968,
      rationale:
        "searchQuery reaches the status panel and native row config only through owner memos over the whole viewer state; removing the owner render per keystroke needs a computed results observable, both consumers subscribing, and the index reset moved into the setters.",
      source: 'useState("")',
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "DiffViewerWindow.tsx",
      line: 2969,
      rationale:
        "The index reaches the status panel and native row config clamped by owner-derived search results, and two effects rewrite it; the leaf cut needs the results outside the owner and those rewrites moved into setters.",
      source: "useState(0)",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 3185,
      rationale: searchRefMirrorRationale,
      source: effect,
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 3189,
      rationale: searchRefMirrorRationale,
      source: effect,
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 3193,
      rationale: searchRefMirrorRationale,
      source: effect,
    },
    {
      action: "move-to-event",
      expected: "non-enforced",
      file: "DiffViewerWindow.tsx",
      line: 3197,
      rationale:
        "The reset follows searchQuery and loadedDocumentId. The query writers are local events, but documents change through setViewerState in the model provider, and the committed reset keys on document identity rather than documentId.",
      source: effect,
    },
    {
      action: "delete-effect",
      expected: "non-enforced",
      file: "DiffViewerWindow.tsx",
      line: 3201,
      rationale:
        "The clamp rewrites the stored index after results shrink, a second render. The render already clamps, but deleting the effect needs every event reader of the index to clamp too, which the commit adds by hand.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "viewer/diffLoadedDocumentModel.tsx",
      line: 304,
      rationale:
        "Replaces a useSyncExternalStore revision snapshot with a Legend revision observable that notifies on the same commits; granularity is unchanged.",
      source: "useSyncExternalStore(",
    },
  ],
  commit: "0d7ad12aba25306c67cf362a15cf0a523e0ebc2c",
  parent: "aa999ef8052dfba7a4536f56e4019c4a239c48b3",
  repository,
  root: "apps/diff/src",
} as const satisfies ReplayCommit;

const coWrittenMirrorRationale =
  "The setter writes the observable and this state together, and render reads only the state, so the owner renders once per change either way; useValue removes the duplicate copy, not a render.";

const mergeSyntaxMoveRationale =
  "Part of moving mergeSyntaxByPath into an observable that merge rows read; it removes no render by itself.";

const observableUiState = {
  cases: [
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 1609,
      rationale: coWrittenMirrorRationale,
      source: 'useState("")',
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 1611,
      rationale: coWrittenMirrorRationale,
      source: "useState<DiffRecoverableError | null>(null)",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 1612,
      rationale: coWrittenMirrorRationale,
      source: "useState<DiffRecoverableError | null>(null)",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 1614,
      rationale:
        "setLoadingSourceValue writes loadingSource$ inside this state's updater, and the owner renders loadingSource, so it renders once per change either way; moving the write out of the updater is a correctness fix.",
      source: "useState<DiffOpenSource | null>(null)",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 1616,
      rationale:
        "setSidebarCollapsedValue writes sidebarCollapsed$ inside this state's updater, and the owner renders sidebarCollapsed, so it renders once per toggle either way.",
      source: "useState(false)",
    },
    {
      action: "use-value",
      expected: "non-enforced",
      file: "DiffViewerWindow.tsx",
      line: 1633,
      rationale:
        "handleSplitViewResize builds a new rounded metrics object on every resize event, so this state re-renders the owner even when no field changed, while a useValue on splitPaneMetrics$ skips a set whose fields all match; the saving rests on native resize events repeating rounded metrics, a runtime fact.",
      source: "useState({",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 1639,
      rationale:
        "The pane height is a rounded number co-written with diffPaneHeight$; useState already bails out on an equal number, so useValue renders the owner exactly as often.",
      source: "useState(0)",
    },
  ],
  commit: "afaec7452b2ec51840b8bd37f2505dcbbfc5eb02",
  parent: "98c8fe59b4ac4428ff2763f4da254d93fa13bd38",
  repository,
  root,
} as const satisfies ReplayCommit;

const localizedMergeSyntax = {
  cases: [
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 1877,
      rationale:
        "The leaf half of the merge syntax move: the row subscribes to its file's entry and derives syntax lines and tokens from a new rowIndex prop.",
      source: "function DiffMergeLineRow({",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "DiffViewerWindow.tsx",
      line: 2037,
      rationale:
        "mergeSyntaxByPath is read only in renderMergeRow and in a version memo for an extraData object no caller reads, so an owner-held observable stops each highlight result from re-rendering DiffLoadedBody; the rows receive per-row derivations, so the leaf cut also needs DiffMergeLineRow to take a rowIndex prop and derive them itself.",
      source: "useState<Map<string, DiffMergeSyntaxState>>(() => new Map())",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 2062,
      rationale:
        "Deletes a version memo that feeds only mergeListExtraData, which no caller reads; it cost only memo bookkeeping.",
      source: "const mergeSyntaxVersion = useMemo(",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 2066,
      rationale: "Drops the deleted version from an extraData memo that no caller reads.",
      source: "const mergeListExtraData = useMemo(() => ({",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 2145,
      rationale: mergeSyntaxMoveRationale,
      source: "const renderMergeRow = useCallback(",
    },
    {
      expected: "excluded",
      file: "DiffViewerWindow.tsx",
      line: 2189,
      rationale: mergeSyntaxMoveRationale,
      source: "useEffect(() => {",
    },
  ],
  commit: "bb325a532c9ef2d1cb993284767fc37c30db32b2",
  parent: "f06e018aebd363d6d1689e01720368921d568ef3",
  repository,
  root,
} as const satisfies ReplayCommit;

/** Jay Meistrich's Diff viewer subscription commits, classified against each parent tree. */
export const legendAppsDiffReplayCommits: readonly ReplayCommit[] = [
  collapseSubscriptions,
  resizeSubscriptions,
  openStateSubscriptions,
  noChangesSelector,
  scrollRerenders,
  scrollRerendersVirtualizedDocument,
  viewerMemoChurn,
  narrowRowSubscriptions,
  consolidateRowSubscriptions,
  removeLineSubscriptions,
  narrowTokenRedraws,
  diffSearchCompareOwnership,
  observableUiState,
  localizedMergeSyntax,
];
