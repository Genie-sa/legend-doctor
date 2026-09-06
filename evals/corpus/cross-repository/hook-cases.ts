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
    ["expensify-authorize-transaction", "index.tsx", 63, "isConfirmModalVisible"],
    ["formbricks-custom-filter", "CustomFilter.tsx", 138, "isFilterDropDownOpen"],
    ["formbricks-custom-filter", "CustomFilter.tsx", 139, "isDownloadDropDownOpen"],
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
    ["outline-split-button", "SplitButton.tsx", 51, "alignOffset"],
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
    ["formbricks-custom-filter", "CustomFilter.tsx", 141, "isDownloading", "PopoverTriggerButton"],
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
  ...[
    ["legend-music", "components/dnd/DraggableItem.tsx", 64, "fadeOg"],
    ["open-webui-search-archived-chats", "component.tsx", 37, "isFocused"],
  ].map(([target, file, line, name]) => ({
    action: "use-observable" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "A compact owner still has a material leaf cut when the effect-written presentation state can skip at least five independent JSX elements without changing effect timing or owner lifetime.",
    target: target as string,
  })),
] as const satisfies readonly GoldHookCase[];
