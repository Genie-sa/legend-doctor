import type { ReplayCommit } from "../contracts.js";

const repository = "legend-apps";
const effect = "useEffect(() => {";
const markdownDocumentRoot = "packages/markdown-document/src";
const chatHistoryRoot = "apps/chat-history/src";

const documentIdentityRationale =
  "The session's filename and documentSource gate the whole editor tree, feed MarkdownDocument, and drive the file-watcher effect; the cut re-renders the entire content child anyway and moves the watcher effect into a child, which reorders effects, so it saves only the owner's hook bodies.";

const markdownSessionChrome = {
  cases: [
    {
      action: "move-use-value-down",
      expected: "non-enforced",
      file: "useMarkdownDocumentSession.ts",
      line: 45,
      rationale: documentIdentityRationale,
      source: "useValue(sessionState$.filename)",
    },
    {
      action: "move-use-value-down",
      expected: "enforced",
      file: "useMarkdownDocumentSession.ts",
      line: 46,
      rationale:
        "The hook's only consumer reads isDirty solely in the untitled placeholder condition, so each dirty flip re-rendered the editor window and MarkdownDocument with fresh inline props; a placeholder leaf that subscribes itself keeps the read.",
      source: "useValue(sessionState$.isDirty)",
    },
    {
      action: "move-use-value-down",
      expected: "enforced",
      file: "useMarkdownDocumentSession.ts",
      line: 47,
      rationale:
        "The hook's only consumer renders lastError solely in the error text and the placeholder condition, so each error set or clear re-rendered the whole editor window; two leaves that subscribe themselves keep both reads.",
      source: "useValue(sessionState$.lastError)",
    },
    {
      action: "move-use-value-down",
      expected: "non-enforced",
      file: "useMarkdownDocumentSession.ts",
      line: 48,
      rationale: documentIdentityRationale,
      source: "useValue(sessionState$.documentSource)",
    },
    {
      action: "peek-unrendered-use-value",
      expected: "enforced",
      file: "useMarkdownDocumentSession.ts",
      line: 49,
      rationale:
        "The hook returns saveState but its only consumer never reads session.saveState, so every save-state transition re-rendered the editor window for nothing.",
      source: "useValue(sessionState$.saveState)",
    },
    {
      expected: "excluded",
      file: "MarkdownEditorWindow.tsx",
      line: 141,
      rationale:
        "Moves the file-watcher effect unchanged into a null-rendering child; it belongs to the filename and documentSource cut and removes no effect run by itself.",
      source: "useEffect(() => {",
    },
    {
      expected: "excluded",
      file: "MarkdownEditorWindow.tsx",
      line: 262,
      rationale:
        "Wraps MarkdownDocument in a memo surface with memoized style and savePolicy props, identity memoization that no action in the vocabulary expresses.",
      source: "<MarkdownDocument",
    },
  ],
  commit: "81e856fa681615e23672ff78527da487cc7cfbe6",
  parent: "53e88f50bf88b7498e1b5a223204442bb81cb995",
  repository,
  root: "apps/markdown/src",
} as const satisfies ReplayCommit;

const nativeDraftRerenders = {
  cases: [
    {
      action: "use-ref",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 432,
      rationale:
        "On macOS the typing path stops setting activeSelection, but the value still reaches the active row and the overlay input through the render-state effect; skipping it is safe only because the native editor owns the selection, a runtime fact.",
      source: "useState(0)",
    },
    {
      action: "use-ref",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 440,
      rationale:
        "On macOS each keystroke stops setting draftMarkdown, but the draft still renders as the overlay input's and active row's markdown; skipping it is safe only because the native editor owns its text, a runtime fact.",
      source: 'useState("")',
    },
  ],
  commit: "cfca6dee3454c0baa91044954e31f25bcc0bb894",
  parent: "e442cf033e218bf8d31df99809c9321ec43c1013",
  repository,
  root: markdownDocumentRoot,
} as const satisfies ReplayCommit;

