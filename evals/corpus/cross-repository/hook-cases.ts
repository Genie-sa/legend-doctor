import type { GoldHookCase } from "../contracts.js";

export const crossRepositoryHookCases = [
  ...[["legend-music", "components/dnd/DraggableItem.tsx", 79]].map(([target, file, line]) => ({
    action: "review-effect" as const,
    file: file as string,
    hook: "useEffect" as const,
    line: line as number,
    name: null,
    rationale:
      "External, debounced, prop-lifecycle, or scheduled dependencies prevent a same-owner mutation-site reset.",
    target: target as string,
  })),
  ...[
    ["excalidraw", "actions/actionProperties.tsx", 1344],
    ["excalidraw", "components/ColorPicker/ColorPicker.tsx", 357],
    ["excalidraw", "components/TTDDialog/hooks/useMermaidRenderer.ts", 45],
    ["formbricks-survey-menu-bar", "survey-menu-bar.tsx", 96],
    ["formbricks-survey-menu-bar", "survey-menu-bar.tsx", 100],
    ["formbricks-survey-menu-bar", "survey-menu-bar.tsx", 104],
    ["formbricks-advanced-chart-builder", "advanced-chart-builder.tsx", 106],
    ["outline-event-listener", "useEventListener.ts", 21],
    ["outline-interval", "useInterval.ts", 15],
    ["expensify-use-network", "useNetwork.ts", 13],
    ["expensify-shift-range-selection", "useShiftRangeSelection.ts", 36],
    ["formbricks-workflow-node-field-focus", "use-workflow-node-field-focus.ts", 49],
    ["outline-template-form", "TemplateForm.tsx", 82],
    ["outline-document-save", "useDocumentSave.ts", 126],
    ["outline-document-save", "useDocumentSave.ts", 202],
  ].map(([target, file, line]) => ({
    action: "keep-effect" as const,
    file: file as string,
    hook: "useEffect" as const,
    line: line as number,
    name: null,
    rationale:
      "The effect exactly mirrors a pure render value into a proven local ref after commit, preserving latest-value callback semantics.",
    target: target as string,
  })),
  ...[
    ["formbricks-custom-filter", "CustomFilter.tsx", 138, "isFilterDropDownOpen"],
    ["formbricks-custom-filter", "CustomFilter.tsx", 139, "isDownloadDropDownOpen"],
  ].map(([target, file, line, name]) => ({
    abstentionReason: "child-contract-unresolved" as const,
    action: "review-state" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "The only call site, `PopoverTriggerButton` (:281, :388), is the child of `<DropdownMenuTrigger asChild>`, whose Radix Slot clones that child to merge the trigger's handlers, `aria` state and ref. A leaf subscriber in that position receives those props instead of the button and drops them unless it forwards every prop and the ref, so the wrapper is not proven.",
    target: target as string,
  })),
  {
    action: "review-state",
    enforced: false,
    file: "CustomFilter.tsx",
    hook: "useState",
    line: 141,
    name: "isDownloading",
    rationale:
      "Known false positive (Slot clones the leaf): the async-status rule wraps the `PopoverTriggerButton` call site (:388), which is the child of `<DropdownMenuTrigger asChild>`; the Radix Slot would clone the leaf subscriber instead of the button and drop the trigger's handlers and ref.",
    target: "formbricks-custom-filter",
  },
  {
    abstentionReason: "child-contract-unresolved",
    action: "review-state",
    file: "SplitButton.tsx",
    hook: "useState",
    line: 51,
    name: "alignOffset",
    rationale:
      "The call site `DropdownMenuPrimitive.Content` (:88) is the child of `DropdownMenuPrimitive.Portal`. Radix's menu portal renders its child through `Presence`, which clones it to attach a ref, and through `Portal asChild`, whose Slot clones it again, so a leaf subscriber there would take the ref and merged props meant for the content.",
    target: "outline-split-button",
  },
  ...[
    ["expensify-authorize-transaction", "index.tsx", 63, "isConfirmModalVisible"],
    ["formbricks-select-plan-card", "select-plan-card.tsx", 43, "showHobbyConfirm"],
    ["formbricks-upload-contacts", "upload-contacts-button.tsx", 47, "open"],
    ["formbricks-webhook-settings", "webhook-settings-tab.tsx", 51, "isUpdatingWebhook"],
    [
      "formbricks-organization-actions",
      "organization-actions.tsx",
      71,
      "isLeaveOrganizationModalOpen",
    ],
    ["formbricks-survey-menu-bar", "survey-menu-bar.tsx", 73, "isSurveyPublishing"],
    ["formbricks-connect-integration", "index.tsx", 29, "isConnecting"],
    ["formbricks-date-picker", "index.tsx", 55, "isOpen"],
  ].map(([target, file, line, name]) => ({
    action: "use-observable" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "One stable JSX call site consumes the complete value while owner commands mutate it; a local subscriber can pass the same snapshot without requiring the child implementation or prop contract.",
    target: target as string,
  })),
  ...[
    ["expensify-chronos", "ChronosScheduleOOOPage.tsx", 53, "isDurationUnitModalVisible"],
    ["formbricks-manage-airtable", "ManageIntegration.tsx", 52, "isDeleteIntegrationModalOpen"],
  ].map(([target, file, line, name]) => ({
    action: "use-observable" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "A direct call-free JSX event independently changes this leaf state even though separate workflow transitions co-write companion React state.",
    target: target as string,
  })),
  ...[
    ["formbricks-survey-analysis-cta", "SurveyAnalysisCTA.tsx", 66, "isResetting"],
    ["formbricks-delete-team", "delete-team.tsx", 23, "isDeleting"],
    ["outline-authentication-settings", "Authentication.tsx", 335, "isSaving"],
  ].map(([target, file, line, name]) => ({
    action: "use-observable" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "One stable control or dialog owns the pending surface while independently rendered siblings prove a material owner cut; preserve the exact async start and completion boundaries.",
    target: target as string,
  })),
  ...[
    ["formbricks-survey-list", "survey-list.tsx", 182],
    ["formbricks-response-table", "ResponseTable.tsx", 102],
    ["formbricks-contacts-table", "contacts-table.tsx", 148],
    ["formbricks-attributes-table", "attributes-table.tsx", 158],
    ["formbricks-workspace-storage", "WorkspaceStorageHandler.tsx", 11],
  ].map(([target, file, line]) => ({
    action: "keep-effect" as const,
    file: file as string,
    hook: "useEffect" as const,
    line: line as number,
    name: null,
    rationale:
      "React dependencies are intentionally persisted to browser storage after commit; this is not an observable reaction.",
    target: target as string,
  })),
  ...[
    [
      "formbricks-enterprise-license-status",
      "EnterpriseLicenseStatus.tsx",
      56,
      "isRechecking",
      "Button",
    ],
    [
      "formbricks-selected-row-settings",
      "selected-row-settings.tsx",
      41,
      "isDownloading",
      "DropdownMenuTrigger",
    ],
    ["outline-invite", "Invite.tsx", 36, "isSaving", "Button"],
  ].map(([target, file, line, name, leaf]) => ({
    action: "use-observable" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale: `The async flag's prop and label or icon projections are contained by one stable ${leaf} leaf; preserve the command boundary and subscribe only there.`,
    target: target as string,
  })),
  ...[
    ["excalidraw", "components/TTDDialog/Chat/ChatMessage.tsx", 33, "canRetry"],
    ["excalidraw", "components/ImageExportDialog.tsx", 91, "renderError"],
  ].map(([target, file, line, name]) => ({
    action: "use-observable" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "State written only by React effects can retain owner lifetime in an observable while one small presentation subtree subscribes; preserve the original effect, cleanup, and statement order.",
    target: target as string,
  })),
  {
    action: "use-observable",
    file: "components/dnd/DraggableItem.tsx",
    hook: "useState",
    line: 64,
    name: "fadeOg",
    rationale:
      "A compact owner still has a material leaf cut when the effect-written presentation state can skip at least five independent JSX elements without changing effect timing or owner lifetime.",
    target: "legend-music",
  },
] as const satisfies readonly GoldHookCase[];
