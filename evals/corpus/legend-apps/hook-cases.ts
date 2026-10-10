import type { GoldHookCase } from "../contracts.js";

export const legendAppsHookCases = [
  {
    action: "use-observable",
    enforced: false,
    file: "MarkdownE2EEditorSmoke.tsx",
    hook: "useState",
    line: 117,
    name: "selectionAnchor",
    rationale:
      "The anchor is written only by the selection callback and read only as MarkdownDocument's toolbar prop, so a leaf subscriber around that stable call site would keep the smoke owner and its status and command rows out of every selection change. The anchor is an object, though: Legend skips notifying for a structurally equal replacement, so the leaf can keep passing the previous reference, and MarkdownDocument runs an effect keyed on that prop's identity. The effect republishes an equal anchor here, but no static proof shows that.",
    target: "legend-apps-markdown",
  },
  {
    action: "use-observable",
    file: "MarkdownEditorWindow.tsx",
    hook: "useState",
    line: 89,
    name: "isLinkPopoverOpen",
    rationale:
      "The flag only transports into MarkdownEditorSessionContent, while the owner runs a synchronous theme load and a dozen settings and window hooks on every render; a leaf subscriber opens and closes the link popover without rerunning that owner.",
    target: "legend-apps-markdown",
  },
  ...[
    ["DiffViewerWindow.tsx", 2368, "mergeDocumentSession"],
    ["DiffViewerWindow.tsx", 2404, "sideBySideSession"],
    ["DiffViewerWindow.tsx", 2448, "unifiedSession"],
    ["viewer/diffLoadedDocumentModel.tsx", 289, "sideBySideSession"],
  ].map(([file, line, name]) => ({
    action: "keep-state" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "The render body replaces the session when its document changes and sets it in the same render; React re-runs that render before committing, while an observable written there would notify subscribers mid-render.",
    target: "legend-apps-diff",
  })),
] as const satisfies readonly GoldHookCase[];