const markdownRowState = {
  cases: [
    {
      expected: "excluded",
      file: "MarkdownDocument.tsx",
      line: 454,
      rationale:
        "markdownRenderRevision changes only together with resolvedMarkdownStyle, which rows still receive through props and extraData, so dropping it removes no row render.",
      source: "const markdownRenderRevisionRef = useRef({",
    },
    {
      expected: "excluded",
      file: "MarkdownDocument.tsx",
      line: 707,
      rationale:
        "Rows relied on this callback's per-transaction identity change to re-read native block data; replacing the documentState dependency with a ref needs per-row revision bumps driven by the native changedRange, and no action narrows a render callback's dependencies.",
      source: "const getBlockAtIndexForRender = useCallback(",
    },
    {
      expected: "excluded",
      file: "MarkdownDocument.tsx",
      line: 2655,
      rationale:
        "The owner still renders blockIds as list data; rows now read neighbors from a ref during render, and their freshness rests on the native changedRange bumping every affected row, a runtime fact no action proves.",
      source: "hasNextBlock={props.index + 1 < blockIds.length}",
    },
    {
      action: "move-use-value-down",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 2657,
      rationale:
        "commentAnchor is a prop broadcast to every row through renderItem and extraData; the per-row cut needs a new row-state observable written by an effect after commit, so the bubble appears one commit later.",
      source: "commentAnchor={commentAnchor?.blockId === props.item ? commentAnchor : null}",
    },
  ],
  commit: "bbf3a475f5180ea4d7ea5a373970b588e68d1ca8",
  parent: "cfca6dee3454c0baa91044954e31f25bcc0bb894",
  repository,
  root: markdownDocumentRoot,
} as const satisfies ReplayCommit;

const savedSelectionSeedRationale =
  "Seeds the initial state from persisted storage so the saved chat opens before the catalog scan; this moves startup I/O earlier and removes no render.";

const persistentTranscriptList = {
  cases: [
    {
      expected: "excluded",
      file: "App.tsx",
      line: 277,
      rationale:
        "The memo now accepts a missing document so the pane keeps one TranscriptList mounted across chat switches; the saved list remount is a mount-identity change that no action expresses.",
      source: "useMemo(() => new TranscriptDataSource(document), [document])",
    },
    {
      expected: "excluded",
      file: "ChatComposer.tsx",
      line: 20,
      rationale:
        "The added transcriptId effect clears the draft that the old remount used to reset; it preserves behavior and adds a run rather than removing one.",
      source: 'useState("")',
    },
  ],
  commit: "72240e86a26318eb5ca31b786009f9b2c0462304",
  parent: "0bec38ef98007917477d410a611899982828f226",
  repository,
  root: chatHistoryRoot,
} as const satisfies ReplayCommit;

const visibleTranscriptWhileSwitching = {
  cases: [
    {
      expected: "excluded",
      file: "App.tsx",
      line: 170,
      rationale:
        "Dropping the loading flag removes the spinner render on each switch but also removes the loading screen and keeps the previous transcript visible, a UX change.",
      source: "useState<TranscriptState>({ loading: false })",
    },
  ],
  commit: "ff5422c1ef325150be9c2d6b41d68ad4757b49d5",
  parent: "7f91ff7c8cb566355a600ff75e545e4dcce69f43",
  repository,
  root: chatHistoryRoot,
} as const satisfies ReplayCommit;

const composerInitialHeight = {
  cases: [
    {
      expected: "excluded",
      file: "App.tsx",
      line: 274,
      rationale:
        "The initial height now equals the composer's measured 88 pt, so the first onHeightChange bails out; that saving rests on a native layout measurement, not a static fact.",
      source: "useState(CHAT_COMPOSER_INITIAL_HEIGHT)",
    },
  ],
  commit: "a1a6354c077f51a81fe752262c12c67e32cc6bb1",
  parent: "40dddd549972e3939212d75fec345b3a526d794b",
  repository,
  root: chatHistoryRoot,
} as const satisfies ReplayCommit;

