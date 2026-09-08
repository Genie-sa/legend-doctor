import type { GoldHookCase } from "../contracts.js";

export const outlineHookCases = [
  {
    action: "use-observable",
    file: "DocumentDelete.tsx",
    hook: "useState",
    line: 24,
    name: "isDeleting",
    rationale:
      "The intrinsic form submit owns the awaited delete command and its finally reset. The flag only selects the submit-button label; subscribing at that existing button preserves the command, routing, error handling, and sibling archive state without rerendering the explanatory content.",
    target: "outline-document-delete",
  },
  {
    action: "review-state",
    file: "Input.tsx",
    hook: "useState",
    line: 199,
    name: "focused",
    rationale:
      "The same owner creates merged callback refs for its inputs; isolating focus updates would change their detach and attach cadence.",
    target: "outline-input",
  },
  {
    action: "keep-effect",
    file: "PasskeyAuthenticationProvider.tsx",
    hook: "useEffect",
    line: 116,
    name: null,
    rationale:
      "The hidden WebAuthn form can only be submitted through its ref after React commits the generated ceremony fields.",
    target: "outline-passkey-provider",
  },
  {
    action: "review-effect",
    file: "PasskeyAuthenticationProvider.tsx",
    hook: "useEffect",
    line: 124,
    name: null,
    rationale:
      "The desktop redirect effect mixes a mutable guard ref with environment checks and an authentication command, so ref syntax alone does not prove a pure committed-ref integration.",
    target: "outline-passkey-provider",
  },
  {
    action: "use-observable",
    file: "ApiKeyListItem.tsx",
    hook: "useState",
    line: 80,
    name: "copied",
    rationale:
      "The copy timer changes only one button-local presentation gate in a broad list row.",
    target: "outline-api-key",
  },
  ...[
    ["outline-icon-panel", "IconPanel.tsx", 78, "activeIcon", 87],
    ["outline-emoji-panel", "EmojiPanel.tsx", 128, "activeEmoji", 138],
  ].flatMap(([target, file, line, name, effectLine]) => [
    {
      action: "use-observable" as const,
      enforced: true as const,
      file: file as string,
      hook: "useState" as const,
      line: line as number,
      name: name as string,
      rationale:
        "A synchronized hover draft is produced by the grid but rendered only by the sibling preview; state-independent fallback work remains an ordinary owner snapshot.",
      target: target as string,
    },
    {
      action: "review-effect" as const,
      file: file as string,
      hook: "useEffect" as const,
      line: effectLine as number,
      name: null,
      rationale:
        "Preserve the React source-change synchronization effect and its dependency timing while isolating only its rendered state sink.",
      target: target as string,
    },
  ]),
  ...[
    ["outline-icon-panel", "IconPanel.tsx", 79],
    ["outline-emoji-panel", "EmojiPanel.tsx", 129],
  ].map(([target, file, line]) => ({
    action: "use-observable" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: "hasMoreBelow",
    rationale:
      "The grid directly produces overflow state while only the stable sibling preview renders it, proving a narrow subscription cut.",
    target: target as string,
  })),
  {
    action: "use-observable",
    file: "LinkEditor.tsx",
    hook: "useState",
    line: 62,
    name: "selectedIndex",
    rationale:
      "Stable suggestion rows need per-row equality selectors while keyboard commands read and update one owner-lifetime cursor without invalidating the editor.",
    target: "outline-link-editor",
  },
  {
    action: "review-state",
    file: "SuggestionsMenu.tsx",
    hook: "useState",
    line: 216,
    name: "selectedIndex",
    rationale:
      "The cursor participates in multiple effects, submenu state, scrolling, and result cardinality, so a row-only selector is not a complete migration.",
    target: "outline-suggestions-menu",
  },
  ...[
    [25, "format", "use-observable", true],
    [29, "includeAttachments", "use-observable", true],
    [30, "includePrivate", "use-observable", true],
  ].map(([line, name, action, enforced]) => ({
    action: action as "use-observable",
    enforced: enforced as boolean,
    file: "ExportDialog.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      line === 25
        ? "The format value has one selector consumer and is otherwise read only by submit; it should use a stable owner observable and selector leaf."
        : "The checkbox value renders in one input and is otherwise consumed only by the export submit command.",
    target: "outline-export-dialog",
  })),
  ...[
    [21, "name", "use-observable"],
    [22, "isSaving", "review-state"],
  ].map(([line, name, action]) => ({
    action: action as "review-state" | "use-observable",
    file: "TeamNew.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      line === 21
        ? "A strict input adapter, sibling submit validation, and independent form content prove a high-frequency leaf subscription cut."
        : "Async submission status belongs to the cohesive submit workflow and is not part of the controlled input migration.",
    target: "outline-team-new",
  })),
  {
    action: "review-state",
    file: "Profile.tsx",
    hook: "useState",
    line: 24,
    name: "name",
    rationale:
      "The owner recomputes native form validity through a ref after each input update, so isolating the input would leave the Save button stale.",
    target: "outline-profile",
  },
  {
    action: "use-observable",
    file: "DocumentCopy.tsx",
    hook: "useState",
    line: 26,
    name: "publish",
    rationale:
      "The option has one conditionally mounted Switch subscriber and is otherwise read only by the Copy event command.",
    target: "outline-document-copy",
  },
  {
    abstentionReason: "callback-timing-unresolved",
    action: "use-observable",
    enforced: false,
    file: "DocumentCopy.tsx",
    hook: "useState",
    line: 27,
    name: "copying",
    rationale:
      "The exact async copying lifecycle renders only the stable Copy button's disabled prop and conditional label, so one leaf subscription removes duplicate-workflow renders without changing command timing.",
    target: "outline-document-copy",
  },
  {
    action: "use-observable",
    file: "DocumentCopy.tsx",
    hook: "useState",
    line: 28,
    name: "recursive",
    rationale:
      "The option has one conditionally mounted Switch subscriber and is otherwise read only by the Copy event command.",
    target: "outline-document-copy",
  },
  {
    action: "review-state",
    file: "DocumentCopy.tsx",
    hook: "useState",
    line: 29,
    name: "selectedPath",
    rationale:
      "The selected destination drives the explorer callback, footer summary, and submit availability rather than one controlled leaf.",
    target: "outline-document-copy",
  },
  ...[
    [
      27,
      "authState",
      "review-state",
      "Authentication state selects the provider workflow branch and therefore owns component mounting rather than one presentation leaf.",
    ],
    [
      28,
      "isSubmitting",
      "review-state",
      "Submission status coordinates the asynchronous request, input availability, and submit button as one workflow.",
    ],
    [
      29,
      "email",
      "use-observable",
      "Email typing has one input and submit-validation subscription boundary beneath provider-kind early returns; ownership must remain above those branches.",
    ],
  ].map(([line, name, action, rationale]) => ({
    action: action as "review-state" | "use-observable",
    enforced: true,
    file: "AuthenticationProvider.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale: rationale as string,
    target: "outline-authentication-provider",
  })),
  ...[
    [
      40,
      "file",
      "review-state",
      "The selected file drives the dropzone summary, submit availability, and asynchronous upload command rather than one bounded leaf.",
    ],
    [
      41,
      "isImporting",
      "review-state",
      "Importing status coordinates the spinner, dropzone, submit button, and asynchronous workflow.",
    ],
    [
      42,
      "uploadProgress",
      "review-state",
      "Upload progress is owned by the asynchronous upload callback and submit presentation, so no independent state boundary is proven.",
    ],
    [
      43,
      "permission",
      "use-observable",
      "Permission has one selector subscription and a submit snapshot beneath a state-independent disabled return; observable ownership remains in DropToImport.",
    ],
  ].map(([line, name, action, rationale]) => ({
    action: action as "review-state" | "use-observable",
    enforced: true,
    file: "DropToImport.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale: rationale as string,
    target: "outline-drop-to-import",
  })),
  {
    action: "keep-state",
    file: "ExportCSV.tsx",
    hook: "useState",
    line: 30,
    name: "isExporting",
    rationale:
      "The export button is the complete one-element owner, so replacing its cohesive React state cannot create a smaller subscription boundary.",
    target: "outline-export-csv",
  },
  {
    action: "use-observable",
    file: "ShareSettingsPopover.tsx",
    hook: "useState",
    line: 59,
    name: "isUploading",
    rationale:
      "The file-input event owns the complete upload interval, and the two state-independent logo branches can subscribe separately without rerendering the forty-three-element sharing popover.",
    target: "outline-share-settings",
  },
  {
    action: "review-state",
    file: "Image.tsx",
    hook: "useState",
    line: 92,
    name: "isDownloading",
    rationale:
      "The pending button is stored in a filtered JSX action array and replayed through a keyed map; keep it under review until analysis proves that exact stored element can become the sole subscriber without changing list identity.",
    target: "outline-editor-image",
  },
  {
    action: "use-observable",
    file: "PublicAccess.tsx",
    hook: "useState",
    line: 49,
    name: "creating",
    rationale:
      "The collection-share command resolves through the wrapper's React.useCallback adapter and the plain styled(RadixSwitch.Root) host to the imported @radix-ui/react-switch checked-change event, and only the stable switch leaf consumes the pending flag.",
    target: "outline-collection-public-access",
  },
  {
    action: "use-observable",
    file: "PublicAccess.tsx",
    hook: "useState",
    line: 59,
    name: "creating",
    rationale:
      "The document-share command resolves through the wrapper's React.useCallback adapter and the plain styled(RadixSwitch.Root) host to the imported @radix-ui/react-switch checked-change event, and only the stable switch leaf consumes the pending flag.",
    target: "outline-document-public-access",
  },
  {
    action: "use-observable",
    enforced: false,
    file: "DocumentDelete.tsx",
    hook: "useState",
    line: 25,
    name: "isArchiving",
    rationale:
      "The archive command reaches an intrinsic button through the local Button and ActionButton wrappers, and the archive button is the sole pending consumer; analysis must prove the full wrapper chain before enforcing the migration.",
    target: "outline-document-delete",
  },
  {
    action: "use-observable",
    enforced: false,
    file: "Settings.tsx",
    hook: "useState",
    line: 40,
    name: "isRegistering",
    rationale:
      "The registration command reaches an intrinsic button through the local Button and ActionButton wrappers, while only the add-passkey action consumes its pending state; analysis must prove the full wrapper chain before enforcing the migration.",
    target: "outline-passkeys-settings",
  },
  {
    action: "review-state",
    file: "index.tsx",
    hook: "useState",
    line: 81,
    name: "activeTab",
    rationale:
      "The tab chooses row presentation and mounted picker content inside an already cohesive picker boundary.",
    target: "outline-icon-picker",
  },
  {
    action: "review-effect",
    abstentionReason: "effect-write-ownership-unresolved",
    file: "index.tsx",
    hook: "useEffect",
    line: 170,
    name: null,
    rationale:
      "The effect resets the controlled tab from changing default-tab input and should remain in React.",
    target: "outline-icon-picker",
  },
  {
    action: "review-state",
    file: "StarredLink.tsx",
    hook: "useState",
    line: 377,
    name: "expanded",
    rationale:
      "Expansion spans alternate child targets and a side-effectful disclosure updater in a compact owner, so no unique leaf is proven.",
    target: "outline-starred-link",
  },
  {
    action: "review-effect",
    file: "StarredLink.tsx",
    hook: "useEffect",
    line: 387,
    name: null,
    rationale:
      "This effect synchronizes navigation context into disclosure state and should retain React timing.",
    target: "outline-starred-link",
  },
  {
    action: "keep-effect",
    file: "StarredLink.tsx",
    hook: "useEffect",
    line: 408,
    name: null,
    rationale:
      "Fetching an external document when its identity changes belongs to React resource lifecycle ownership.",
    target: "outline-starred-link",
  },
  {
    action: "review-state",
    file: "Invite.tsx",
    hook: "useState",
    line: 37,
    name: "invites",
    rationale:
      "Invite state controls repeated row data and the async request payload, so no leaf-only subscription can replace the owner render.",
    target: "outline-invite",
  },
  {
    action: "review-state",
    file: "Invite.tsx",
    hook: "useState",
    line: 49,
    name: "role",
    rationale:
      "Role feeds the controlled selector, explanatory copy, and async request payload across the owner.",
    target: "outline-invite",
  },
  {
    action: "keep-effect",
    file: "ApiKeys.tsx",
    hook: "useEffect",
    line: 90,
    name: null,
    rationale:
      "A changed query error triggers one external toast command; translation only prepares its message argument.",
    target: "outline-api-keys-page",
  },
  ...[
    ["outline-settings-groups", "Groups.tsx", 130, "groups"],
    ["outline-settings-templates", "Templates.tsx", 96, "templates"],
    ["outline-settings-custom-emojis", "CustomEmojis.tsx", 87, "custom emoji"],
    ["outline-settings-shares", "Shares.tsx", 80, "share"],
    ["outline-settings-group-members", "GroupMembers.tsx", 178, "group member"],
    ["outline-settings-users", "Users.tsx", 107, "user"],
    ["outline-sidebar-shared", "SharedWithMe.tsx", 46, "shared-document"],
    ["outline-sidebar-starred", "Starred.tsx", 36, "starred-document"],
  ].map(([target, file, line, subject]) => ({
    action: "keep-effect" as const,
    file: file as string,
    hook: "useEffect" as const,
    line: line as number,
    name: null,
    rationale: `A changed ${subject} query error triggers one external toast after commit; the imported translator only prepares its message.`,
    target: target as string,
  })),
  {
    action: "keep-effect",
    file: "ViewReactionsDialog.tsx",
    hook: "useEffect",
    line: 33,
    name: null,
    rationale:
      "The asynchronous loader reads only the model prop and the translation hook result; the owner's selected-tab state never reaches this effect, so no state migration changes its inputs.",
    target: "outline-reactions-dialog",
  },
  {
    action: "keep-effect",
    file: "index.tsx",
    hook: "useEffect",
    line: 269,
    name: null,
    rationale:
      "A changed split path drives one external history replacement after path normalization.",
    target: "outline-split-view",
  },
  {
    action: "keep-effect",
    file: "index.tsx",
    hook: "useEffect",
    line: 89,
    name: null,
    rationale:
      "Changed collection identity drives one canonical history replacement after imported path construction.",
    target: "outline-collection",
  },
  {
    action: "keep-effect",
    file: "Grid.tsx",
    hook: "useEffect",
    line: 27,
    name: null,
    rationale:
      "The uniquely resolved React useCallback reads a committed scroll ref and notifies after content-size commits, so React post-commit ordering is required.",
    target: "outline-icon-grid",
  },
  {
    action: "use-ref",
    file: "SwitchHostDialog.tsx",
    hook: "useState",
    line: 24,
    enforced: false,
    name: "validatedUrl",
    rationale:
      "The validated URL never renders directly and is consumed only by the submit event; the separately rendered status already owns validation feedback.",
    // Rendered calls or mutable reads still need an independent-refresh proof.
    target: "outline-switch-host-state",
  },
  {
    action: "use-ref",
    file: "useAutoRefresh.ts",
    hook: "useState",
    line: 16,
    name: "minutes",
    rationale:
      "The timer counter never renders, but a correct ref migration must snapshot the old value before applying the functional update so the following reload threshold keeps React's render-snapshot timing.",
    target: "outline-auto-refresh",
  },
  {
    action: "keep-effect",
    file: "index.tsx",
    hook: "useEffect",
    line: 54,
    name: null,
    rationale:
      "Closing the split view resets store state through a MobX store and a module action; the derived split path comes from the router, and the owner has no React state.",
    target: "outline-split-view",
  },
  {
    action: "review-effect",
    abstentionReason: "effect-causal-owner-unresolved",
    file: "LinkEditor.tsx",
    hook: "useEffect",
    line: 77,
    name: null,
    rationale:
      "The request is scheduled by a trimmed alias of the local query state, so the effect reacts to that state through an owner binding and its causal owner follows the state's migration.",
    target: "outline-link-editor",
  },
] as const satisfies readonly GoldHookCase[];
