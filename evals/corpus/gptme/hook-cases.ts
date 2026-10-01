import type { GoldHookCase } from "../contracts.js";

export const gptmeHookCases = [
  {
    action: "use-observable",
    file: "components/AgentsView.tsx",
    hook: "useState",
    line: 25,
    name: "showCreateDialog",
    rationale:
      "Opening and closing the create dialog rerenders the whole agents grid, where every card formats its `lastUsed` date with formatDistanceToNow; only the CreateAgentDialog at line 135 reads the flag.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/ArtifactsPanel.tsx",
    hook: "useState",
    line: 87,
    name: "showDiff",
    rationale:
      "The Diff/Preview toggle and the selection effect at line 142 rerender the artifact list, one button per artifact with date and size formatting, while only the toggle bar at line 249 and the preview pane at line 272 read the flag.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/BrowserPreview.tsx",
    hook: "useState",
    line: 20,
    name: "inputValue",
    rationale:
      "Every keystroke in the URL field rerenders the console log list, which JSON-stringifies each logged argument; the value is read only by the Input and by the refresh command.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/CodeDisplay.tsx",
    hook: "useState",
    line: 21,
    name: "copied",
    rationale:
      "Both copy transitions rerender the line-number column (one div per source line) and the highlighted block, while only the copy Button's icon at line 54 reads the flag.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/CodeDisplay.tsx",
    hook: "useState",
    line: 22,
    name: "highlightedCode",
    rationale:
      "The highlight effect at line 24 writes after commit, forcing a second owner render that re-splits the code and rebuilds the line-number column; only the code pane at line 71 reads the highlighted HTML.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/ConversationContent.tsx",
    hook: "useState",
    line: 78,
    name: "isRetryingConnection",
    rationale:
      "Both pending transitions of the retry command rerender the 1,100-line conversation owner, including the virtualized message list and ChatInput; only the retry Button at line 874 reads the flag.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/ConversationContent.tsx",
    hook: "useState",
    line: 788,
    name: "reconnectRetrySeconds",
    rationale:
      "The 250 ms countdown interval at line 802 rerenders the whole conversation owner each time the second changes while the event stream reconnects; only the banner span at line 1113 reads the value.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/ConversationSettings.tsx",
    hook: "useState",
    line: 112,
    name: "deleteDialogOpen",
    rationale:
      "Opening the delete dialog rerenders the whole conversation settings form with its react-hook-form fields; only the DeleteConversationConfirmationDialog at line 619 reads the flag.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/ConversationSettings.tsx",
    hook: "useState",
    line: 113,
    name: "copied",
    rationale:
      "Both copy transitions rerender the whole settings form, while only the Copy button's icon and label at lines 492-497 read the flag.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/ConversationSettings.tsx",
    hook: "useState",
    line: 114,
    name: "includeThinking",
    rationale:
      "Toggling the export switch rerenders the whole settings form; the value is rendered only by its Switch at line 440 and is otherwise read once inside the export handlers at lines 473 and 524.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/ConversationSettings.tsx",
    hook: "useState",
    line: 115,
    name: "includeTools",
    rationale:
      "Toggling the export switch rerenders the whole settings form; the value is rendered only by its Switch at line 444 and is otherwise read once inside the export handlers at lines 473 and 524.",
    target: "gptme-webui",
  },
  {
    action: "review-state",
    enforced: false,
    file: "components/DeleteConversationConfirmationDialog.tsx",
    hook: "useState",
    line: 35,
    name: "isDeleting",
    rationale:
      "Known false positive (leaf is the owner): the analyzer emits use-observable, but the component is only a Dialog shell whose content is the static header, the error block at line 81, and the two footer buttons; after the cut the owner still renders the dialog chrome, so no material render is removed.",
    target: "gptme-webui",
  },
  {
    action: "review-state",
    enforced: false,
    file: "components/DeleteConversationConfirmationDialog.tsx",
    hook: "useState",
    line: 36,
    name: "isError",
    rationale:
      "Known false positive (leaf is the owner): the analyzer emits use-observable, but the error block at line 81 sits in a dialog whose other children are a static header and two buttons, so extracting it leaves only the Dialog shell in the owner.",
    target: "gptme-webui",
  },
  {
    action: "review-state",
    enforced: false,
    file: "components/DeleteConversationConfirmationDialog.tsx",
    hook: "useState",
    line: 37,
    name: "errorMessage",
    rationale:
      "Known false positive (leaf is the owner): the analyzer emits use-observable, but the message renders in the `<p>` at line 83 of a dialog whose remaining children are a static header and two buttons, so no material render is cut.",
    target: "gptme-webui",
  },
  {
    action: "review-state",
    enforced: false,
    file: "components/ExamplesSection.tsx",
    hook: "useState",
    line: 50,
    name: "isModalOpen",
    rationale:
      "Known false positive (leaf is the owner): the analyzer emits use-observable, but the Dialog at line 61 that reads the flag is the whole component apart from two wrapper divs, so the extracted leaf is the owner.",
    target: "gptme-webui",
  },
  {
    action: "move-state-down",
    file: "components/settings/EnvironmentVariables.tsx",
    hook: "useState",
    line: 24,
    name: "newEnvKey",
    rationale:
      "Each keystroke in the new-variable key field rerenders every existing variable row and re-runs `form.register` for both of its inputs; the draft is read only by the add row at line 68 and its add command.",
    target: "gptme-webui",
  },
  {
    action: "move-state-down",
    file: "components/settings/EnvironmentVariables.tsx",
    hook: "useState",
    line: 25,
    name: "newEnvValue",
    rationale:
      "Each keystroke in the new-variable value field rerenders every existing variable row; the draft is read only by the add row at line 68, which can own it together with `newEnvKey` and call the field array's `append`.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/settings/ServerApiKeySettings.tsx",
    hook: "useState",
    line: 39,
    name: "apiKey",
    rationale:
      "Each keystroke rerenders the whole settings form while only the Input at line 192 and the Save button at line 202 read the draft; React 19 commits the post-await clear at line 98 and the `finally` reset of `isSaving` at line 108 in one render, so converting the draft alone tears nothing.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/settings/ToolsConfiguration.tsx",
    hook: "useState",
    line: 32,
    name: "newToolName",
    rationale:
      "Each keystroke in the custom tool field rerenders the tool badges, the quick-add buttons, and the tool format Select; only the Input at line 103 and the Add button at line 116 read the draft.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/SetupWizard.tsx",
    hook: "useState",
    line: 158,
    name: "remoteBaseUrl",
    rationale:
      "Each keystroke in the remote URL field rerenders the 1,300-line setup wizard; the draft is rendered only by the Input at line 896 and read once by the connect command at line 730.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/SetupWizard.tsx",
    hook: "useState",
    line: 161,
    name: "remoteAuthToken",
    rationale:
      "Each keystroke in either token field rerenders the whole setup wizard; the draft is rendered only by the Inputs at lines 908 and 970 and read once by the connect commands at lines 477 and 731.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/SetupWizard.tsx",
    hook: "useState",
    line: 163,
    name: "apiKey",
    rationale:
      "Each keystroke rerenders the whole setup wizard while only the Input at line 1159 and the Save button at line 1183 read the draft; React 19 commits the post-await clear at line 546 together with any `step` write in the same stretch, so the conversion tears nothing.",
    target: "gptme-webui",
  },
  {
    action: "review-state",
    enforced: false,
    file: "components/TabbedCodeBlock.tsx",
    hook: "useState",
    line: 28,
    name: "renderError",
    rationale:
      "Known false positive (leaf is the owner): the analyzer emits use-observable, but the `<div>` it would wrap at line 87 holds the code block, the preview container, and the iframe, which is the component apart from the two tab buttons; the error is written only when markdown rendering throws.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/TaskCreationDialog.tsx",
    hook: "useState",
    line: 44,
    name: "isLoading",
    rationale:
      "Only the Create Task button at lines 271-272 reads the flag, so `setIsLoading(true)` at line 52 rerenders the whole dialog for one button; React 19 commits `setIsLoading(false)` at line 77 with the form reset at lines 65-73 in one render, so the conversion tears nothing.",
    target: "gptme-webui",
  },
  {
    action: "keep-state",
    file: "components/ui/carousel.tsx",
    hook: "useState",
    line: 52,
    name: "canScrollPrev",
    rationale:
      "No module in the web UI imports components/ui/carousel.tsx, so the Carousel provider never mounts and converting its scroll flag removes no render.",
    target: "gptme-webui",
  },
  {
    action: "keep-state",
    file: "components/ui/carousel.tsx",
    hook: "useState",
    line: 53,
    name: "canScrollNext",
    rationale:
      "No module in the web UI imports components/ui/carousel.tsx, so the Carousel provider never mounts and converting its scroll flag removes no render.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/UnifiedSidebar.tsx",
    hook: "useState",
    line: 168,
    name: "showFilters",
    rationale:
      "Toggling the task filters rerenders the whole sidebar, including up to 20 TaskListItem rows and the ConversationList props; only the tasks header fragment at line 345 reads the flag.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/WelcomeView.tsx",
    hook: "useState",
    line: 72,
    name: "isRetryingConnection",
    rationale:
      "Both pending transitions of the retry command rerender the welcome screen, including ChatInput and the examples; only the retry Button at line 492 reads the flag.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/WelcomeView.tsx",
    hook: "useState",
    line: 73,
    name: "isRestartingServer",
    rationale:
      "Both pending transitions of the Tauri restart command rerender the welcome screen, including ChatInput; only the restart Button at line 482 reads the flag.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/WelcomeView.tsx",
    hook: "useState",
    line: 74,
    name: "providerConfigured",
    rationale:
      "The provider-status effect at line 201 writes after an awaited fetch on every connect, rerendering the welcome screen with ChatInput; only the setup Alert at line 577 reads the value.",
    target: "gptme-webui",
  },
  {
    action: "review-state",
    enforced: false,
    file: "components/workspace/MarkdownPreviewTabs.tsx",
    hook: "useState",
    line: 15,
    name: "renderError",
    rationale:
      "Known false positive (leaf is the owner): the analyzer emits use-observable, but the `<div>` it would wrap at line 82 is the entire preview panel, and the owner keeps only the two tab buttons; the error is written only when markdown rendering throws.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/workspace/WorkspaceExplorer.tsx",
    hook: "useState",
    line: 28,
    name: "workspaceRoot",
    rationale:
      "The chat-config effect at line 58 writes after an await, rerendering the file list and file preview; only PathSegments at line 119 reads the root.",
    target: "gptme-webui",
  },
  {
    action: "use-observe-effect",
    file: "components/workspace/WorkspaceExplorer.tsx",
    hook: "useEffect",
    line: 34,
    name: null,
    rationale:
      "`use$(workspaceNavigateTo$)` at line 33 exists only to feed this effect, which consumes the request and resets it to null; the subscription rerenders the explorer, with its file list and preview, just so the effect can run, and again for the reset. Observing the store directly leaves only the render for the navigation state.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/WorkspaceSelector.tsx",
    hook: "useState",
    line: 44,
    name: "newWorkspacePath",
    rationale:
      "Each keystroke in the new-path field rerenders the Select with one SelectItem per workspace; only the Input at line 114 and the Add button at line 123 read the draft.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    file: "components/WorkspaceSelector.tsx",
    hook: "useState",
    line: 45,
    name: "isAddingWorkspace",
    rationale:
      "Opening and closing the add-path form rerenders the Select with every workspace item; only the custom-path block at line 100 reads the flag, and it is co-written with `newWorkspacePath` in the same handlers.",
    target: "gptme-webui",
  },
  {
    action: "review-state",
    enforced: false,
    file: "contexts/SettingsContext.tsx",
    hook: "useState",
    line: 122,
    name: "settings",
    rationale:
      "Known false positive (whole-object consumers): the analyzer emits use-observable per destructured field, but all seven consumers (ChatInput.tsx:629, ChatMessage.tsx:201, ConversationContent.tsx:213, SettingsContent.tsx:80, SetupWizard.tsx:128, WelcomeView.tsx:227, useSpeechToText.ts:121) take the whole `settings` object, and the provider renders only `children`, so no render is removed.",
    target: "gptme-webui",
  },
  {
    action: "use-observable",
    enforced: false,
    file: "components/ComputerPreview.tsx",
    hook: "useState",
    line: 54,
    name: "screenshotSrc",
    rationale:
      "Every 2 s poll writes `screenshotSrc` and `lastUpdated` at lines 123-126 after an await, rerendering the whole panel (toolbar buttons and the status bar's backend list) while only the `<img>` at line 309 and the timestamp span at line 257 change. The cut must move the co-written cluster (`screenshotSrc`, `lastUpdated`, `error`, `isLoading`) into one observable so the post-await writes stay one commit.",
    target: "gptme-webui",
  },
] as const satisfies readonly GoldHookCase[];