const restoredSelectionBeforeScan = {
  cases: [
    {
      expected: "excluded",
      file: "App.tsx",
      line: 486,
      rationale: savedSelectionSeedRationale,
      source: "useState<ChatSummary[]>([])",
    },
    {
      expected: "excluded",
      file: "App.tsx",
      line: 487,
      rationale: savedSelectionSeedRationale,
      source: "useState<string | undefined>()",
    },
  ],
  commit: "36ecf0721f82f85a76db7bae8c184ca37e0d02b9",
  parent: "a1a6354c077f51a81fe752262c12c67e32cc6bb1",
  repository,
  root: chatHistoryRoot,
} as const satisfies ReplayCommit;

const activeRowPublicationRationale =
  "Rendered nowhere; the owner reads it only in the layout effect that publishes the active row to documentRenderState$. Dropping its render needs that publication moved into every setter of the four active-editor states, trading post-commit for write-time publication.";

const markdownEditorOwnership = {
  cases: [
    {
      expected: "excluded",
      file: "MarkdownDocument.tsx",
      line: 508,
      rationale:
        "activeBlockId still renders in the owner through alwaysRenderActiveBlock and the native host prop, and the commit keeps an owner useValue of it, so moving its storage removes no render.",
      source: "useState<string | null>(null)",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 509,
      rationale: activeRowPublicationRationale,
      source: "useState(0)",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 512,
      rationale: activeRowPublicationRationale,
      source: 'useState<ActiveBlockRenderState["activationMode"]>("programmatic")',
    },
    {
      action: "use-value",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 513,
      rationale:
        "A passive effect mirrors this state into documentRenderState$.blockSelection, so each change costs the anchor publisher a second commit. The owner still renders blockSelection, and making the observable the owner moves the publisher's update ahead of the owner's commit.",
      source: "useState<BlockSelectionState | null>(null)",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 520,
      rationale:
        "draftMarkdown renders only as the native host's activeBlockMarkdown fallback, but it also keys the vertical-navigation effect and the active-row layout effect; the leaf cut needs a wrapper around the native host and both effects moved out of React.",
      source: 'useState("")',
    },
    {
      action: "use-observe-effect",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 1091,
      rationale:
        "Its triggers activeBlockId and draftMarkdown are React state here, so the observer needs both converted first, and it schedules the navigation frame at write time instead of after the row commits.",
      source: effect,
    },
    {
      action: "delete-effect",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 3040,
      rationale:
        "The effect only mirrors blockSelection into the observable; deleting it requires the observable to own the value, the conversion labeled at line 513.",
      source: effect,
    },
    {
      action: "move-to-event",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 3043,
      rationale:
        "The layout effect republishes the active row after each commit of four React states; moving it into their setters reads activeBlockSnapshotRef at write time and removes an owner render only once all four leave React state.",
      source: "useLayoutEffect(() => {",
    },
    {
      action: "move-to-event",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 3078,
      rationale:
        "The effect publishes selected-row flags after blockSelection or the data revision commits. Publishing from the setter reads block indexes at write time, which is equivalent only if every transaction updates the data source before calling setNextBlockSelection.",
      source: effect,
    },
    {
      action: "move-use-value-into-child",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 3234,
      rationale:
        "The owner reads only block.markdown from the whole active-row record, and only for the native host's activeBlockMarkdown prop. The cut needs a wrapper around the native host that also reads the draftMarkdown fallback and the activeBlockId key, both React state here.",
      source: 'useValue(documentRenderState$.activeBlocksById.get(activeBlockId ?? ""))',
    },
  ],
  commit: "53d36caf99a4858ae67dc7fb635a8a1d7ab6771d",
  parent: "248bda38e1d5457a7de0c79734b53d28cf6db91f",
  repository,
  root: "packages/markdown-document/src",
} as const satisfies ReplayCommit;

const catalogStatusRationale =
  "catalogError and catalogLoading render only in the empty-state branch, but they change with summaries on success and with each other on failure; an owner render disappears only on a catalog error and only when both move.";

const chatHistorySession = {
  cases: [
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "App.tsx",
      line: 549,
      rationale:
        "summaries renders the sidebar list but also derives selectedSummary, which keys the title and transcript-open effects; taking it out of the window render needs both effects rewritten as observers.",
      source: "useState<ChatSummary[]>(",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "App.tsx",
      line: 552,
      rationale:
        "Every selection re-rendered the window and, through extraData, every sidebar row. selectedId also derives selectedSummary for the title and transcript-open effects, so the per-row selector saves the window render only after both effects become observers.",
      source: "useState<string | undefined>(savedSelection.selectedId)",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "App.tsx",
      line: 553,
      rationale: catalogStatusRationale,
      source: "useState<string | undefined>()",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "App.tsx",
      line: 554,
      rationale: catalogStatusRationale,
      source: "useState(true)",
    },
    {
      action: "use-observable",
      expected: "enforced",
      file: "App.tsx",
      line: 555,
      rationale:
        "transcriptState is read only as TranscriptPane's state prop, so every loading, ready, and error transition re-rendered the window and the unmemoized sidebar. The pane can subscribe to an owner-held observable; the commit stores the native document opaque.",
      source: 'useState<TranscriptState>({ status: "idle" })',
    },
    {
      action: "use-observe-effect",
      expected: "non-enforced",
      file: "App.tsx",
      line: 563,
      rationale:
        "selectedTitle derives from summaries and selectedId, React state that also renders the sidebar and transcript; the observer needs both as observables and calls setMainWindowOptions before commit.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "App.tsx",
      line: 659,
      rationale:
        "The observer keys on id, provider, and path instead of the summary object, so a refreshed summary with a new updatedAt or title no longer reopens the transcript, and it adds unmount cleanup; both change behavior.",
      source: effect,
    },
  ],
  commit: "aa999ef8052dfba7a4536f56e4019c4a239c48b3",
  parent: "53d36caf99a4858ae67dc7fb635a8a1d7ab6771d",
  repository,
  root: "apps/chat-history/src",
} as const satisfies ReplayCommit;

const hotkeyCaptureSelectors = {
  cases: [
    {
      action: "select-primitive-projection",
      expected: "non-enforced",
      file: "index.tsx",
      line: 815,
      rationale:
        "activeCaptureId is read only in a comparison with a per-instance constant, so every capture switch re-rendered every HotkeyCapture. The projection is sound, but the source is a module-level useSyncExternalStore store, so the Legend selector needs that store migrated first.",
      source: "useSyncExternalStore(",
    },
  ],
  commit: "be2e8425250a0e55163fd56ed693e410aa977e97",
  parent: "a7a8e2185a17e03595777b2048a94a1dd17c7aff",
  repository,
  root: "packages/hotkeys/src",
} as const satisfies ReplayCommit;

const documentRowMetadata = {
  cases: [
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "index.tsx",
      line: 368,
      rationale:
        "rowsState's styles and timing are returned to the hook's callers; observable metadata saves a render only where a caller moves those reads into leaves, and the Code caller still subscribes to both in its owner in this commit.",
      source: "useState(() => createRowsState(snapshot, 0))",
    },
    {
      action: "delete-derived-state",
      expected: "non-enforced",
      file: "index.tsx",
      line: 375,
      rationale:
        "The effect re-seeds rowsState after each snapshot change, a second render, but the render derives the reset only when the document changes, so a new snapshot for the same document relies on the effect. The snapshot-keyed session also changes the dataVersion sequence, whose allocation 61090d27 moved out of render.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "index.tsx",
      line: 387,
      rationale:
        "A ref mirror of the active rows state; the session closure replaces it and no render is removed.",
      source: effect,
    },
  ],
  commit: "69a889168079254aa24d80f944bb0534d4985adb",
  parent: "0ea5341ad6975b4d141c0adf5246a28a097dfb68",
  repository,
  root: "packages/virtualized-document/src",
} as const satisfies ReplayCommit;

const documentRowMetadataConsumer = {
  cases: [
    {
      expected: "excluded",
      file: "CodeViewerWindow.tsx",
      line: 132,
      rationale:
        "Adapts the Code window to the styles$ and timing$ API; the owner subscribes to both and still renders on every metadata update.",
      source: "const stylesForState = sourceRows.styles;",
    },
  ],
  commit: "69a889168079254aa24d80f944bb0534d4985adb",
  parent: "0ea5341ad6975b4d141c0adf5246a28a097dfb68",
  repository,
  root: "apps/code/src",
} as const satisfies ReplayCommit;

const codeDocumentSessions = {
  cases: [
    {
      expected: "excluded",
      file: "CodeViewerWindow.tsx",
      line: 107,
      rationale:
        "CodeViewerContent subscribes to the whole state and renders the former window body, so the observable keeps the same render per state change; the late-load guard is a bug fix.",
      source: "useState<CodeViewerState>(emptyState)",
    },
    {
      action: "move-use-value-down",
      expected: "non-enforced",
      file: "CodeViewerWindow.tsx",
      line: 132,
      rationale:
        "The styles are read only to build tokenStyleById for renderLine's rows, but one metadata$.set writes styles and timing together and notifies both on a snapshot's first write, so moving styles alone leaves the window rendering through sourceTiming; the expert moved both.",
      source: "useValue(sourceRows.styles$)",
    },
    {
      action: "move-use-value-down",
      expected: "non-enforced",
      file: "CodeViewerWindow.tsx",
      line: 133,
      rationale:
        "sourceTiming renders only in the host subtitle text, but one metadata$.set writes timing and styles together and notifies both on a snapshot's first write, so a subtitle leaf alone leaves the window rendering through stylesForState; the expert moved both.",
      source: "useValue(sourceRows.timing$)",
    },
    {
      action: "use-observe-effect",
      expected: "enforced",
      file: "CodeViewerWindow.tsx",
      line: 257,
      rationale:
        "fileRequest is read only by this effect, which starts a load; observing codeViewerFileRequest$ removes the window render each request caused before the load's own state update.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "CodeViewerWindow.tsx",
      line: 268,
      rationale:
        "state still renders the viewer body, so the observer removes no render and only moves the theme reload ahead of commit.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "CodeViewerWindow.tsx",
      line: 284,
      rationale:
        "filePath still renders the title, so the observer removes no render and only moves the window-options call ahead of commit.",
      source: effect,
    },
  ],
  commit: "eb0d9f86de692ddf6c3d5a2508c6ff06f366dd68",
  parent: "69a889168079254aa24d80f944bb0534d4985adb",
  repository,
  root: "apps/code/src",
} as const satisfies ReplayCommit;

const markdownTransactionMetadata = {
  cases: [
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 518,
      rationale:
        "blockDataRevision renders nowhere in the owner and reaches only the selection-anchor publisher's effect dependencies through the footer props; removing the owner render needs that publisher's effect turned into an observer, which runs it at write time instead of after commit.",
      source: "useState(0)",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 533,
      rationale:
        "documentState renders only through its status, error message, and loaded document ID, while every transaction replaces it with a blockCount and sourceSize that only commands read. Dropping those renders turns the commands' render-time snapshots into call-time reads, so a split queued behind an unrendered transaction computes blockCount from the newer snapshot.",
      source: 'useState<DocumentState>({ status: "loading" })',
    },
  ],
  commit: "c9b2f24d8e43856786831b9fd85cf05e873a5f3d",
  parent: "ab64a094b5b6ab9e3e471d77060770c65d12f9e4",
  repository,
  root: "packages/markdown-document/src",
} as const satisfies ReplayCommit;

const markdownSelectionDrag = {
  cases: [
    {
      action: "move-use-value-into-child",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 526,
      rationale:
        "Native drag ticks replace blockSelection with new offsets while the owner reads it only in commands, null checks, two block IDs, and the host's textSelectionJson prop, which the existing host wrapper can own. The focus effect keyed on the selection object reran on every tick, though, and keying it on a boolean drops those deferred focus() calls.",
      source: "useValue(documentRenderState$.blockSelection)",
    },
  ],
  commit: "51ae3eb36e807204bb00bbbbec0c6a01052a57ef",
  parent: "ce9f709cbbb0b3e70314e2c9a8387580b8647eb4",
  repository,
  root: "packages/markdown-document/src",
} as const satisfies ReplayCommit;

const preparedDocumentSeedRationale =
  "Seeds the initial state from a new native prepareDocument snapshot so the ready event no longer sets it; the saved render depends on a native preload API the commit adds, which no action expresses.";

const codeViewerPreparedDocument = {
  cases: [
    {
      expected: "excluded",
      file: "CodeViewerWindow.tsx",
      line: 95,
      rationale:
        "The effect now consumes a single-use prepared-document token from the request observable; this is feature plumbing for native preloading and removes no run.",
      source: "useEffect(() => {",
    },
  ],
  commit: "174582d373e7c14ef9cb2b167023c6be4def3e3e",
  parent: "c2e895c5df4072755b7991ec18fe8bc4f475bc9e",
  repository,
  root: "apps/code/src",
} as const satisfies ReplayCommit;

const sourceEditorPreparedDocument = {
  cases: [
    ["useState<SourceLineDataSource | null>(null)", 89],
    ['useState("")', 90],
    ["useState(false)", 92],
    ['useState(() => initialSource?.slice(0, 512) ?? "")', 94],
  ].map(([source, line]) => ({
    expected: "excluded" as const,
    file: "index.tsx",
    line: line as number,
    rationale: preparedDocumentSeedRationale,
    source: source as string,
  })),
  commit: "174582d373e7c14ef9cb2b167023c6be4def3e3e",
  parent: "c2e895c5df4072755b7991ec18fe8bc4f475bc9e",
  repository,
  root: "packages/source-editor/src",
} as const satisfies ReplayCommit;

const selectionAnchorWindowRoundTrip = {
  cases: [
    {
      action: "move-state-down",
      equivalents: ["use-observable"],
      expected: "non-enforced",
      file: "MarkdownEditorWindow.tsx",
      line: 65,
      rationale:
        "selectionAnchor mirrors MarkdownDocument's own derived anchor: the document's post-commit effect writes it through onSelectionAnchorChange and the window renders it only back into selectionToolbarAnchor, so every anchor change re-rendered the window and the whole unmemoized document a second time. Cutting the round trip needs MarkdownDocument to publish its anchor to the footer behind a new selectionToolbarEnabled prop, an API change in another package.",
      source: "useState<MarkdownSelectionAnchor | null>(null)",
    },
  ],
  commit: "d141408eb0069ede4d9d89664b09f5f19a72136e",
  parent: "9c57aea5f5faf09f7815ee0267c8b45a93dc7b61",
  repository,
  root: "apps/markdown/src",
} as const satisfies ReplayCommit;

const selectionAnchorDocumentPublisher = {
  cases: [
    {
      expected: "excluded",
      file: "MarkdownDocument.tsx",
      line: 2125,
      rationale:
        "The publisher effect now also writes selectionAnchor$ with the same post-commit timing; it adds a write and removes no run, and the render it saves belongs to the window state labeled under apps/markdown.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "MarkdownDocument.tsx",
      line: 2128,
      rationale: "The unmount cleanup also clears selectionAnchor$; no run changes.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "MarkdownDocument.tsx",
      line: 2213,
      rationale:
        "The footer becomes a memo leaf subscribed to selectionAnchor$, but the document still renders on each anchor change it derives itself; the saved render is the window round trip labeled under apps/markdown.",
      source: "const selectionToolbarFooter = useMemo(() => {",
    },
  ],
  commit: "d141408eb0069ede4d9d89664b09f5f19a72136e",
  parent: "9c57aea5f5faf09f7815ee0267c8b45a93dc7b61",
  repository,
  root: markdownDocumentRoot,
} as const satisfies ReplayCommit;

const markdownSessionObservable = {
  cases: [
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "MarkdownEditorWindow.tsx",
      line: 65,
      rationale:
        "documentCommandState is read only by the menu-state effect in useMarkdownMenus, so each undo or redo availability change re-rendered the window and the unmemoized MarkdownDocument; dropping that render needs the effect in another module turned into an observer too.",
      source: "useState<MarkdownDocumentCommandState>({",
    },
    {
      expected: "excluded",
      file: "useMarkdownDocumentSession.ts",
      line: 23,
      rationale:
        "filename still renders the document gate, MarkdownDocument's filename prop, and the window options through an owner useValue, so the observable keeps every render.",
      source: "useState<string | null>(null)",
    },
    {
      expected: "excluded",
      file: "useMarkdownDocumentSession.ts",
      line: 24,
      rationale:
        "lastError still renders the error text through an owner useValue, so no render is removed.",
      source: "setLastError] = useState<string | null>(null)",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "useMarkdownDocumentSession.ts",
      line: 25,
      rationale:
        "isDirty renders nothing: the window passes it only to the menu-state and window-options effects in two other modules, and the transition callbacks read it, so every dirty flip re-rendered the window and MarkdownDocument and re-registered the native menu through new handler identities. The saving needs both effects turned into observers, which run their native calls at write time instead of after commit.",
      source: "useState(false)",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "useMarkdownDocumentSession.ts",
      line: 26,
      rationale:
        "saveState is read only by the menu-state effect in useMarkdownMenus, so each idle, saving, and saved transition re-rendered the window and MarkdownDocument; dropping that render needs the effect turned into an observer too.",
      source: 'useState<MarkdownSaveState>("idle")',
    },
    {
      expected: "excluded",
      file: "useMarkdownDocumentSession.ts",
      line: 27,
      rationale:
        "documentSource still selects the adapter, autoFocusFirstBlock, and the autosave policy through an owner useValue, so no render is removed.",
      source: 'useState<DocumentSource>("untitled")',
    },
    {
      expected: "excluded",
      file: "useMarkdownMenus.ts",
      line: 50,
      rationale:
        "revealInFinder reads the path at call time, so file switches no longer rebuild the handlers and re-run useNativeMenu's registration effect, but filename still renders the window; no action narrows a memo's dependencies to a call-time read.",
      source: "const menuHandlers = useMemo<NativeMenuActionHandlers>(() => ({",
    },
    {
      action: "use-observe-effect",
      expected: "non-enforced",
      file: "useMarkdownMenus.ts",
      line: 103,
      rationale:
        "isDirty, saveState, and documentCommandState are React state at the parent, so the observer saves no render until all three move to the session observable, and the committed observer reads the whole session, adding updateMenuItems runs on lastError changes.",
      source: effect,
    },
    {
      action: "use-observe-effect",
      expected: "non-enforced",
      file: "useMarkdownWindows.ts",
      line: 33,
      rationale:
        "filename and documentSource still render the window and isDirty is React state at the parent; the committed observer reads the whole session, so command-state and save-state changes now repeat setMarkdownEditorWindowOptions, native calls the dependency list skipped.",
      source: effect,
    },
  ],
  commit: "e94023f3cdf89a20c95f7e00f4addb071b6ce70d",
  parent: "77eeb5f158835bbfb095cc2d6ab18b8b6f9f9e03",
  repository,
  root: "apps/markdown/src",
} as const satisfies ReplayCommit;

const textSelectionPublication = {
  cases: [
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 332,
      rationale:
        "textSelectionAnchor renders nowhere; the owner reads it only through internalSelectionAnchor in the effect that publishes to selectionAnchor$. Dropping the owner render needs that publication moved into the setters, which publish at write time and gate on blockSelectionRef instead of the committed blockSelection.",
      source: "setTextSelectionAnchor] = useState<MarkdownSelectionAnchor | null>(null)",
    },
    {
      action: "move-to-event",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 2253,
      rationale:
        "The effect republishes the anchor after textSelectionAnchor or blockSelection commits. Publishing from the text-anchor setters drops the republication when a block selection clears, which matches only if every path that clears a block selection also clears the text anchor.",
      source: effect,
    },
  ],
  commit: "5583b36f980b25ac9abafbc1bef0ba80745b3f2a",
  parent: "8680d1ec80c9f79791724d624504d52fe50d8209",
  repository,
  root: markdownDocumentRoot,
} as const satisfies ReplayCommit;

const markdownRowWidth = {
  cases: [
    {
      action: "use-observable",
      expected: "enforced",
      file: "MarkdownBlockRow.tsx",
      line: 230,
      rationale:
        "rowWidth renders only as the memoized MarkdownEditorInput's prop in the non-overlay active branch, and the inactive branch reads it in onPress, so each row's first onLayout from 700 to its measured width and every resize re-rendered the whole row. The single-call-site input can subscribe to a row-owned observable that onPress peeks.",
      source: "useState(700)",
    },
  ],
  commit: "48659c85f7ee0c13009b6015f4cc8ce2902b83c9",
  parent: "5583b36f980b25ac9abafbc1bef0ba80745b3f2a",
  repository,
  root: markdownDocumentRoot,
} as const satisfies ReplayCommit;

const markdownLayoutMetrics = {
  cases: [
    {
      action: "use-ref",
      expected: "enforced",
      file: "MarkdownDocument.tsx",
      line: 328,
      rationale:
        "containerWindowY renders nowhere; blockIdAtWindowY and handleBlockWindowLayout read it at call time, and only a requestAnimationFrame measurement writes it, so each container measure re-rendered MarkdownDocument and changed renderMarkdownBlockRow's identity through handleBlockWindowLayout.",
      source: "setContainerWindowY] = useState(0)",
    },
    {
      action: "use-ref",
      expected: "non-enforced",
      file: "MarkdownDocument.tsx",
      line: 331,
      rationale:
        "contentContainerOffsetX is read only inside updateTextSelectionAnchor, but the container onLayout handler writes it together with the rendered inactiveOverlayWidth; the ref saves a render only when the container is wider than resolvedContentMaxWidth, so the offset changes while the clamped width stays equal, a layout fact.",
      source: "setContentContainerOffsetX] = useState(0)",
    },
  ],
  commit: "dcebe48720c671a815b5be50f2af47ed84e45c69",
  parent: "48659c85f7ee0c13009b6015f4cc8ce2902b83c9",
  repository,
  root: markdownDocumentRoot,
} as const satisfies ReplayCommit;

const inactiveOverlayWidthLeaves = {
  cases: [
    {
      action: "use-observable",
      expected: "enforced",
      file: "MarkdownDocument.tsx",
      line: 335,
      rationale:
        "inactiveOverlayWidth renders only as props of the memoized MarkdownBlockSelectionAnchorPublisher and MarkdownOverlayEditorInput, and two callbacks read it at call time; the container onLayout handler writes no other React state, so each container resize re-rendered all of MarkdownDocument. Both children can subscribe to an owner observable.",
      source: "setInactiveOverlayWidth] = useState(contentMaxWidth - contentHorizontalPadding * 2)",
    },
  ],
  commit: "9bb020a21b530e1ee00346fbecdbee84f8ff6568",
  parent: "dcebe48720c671a815b5be50f2af47ed84e45c69",
  repository,
  root: markdownDocumentRoot,
} as const satisfies ReplayCommit;

/** Jay Meistrich's Markdown, Code, Chat History, hotkey, and document-row commits, classified against each parent tree. */
export const legendAppsDocumentsReplayCommits: readonly ReplayCommit[] = [
  markdownSessionChrome,
  nativeDraftRerenders,
  markdownRowState,
  persistentTranscriptList,
  visibleTranscriptWhileSwitching,
  composerInitialHeight,
  restoredSelectionBeforeScan,
  markdownEditorOwnership,
  chatHistorySession,
  hotkeyCaptureSelectors,
  documentRowMetadata,
  documentRowMetadataConsumer,
  codeDocumentSessions,
  markdownTransactionMetadata,
  markdownSelectionDrag,
  codeViewerPreparedDocument,
  sourceEditorPreparedDocument,
  selectionAnchorWindowRoundTrip,
  selectionAnchorDocumentPublisher,
  markdownSessionObservable,
  textSelectionPublication,
  markdownRowWidth,
  markdownLayoutMetrics,
  inactiveOverlayWidthLeaves,
];
