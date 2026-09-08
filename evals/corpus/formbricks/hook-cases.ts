import type { GoldHookCase } from "../contracts.js";
import type { HookAction } from "../../../src/core/types.js";

export const formbricksHookCases = [
  {
    action: "use-observable",
    enforced: false,
    file: "survey-dropdown-menu.tsx",
    hook: "useState",
    line: 82,
    name: "isDuplicating",
    rationale:
      "Manually audited at the pinned commit: after the workspace guard, lines 193-194 set duplication pending and close the menu before any awaited work. These literal writes form one local assign; the finally reset at line 210 remains separate, including rejection and the early success return. The stable button leaf owns disabled/className reads. The complete seven-member menu group still needs a completion plan for archive success versus finally; this label must not waive that obstruction.",
    target: "formbricks-survey-dropdown",
  },
  {
    action: "use-observable",
    file: "webhook-settings-tab.tsx",
    hook: "useState",
    line: 55,
    name: "endpointAccessible",
    rationale:
      "The endpoint command clears hittingEndpoint then sets accessibility in both success and catch paths after the awaited request. One atomic model preserves those paired writes, while an always-mounted input subscriber owns the accessibility border and the pending button remains a separate leaf.",
    target: "formbricks-webhook-settings",
  },
  {
    action: "use-observable",
    file: "ActionSettingsTab.tsx",
    hook: "useState",
    line: 51,
    name: "openDeleteDialog",
    rationale:
      "The visibility value is consumed only by the stable DeleteDialog sibling of the form; opening comes from the default intrinsic Button and closing stays on the existing dialog API, so an owner-lifetime observable removes form rerenders without changing dialog mounts.",
    target: "formbricks-action-settings",
  },
  {
    action: "use-observable",
    file: "ActionSettingsTab.tsx",
    hook: "useState",
    line: 54,
    name: "isDeletingAction",
    rationale:
      "DeleteDialog forwards the delete command to its default intrinsic Button. The flag wraps the awaited delete action with a finally reset and only controls dialog loading and disabled props; a dialog subscriber preserves success, error, and completion timing while sparing the sibling form.",
    target: "formbricks-action-settings",
  },
  {
    action: "use-observable",
    file: "GoogleSheetWrapper.tsx",
    hook: "useState",
    line: 39,
    name: "showReconnectButton",
    rationale:
      "The reconnect flag is written once from a server-action callback and rendered only by the resolved ManageIntegration leaf, whose contract is verified as render-only.",
    target: "formbricks-google-sheet-wrapper",
  },
  {
    action: "use-observable",
    file: "SlackWrapper.tsx",
    hook: "useState",
    line: 35,
    name: "showReconnectButton",
    rationale:
      "The Slack twin of the Google Sheets wrapper: one server-action write and a single resolved ManageIntegration leaf with a verified render-only contract.",
    target: "formbricks-slack-wrapper",
  },
  ...[
    [
      229,
      "A newly inserted choice is focused through its committed button ref after the choices render.",
    ],
    [
      236,
      "A newly created element is focused through its committed input ref after the element renders.",
    ],
  ].map(([line, rationale]) => ({
    action: "keep-effect" as const,
    file: "multiple-choice-element-form.tsx",
    hook: "useEffect" as const,
    line: line as number,
    name: null,
    rationale: rationale as string,
    target: "formbricks-multiple-choice",
  })),
  {
    action: "review-state",
    file: "multiple-choice-element-form.tsx",
    hook: "useState",
    line: 58,
    name: "isInvalidValue",
    rationale:
      "Every write repeats the current primitive, so React already bails out. This is dead-code cleanup without a proven render or lifecycle cost and stays non-actionable.",
    target: "formbricks-multiple-choice",
  },
  {
    action: "review-state",
    file: "ranking-element-form.tsx",
    hook: "useState",
    line: 50,
    name: "isInvalidValue",
    rationale:
      "Every write repeats the current primitive, so React already bails out. This is dead-code cleanup without a proven render or lifecycle cost and stays non-actionable.",
    target: "formbricks-ranking-element",
  },
  {
    action: "keep-effect",
    file: "ranking-element-form.tsx",
    hook: "useEffect",
    line: 133,
    name: null,
    rationale:
      "Choice focus depends on the committed input after the ranking list changes, so the effect must retain React post-commit timing.",
    target: "formbricks-ranking-element",
  },
  ...[
    ["formbricks-create-team", "create-team-modal.tsx", 30, "teamName"],
    ["formbricks-mapping-field", "mapping-field.tsx", 85, "draftFixedValue"],
  ].map(([target, file, line, name]) => ({
    action: "use-observable" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "The direct input edit is independent while submit or save reads remain event snapshots; an owner observable narrows keystroke invalidation to the controlled field and its complete validation leaf.",
    target: target as string,
  })),
  {
    action: "use-observable",
    file: "create-team-modal.tsx",
    hook: "useState",
    line: 31,
    name: "isLoading",
    rationale:
      "The true pending transition reaches its awaited create command before any other owner state changes, and only the submit button subscribes.",
    target: "formbricks-create-team",
  },
  {
    action: "review-state",
    file: "mapping-field.tsx",
    hook: "useState",
    line: 84,
    name: "isEditingFixed",
    rationale:
      "Editing mode controls which field branch exists, so it remains workflow state rather than the independently editable value leaf.",
    target: "formbricks-mapping-field",
  },
  ...[
    [74, "textareaValue"],
    [75, "validationError"],
  ].map(([line, name]) => ({
    action: "use-observable" as const,
    file: "bulk-edit-options-modal.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "The modal effect and input edit path update one complete text/error draft cluster; keep the effect and subscribe only in the editor/error subtree.",
    target: "formbricks-bulk-options",
  })),
  {
    action: "review-effect",
    file: "bulk-edit-options-modal.tsx",
    hook: "useEffect",
    line: 86,
    name: null,
    rationale:
      "The guarded prop synchronization must remain a React effect with the same dependencies and timing.",
    target: "formbricks-bulk-options",
  },
  ...[
    [55, "selectedSurveyId"],
    [57, "generatedUrl"],
  ].map(([line, name]) => ({
    action: "use-observable" as const,
    file: "generate-personal-link-modal.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "The close effect resets one complete survey/link draft, while the generation command snapshots the selection before suspension and publishes the URL afterward; preserve the effect and subscribe only in the select, URL, and button leaves.",
    target: "formbricks-personal-link-modal",
  })),
  {
    action: "review-effect",
    file: "generate-personal-link-modal.tsx",
    hook: "useEffect",
    line: 59,
    name: null,
    rationale:
      "Preserve the modal-close synchronization effect and its dependency timing while replacing only its two-state draft reset.",
    target: "formbricks-personal-link-modal",
  },
  {
    action: "use-observable",
    file: "index.tsx",
    hook: "useState",
    line: 182,
    name: "text",
    rationale:
      "The prop-seeded text is an editable leaf draft; its event command forwards the same computed value to one debounced upstream update.",
    target: "formbricks-element-input",
  },
  {
    action: "use-observable",
    file: "index.tsx",
    hook: "useState",
    line: 183,
    name: "showImageUploader",
    rationale:
      "The toggle controls one bounded FileInput gate; an owner observable plus full-gate subscriber preserves the uploader's mount lifetime without rerendering the editor.",
    target: "formbricks-element-input",
  },
  {
    action: "review-state",
    file: "index.tsx",
    hook: "useState",
    line: 308,
    name: "internalFirstRender",
    rationale:
      "The controlled/uncontrolled fallback crosses an external state contract and is not part of the synchronized text draft.",
    target: "formbricks-element-input",
  },
  {
    action: "review-effect",
    file: "index.tsx",
    hook: "useEffect",
    line: 188,
    name: null,
    rationale:
      "Preserve the React prop-to-draft synchronization phase; only the paired draft sink is a future migration candidate.",
    target: "formbricks-element-input",
  },
  {
    action: "use-observable",
    file: "webhook-created-modal.tsx",
    hook: "useState",
    line: 30,
    name: "copied",
    rationale:
      "The copy timer changes only the button content; an always-mounted button subscriber preserves the modal and form boundary.",
    target: "formbricks-webhook-created",
  },
  {
    action: "use-observable",
    file: "webhook-settings-tab.tsx",
    hook: "useState",
    line: 59,
    name: "copied",
    rationale:
      "The copy timer selects one button-local presentation while the forty-element settings owner remains unchanged.",
    target: "formbricks-webhook-settings",
  },
  {
    action: "use-observable",
    file: "webhook-settings-tab.tsx",
    hook: "useState",
    line: 56,
    name: "hittingEndpoint",
    rationale:
      "Endpoint testing starts one pending transition before suspension; the button leaf can subscribe while completion updates remain in the existing command.",
    target: "formbricks-webhook-settings",
  },
  {
    action: "use-observable",
    file: "webhook-settings-tab.tsx",
    hook: "useState",
    line: 52,
    name: "selectedTriggers",
    rationale:
      "One resolved checkbox-group leaf owns the exact immutable membership toggle and every rendered read, while submit needs one non-tracking snapshot; trigger edits should not rerender the forty-element settings owner.",
    target: "formbricks-webhook-settings",
  },
  {
    action: "use-observable",
    file: "pricing-table.tsx",
    hook: "useState",
    line: 343,
    name: "isHobbyDowngradeConfirmOpen",
    rationale:
      "One always-mounted subscriber can replace the complete confirmation gate without rerendering the pricing table.",
    target: "formbricks-pricing-table",
  },
  {
    action: "use-observable",
    file: "index.tsx",
    hook: "useState",
    line: 35,
    name: "isLoading",
    rationale: "The async command changes only a small loading overlay inside the segment row.",
    target: "formbricks-load-segment",
  },
  {
    action: "use-observable",
    file: "single-tag.tsx",
    hook: "useState",
    line: 44,
    name: "updateTagError",
    rationale:
      "Async tag commands update one input presentation or merge-control gate without invalidating the rest of the row.",
    target: "formbricks-single-tag",
  },
  {
    action: "use-observable",
    enforced: false,
    file: "single-tag.tsx",
    hook: "useState",
    line: 45,
    name: "isMergingTags",
    rationale:
      "Async tag commands update one input presentation or merge-control gate without invalidating the rest of the row.",
    target: "formbricks-single-tag",
  },
  ...[
    ["useState", 28, "isCopied", "review-state"],
    ["useEffect", 50, null, "review-effect"],
  ].map(([hook, line, name, action]) => ({
    action: action as HookAction,
    file: "index.tsx",
    hook: hook as "useEffect" | "useState",
    line: line as number,
    name: name as string | null,
    rationale:
      "The copied flag owns a self-dependent cleanup effect, so command-only gate isolation is not proven.",
    target: "formbricks-id-badge",
  })),
  {
    action: "review-state",
    file: "ManageIntegration.tsx",
    hook: "useState",
    line: 56,
    name: "isModalOpen",
    rationale:
      "The edit modal lifetime is coupled to its selected integration payload, so an isolated flag migration is incomplete.",
    target: "formbricks-manage-airtable",
  },
  ...[
    [37, "isEditing", "review-state"],
    [38, "showRemoveDialog", "use-observable"],
    [39, "isSubmitting", "review-state"],
  ].map(([line, name, action]) => ({
    action: action as "review-state" | "use-observable",
    file: "pretty-url-tab.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      line === 38
        ? "A direct remove event independently opens the one stable DeleteDialog leaf even though successful deletion also transitions form state."
        : "The state participates in prop-to-form synchronization or async submission ownership and has no isolated leaf cut.",
    target: "formbricks-pretty-url",
  })),
  {
    action: "review-effect",
    file: "pretty-url-tab.tsx",
    hook: "useEffect",
    line: 55,
    name: null,
    rationale:
      "The effect synchronizes both editable React state and react-hook-form state from a changing survey slug.",
    target: "formbricks-pretty-url",
  },
  {
    action: "use-observable",
    file: "webhook-settings-tab.tsx",
    hook: "useState",
    line: 58,
    name: "showSecret",
    rationale:
      "Secret visibility affects only the password field and its toggle icon; the surrounding webhook editor should not rerender.",
    target: "formbricks-webhook-settings",
  },
  ...[
    [90, "chartNameError", "use-observable"],
    [91, "queryState", "review-state"],
  ].map(([line, name, action]) => ({
    action: action as "review-state" | "use-observable",
    file: "create-chart-view.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      line === 90
        ? "The chart-name error projects only into the name-field section and is cleared by that field's change event."
        : "Loading, pending, and error fields are one async query workflow rather than an isolated presentation leaf.",
    target: "formbricks-create-chart",
  })),
  {
    action: "use-observable",
    file: "elements-view.tsx",
    hook: "useState",
    line: 102,
    name: "logicDeletionWarning",
    rationale:
      "The deletion payload is rendered and consumed only by one confirmation modal while the large survey element editor remains independent.",
    target: "formbricks-elements-view",
  },
  ...[
    [28, "open", "keep-state"],
    [29, "value", "delete-unused-state"],
  ].map(([line, name, action]) => ({
    action: action as "delete-unused-state" | "keep-state",
    file: "merge-tags-combobox.tsx",
    enforced: line !== 29,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      line === 29
        ? "The merge value is read only to calculate its own inert setter argument; neither the current nor assigned value escapes, renders, or affects the selection command."
        : "Popover visibility owns the cohesive combobox boundary, so no smaller proven subscription exists.",
    target: "formbricks-merge-tags",
  })),
  ...[
    [44, "customSingleUseId", "use-observable"],
    [42, "singleUseEncryption", "review-state"],
  ].map(([line, name, action]) => ({
    action: action as "review-state" | "use-observable",
    file: "anonymous-links-tab.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      line === 44
        ? "The conditional custom-link input and Copy validation button can subscribe independently while the large link-management owner stays stable."
        : "Encryption participates in link generation and form workflow state beyond one proven presentation boundary.",
    target: "formbricks-anonymous-links",
  })),
  ...[
    [51, "decrementQuotas", "use-observable"],
    [55, "isDeleting", "review-state"],
  ].map(([line, name, action]) => ({
    action: action as "review-state" | "use-observable",
    file: "index.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      line === 51
        ? "The quota toggle has one conditional checkbox subscriber and is otherwise read only by the delete event command."
        : "Deletion status is owned by the asynchronous delete workflow rather than an independent controlled leaf.",
    target: "formbricks-single-response",
  })),
  {
    action: "use-observable",
    file: "DeleteOrganization.tsx",
    hook: "useState",
    line: 28,
    name: "isDeleting",
    rationale:
      "The source-resolved delete command starts one pending interval before awaited work, and the stable organization modal can subscribe without rerendering the independent warning and launch surfaces.",
    target: "formbricks-delete-organization",
  },
  {
    action: "review-state",
    file: "DeleteOrganization.tsx",
    hook: "useState",
    line: 106,
    name: "inputValue",
    rationale:
      "The confirmation input is nested inside the same DeleteDialog boundary whose disabled prop consumes it, so no smaller independent owner cut is proven.",
    target: "formbricks-delete-organization",
  },
  ...[
    [
      106,
      "records",
      "review-state",
      true,
      "Records are the rendered list data and are replaced by refresh and pagination workflows, not a row-local selection model.",
    ],
    [
      113,
      "drawerRecordId",
      "use-observable",
      true,
      "The undefined-initialized record cursor and visibility flag open together, stay mounted in one resolved drawer target, and must migrate as one observable model.",
    ],
    [
      114,
      "isDrawerOpen",
      "use-observable",
      true,
      "The undefined-initialized record cursor and visibility flag open together, stay mounted in one resolved drawer target, and must migrate as one observable model.",
    ],
    [
      120,
      "selectedIds",
      "use-observable",
      true,
      "Independent row toggles make this a real keyed selection model; row membership and toolbar summaries can subscribe separately while refresh commands reset it atomically.",
    ],
    [
      122,
      "isDeleting",
      "use-observable",
      true,
      "The true pending transition reaches chunk deletion before any other owner state changes, and only the delete dialog subscribes; preserve its existing finally boundary.",
    ],
  ].map(([line, name, action, enforced, rationale]) => ({
    action: action as "review-state" | "use-observable",
    enforced: enforced as boolean,
    file: "feedback-records-table.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale: rationale as string,
    target: "formbricks-feedback-records",
  })),
  {
    action: "use-observable",
    file: "workflow-runs-table.tsx",
    hook: "useState",
    line: 42,
    name: "selectedRunId",
    rationale:
      "Row commands select one ID while a single drawer can subscribe, resolve the matching run from its ordinary prop snapshot, and avoid rerendering the table.",
    target: "formbricks-workflow-runs",
  },
  ...[
    ["formbricks-edit-api-keys", "edit-api-keys.tsx", 73, "isAddAPIKeyModalOpen"],
    ["formbricks-quotas-card", "quotas-card.tsx", 81, "openCreateQuotaConfirmationModal"],
  ].map(([target, file, line, name]) => ({
    action: "use-observable" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      name === "openCreateQuotaConfirmationModal"
        ? "The confirmation can open through its paired setter, while the only companion transaction closes it before handing off to the quota modal; one confirmation leaf can subscribe safely."
        : "The add-key modal opens independently and one stable modal can subscribe without invalidating the API-key list owner.",
    target: target as string,
  })),
  ...[
    [
      "formbricks-chart-menu",
      "chart-dropdown-menu.tsx",
      32,
      "isDeleteDialogOpen",
      "Opening the delete dialog also closes the dropdown; migrating visibility alone would expose the dialog before the React-owned dropdown commits closed.",
    ],
    [
      "formbricks-dashboard-menu",
      "dashboard-dropdown-menu.tsx",
      33,
      "isDeleteDialogOpen",
      "Opening the delete dialog also closes the dropdown; migrating visibility alone would split one atomic surface transition.",
    ],
    [
      "formbricks-quotas-card",
      "quotas-card.tsx",
      76,
      "isQuotaModalOpen",
      "Quota visibility opens with the active quota and response count and also switches from a sibling confirmation modal; migrate the complete workflow or keep it in React.",
    ],
    [
      "formbricks-feedback-source-menu",
      "feedback-source-row-dropdown.tsx",
      43,
      "isDeleteDialogOpen",
      "Opening the delete dialog also closes the source dropdown, so an isolated Legend write could render both surfaces open before React commits.",
    ],
    [
      "formbricks-edit-api-keys",
      "edit-api-keys.tsx",
      74,
      "isDeleteKeyModalOpen",
      "The delete dialog opens only after selecting its active key; visibility alone could publish open with the previous key snapshot.",
    ],
    [
      "formbricks-edit-api-keys",
      "edit-api-keys.tsx",
      79,
      "viewPermissionsOpen",
      "Permission visibility and active-key selection form one transition, and the active key also controls the modal mount; preserve the React transaction until the complete model can migrate.",
    ],
    [
      "formbricks-editor-card-menu",
      "editor-card-menu.tsx",
      77,
      "logicWarningModal",
      "The warning opens after changing the pending element type; visibility alone could expose the warning with the previous type.",
    ],
    [
      "formbricks-language-view",
      "language-view.tsx",
      79,
      "translationModalOpen",
      "Translation visibility opens with a new language code whose derived label is still computed by the owner; an isolated observable would publish stale language props.",
    ],
  ].map(([target, file, line, name, rationale]) => ({
    action: "review-state" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale: rationale as string,
    target: target as string,
  })),
  ...[
    ["formbricks-manage-airtable", "ManageIntegration.tsx", 51, "isDeleting"],
    ["formbricks-chart-menu", "chart-dropdown-menu.tsx", 34, "isDuplicating"],
    ["formbricks-dashboard-menu", "dashboard-dropdown-menu.tsx", 34, "isDeleting"],
    ["formbricks-dashboard-menu", "dashboard-dropdown-menu.tsx", 35, "isDuplicating"],
    ["formbricks-edit-attribute", "edit-attribute-modal.tsx", 45, "isUpdating"],
    ["formbricks-create-segment", "create-segment-modal.tsx", 57, "isCreatingSegment"],
    ["formbricks-quotas-card", "quotas-card.tsx", 80, "isDeletingQuota"],
    ["formbricks-feedback-source-menu", "feedback-source-row-dropdown.tsx", 45, "isDeleting"],
    ["formbricks-organization-actions", "organization-actions.tsx", 73, "loading"],
  ].map(([target, file, line, name]) => ({
    action: "use-observable" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "The first pending transition is an independent event-rooted write immediately before awaited work, and one stable status leaf can subscribe without changing the command, await, or later close/reset transitions.",
    target: target as string,
  })),
  ...[
    ["formbricks-dashboard-control", "dashboard-control-bar.tsx", 53, "isDeleting"],
    ["formbricks-contact-control", "contact-control-bar.tsx", 47, "isDeletingPerson"],
    ["formbricks-dashboard-detail", "dashboard-detail-client.tsx", 193, "isSaving"],
    ["formbricks-dashboard-detail", "dashboard-detail-client.tsx", 194, "editingChartId"],
  ].map(([target, file, line, name]) => ({
    action: "use-observable" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      target === "formbricks-dashboard-detail" && name === "isSaving"
        ? "The save command is published through a source-resolved action array whose stable IconBar consumer defers every onClick; only DashboardControlBar subscribes while the dashboard owner stays stable."
        : "Manual review proves this leaf update remains outside the component's React transition, but the conservative owner boundary abstains instead of building a partial transition call graph.",
    target: target as string,
  })),
  {
    action: "keep-state",
    file: "saml-button.tsx",
    hook: "useState",
    line: 21,
    name: "isLoading",
    rationale:
      "The exact SAML pending transaction renders through the complete button owner, so an observable cannot create a smaller subscription boundary.",
    target: "formbricks-saml-button",
  },
  {
    action: "use-observable",
    file: "chart-dropdown-menu.tsx",
    hook: "useState",
    line: 33,
    name: "isDeleting",
    rationale:
      "The source-resolved delete command reaches awaited work through the default intrinsic button branch, while the menu item and dialog are two non-repeated status leaves; separate subscribers remove the owner render without changing the later dialog close.",
    target: "formbricks-chart-menu",
  },
  {
    action: "use-observable",
    file: "chart-dropdown-menu.tsx",
    hook: "useState",
    line: 37,
    name: "isAddingToDashboard",
    rationale:
      "Validation finishes before this pending transition, then one dashboard dialog can subscribe while the awaited add command and later dialog reset keep their current ordering.",
    target: "formbricks-chart-menu",
  },
  {
    action: "keep-effect",
    file: "chart-dropdown-menu.tsx",
    hook: "useEffect",
    line: 43,
    name: null,
    rationale:
      "Keep the cancellable dashboard-loading effect in React; it owns setup, asynchronous completion guards, and cleanup for changing inputs.",
    target: "formbricks-chart-menu",
  },
  ...[
    [
      "formbricks-dashboard-menu",
      "dashboard-dropdown-menu.tsx",
      36,
      "isDropDownOpen",
      "Menu visibility controls the complete dropdown interaction boundary rather than one asynchronous status leaf.",
    ],
    [
      "formbricks-create-segment",
      "create-segment-modal.tsx",
      56,
      "segment",
      "The segment draft drives validation, filter editing, and the create payload across the modal; one leaf subscription is incomplete.",
    ],
    [
      "formbricks-feedback-source-menu",
      "feedback-source-row-dropdown.tsx",
      44,
      "isDropDownOpen",
      "Dropdown visibility owns the complete menu interaction boundary and is not an async pending leaf.",
    ],
  ].map(([target, file, line, name, rationale]) => ({
    action: "review-state" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale: rationale as string,
    target: target as string,
  })),
  {
    action: "review-state",
    file: "edit-attribute-modal.tsx",
    hook: "useState",
    line: 46,
    name: "formData",
    rationale:
      "The field split is promising, but the imported Input adapter does not expose a source-proven deferred callback contract through this target; keep the draft under review instead of trusting an onChange prop name.",
    target: "formbricks-edit-attribute",
  },
  {
    action: "use-observable",
    file: "dashboard-widget.tsx",
    hook: "useState",
    line: 34,
    name: "menuOpen",
    rationale:
      "The owner renders arbitrary widget content outside a conditionally mounted menu; keep the observable at widget lifetime and subscribe around the complete menu subtree so descendant close commands do not invalidate the widget body.",
    target: "formbricks-dashboard-widget",
  },
  {
    action: "use-observable",
    file: "EditProfileDetailsForm.tsx",
    hook: "useState",
    line: 59,
    name: "isResettingPassword",
    rationale:
      "The event-rooted password reset flips this status immediately before awaited work, and only one stable button needs to subscribe while the form owner remains unchanged.",
    target: "formbricks-profile-reset",
  },
  {
    action: "use-observable",
    file: "AddIntegrationModal.tsx",
    hook: "useState",
    line: 78,
    name: "isDeleting",
    rationale:
      "The delete command owns a literal pending interval around one await; observable ownership stays above the prop-selected branch while its one button leaf subscribes.",
    target: "formbricks-google-integration",
  },
  {
    action: "review-state",
    file: "AddIntegrationModal.tsx",
    hook: "useState",
    line: 75,
    name: "isLinkingSheet",
    rationale:
      "Linking performs validation and constructs integration data before multiple awaited operations, and reset co-writes the form draft, so the narrow pending-leaf proof does not apply.",
    target: "formbricks-google-integration",
  },
  ...[99, 106].map((line) => ({
    action: "review-effect" as const,
    file: "AddIntegrationModal.tsx",
    hook: "useEffect" as const,
    line,
    name: null,
    rationale:
      "Keep this prop- and selection-driven form synchronization in React; no observable dependency proves an equivalent Legend reaction or event relocation.",
    target: "formbricks-google-integration",
  })),
  {
    action: "use-observable",
    file: "AddIntegrationModal.tsx",
    hook: "useState",
    line: 68,
    name: "isDeleting",
    rationale:
      "The Notion delete command starts one literal pending interval immediately before its awaited server action, and only the delete button consumes the status.",
    target: "formbricks-notion-integration",
  },
  {
    action: "review-state",
    file: "AddIntegrationModal.tsx",
    hook: "useState",
    line: 69,
    name: "isLinkingDatabase",
    rationale:
      "Database linking validates and constructs a multi-field integration payload before awaiting work, so the loading flag is part of the broader form workflow.",
    target: "formbricks-notion-integration",
  },
  {
    action: "review-effect",
    file: "AddIntegrationModal.tsx",
    hook: "useEffect",
    line: 160,
    name: null,
    rationale:
      "Keep the selected-integration form synchronization in React; its source values are React inputs and no equivalent observable reaction is proven.",
    target: "formbricks-notion-integration",
  },
  {
    action: "use-observable",
    file: "AddChannelMappingModal.tsx",
    hook: "useState",
    line: 63,
    name: "isDeleting",
    rationale:
      "The Slack delete command starts one literal pending interval immediately before its awaited server action, and only the delete button consumes the status.",
    target: "formbricks-slack-integration",
  },
  {
    action: "review-state",
    file: "AddChannelMappingModal.tsx",
    hook: "useState",
    line: 60,
    name: "isLinkingChannel",
    rationale:
      "Channel linking validates several draft fields and mutates the integration payload before awaiting work, so this status is not an isolated leaf transition.",
    target: "formbricks-slack-integration",
  },
  ...[83, 92].map((line) => ({
    action: "review-effect" as const,
    file: "AddChannelMappingModal.tsx",
    hook: "useEffect" as const,
    line,
    name: null,
    rationale:
      "Keep this selection-driven form synchronization in React; no observable dependency proves equivalent reaction timing.",
    target: "formbricks-slack-integration",
  })),
  ...[
    [44, "isUpdatingSegment"],
    [45, "isDeletingSegment"],
  ].map(([line, name]) => ({
    action: "use-observable" as const,
    file: "segment-settings.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "A literal pending transition starts immediately before one awaited segment command, and one stable button leaf can subscribe without invalidating the editor owner.",
    target: "formbricks-segment-settings",
  })),
  {
    action: "review-state",
    file: "segment-settings.tsx",
    hook: "useState",
    line: 42,
    name: "segment",
    rationale:
      "The editable segment drives validation, filter cardinality, multiple fields, and update payloads across the owner rather than one status leaf.",
    target: "formbricks-segment-settings",
  },
  ...[
    [
      56,
      "hittingEndpoint",
      "use-observable",
      "The endpoint command is reachable from both a direct test event and a proven React Hook Form submit adapter; its pending transition reaches suspension before other React state writes.",
    ],
    [
      61,
      "creatingWebhook",
      "review-state",
      "Creation validates several owner fields and invokes endpoint testing, which changes other React state before its first await; this is a coupled workflow status, not an isolated pending leaf.",
    ],
  ].map(([line, name, action, rationale]) => ({
    action: action as "review-state" | "use-observable",
    file: "add-webhook-modal.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale: rationale as string,
    target: "formbricks-add-webhook",
  })),
  {
    action: "use-ref",
    file: "add-webhook-modal.tsx",
    hook: "useState",
    line: 63,
    enforced: false,
    name: "webhookSecret",
    rationale:
      "The secret never renders; direct test and imported React Hook Form submit commands read it before any same-command write, while endpoint completion and modal reset own every mutation.",
    // Rendered calls or mutable reads still need an independent-refresh proof.
    target: "formbricks-add-webhook",
  },
  {
    action: "review-state",
    file: "create-attribute-modal.tsx",
    hook: "useState",
    line: 43,
    name: "isCreating",
    rationale:
      "Validation can write the owner error state before creation begins, so converting only the pending flag cannot prove that the initial command render is isolated.",
    target: "formbricks-create-attribute",
  },
  {
    action: "use-observable",
    file: "pricing-table.tsx",
    hook: "useState",
    line: 326,
    name: "isRetryingStripeSetup",
    rationale:
      "Retry status brackets one awaited command reached through source-resolved alert and button wrappers; only the warning button subscribes, avoiding a rerender of the very large pricing owner.",
    target: "formbricks-pricing-table",
  },
  {
    action: "use-observable",
    file: "survey-dropdown-menu.tsx",
    hook: "useState",
    line: 80,
    name: "loading",
    rationale:
      "The source-resolved delete dialog invokes one awaited delete command, while separate dialog subscribers keep the forty-two-element menu owner outside both literal pending transitions.",
    target: "formbricks-survey-dropdown",
  },
  {
    action: "use-observable",
    file: "delete-workspace-render.tsx",
    hook: "useState",
    line: 35,
    name: "isDeleting",
    rationale:
      "The delete command reaches an intrinsic button through DeleteDialog and a default-intrinsic polymorphic Button, while only the stable dialog leaf consumes the pending flag; analysis must prove that complete callback chain before enforcing the migration.",
    target: "formbricks-delete-workspace",
  },
  {
    action: "review-state",
    file: "archive-feedback-directory.tsx",
    hook: "useState",
    line: 34,
    name: "isArchiveDialogOpen",
    rationale:
      "The visibility flag controls the dialog's conditional mount and closes in the async archive transaction; keep it under review until one grouped model proves mount identity and atomic completion.",
    target: "formbricks-archive-feedback-directory",
  },
  {
    action: "use-observable",
    file: "archive-feedback-directory.tsx",
    hook: "useState",
    line: 35,
    name: "isArchiving",
    rationale:
      "The source-proven archive button starts the pending interval before awaited work, and two stable button leaves can subscribe while the trigger and dialog body remain outside them.",
    target: "formbricks-archive-feedback-directory",
  },
  {
    action: "use-observable",
    file: "survey-dropdown-menu.tsx",
    hook: "useState",
    line: 81,
    name: "isArchiving",
    rationale:
      "The pending transition reaches the archive request before any other owner state changes, and only the archive confirmation button subscribes.",
    target: "formbricks-survey-dropdown",
  },
  {
    action: "review-state",
    file: "filter-value-combobox.tsx",
    hook: "useState",
    line: 62,
    name: "search",
    rationale:
      "A one-hop trimmed alias feeds debounce and query hooks, so the owner must rerender when search changes.",
    target: "formbricks-filter-value",
  },
  {
    action: "review-effect",
    file: "filter-value-combobox.tsx",
    hook: "useEffect",
    line: 95,
    name: null,
    rationale:
      "The effect resets the query draft when the combobox closes; preserve React dependency timing.",
    target: "formbricks-filter-value",
  },
  {
    action: "review-state",
    file: "recontact-options-card.tsx",
    hook: "useState",
    line: 83,
    name: "open",
    rationale:
      "Open controls almost the entire cohesive Collapsible root, leaving no smaller subscriber boundary.",
    target: "formbricks-recontact-options",
  },
  {
    action: "review-effect",
    file: "recontact-options-card.tsx",
    hook: "useEffect",
    line: 134,
    name: null,
    rationale:
      "The effect synchronizes the controlled card with changing survey type inputs and should remain in React.",
    target: "formbricks-recontact-options",
  },
  {
    action: "review-state",
    file: "when-to-send-card.tsx",
    hook: "useState",
    line: 40,
    name: "open",
    rationale:
      "Open controls almost the entire cohesive Collapsible root, leaving no smaller subscriber boundary.",
    target: "formbricks-when-to-send",
  },
  {
    action: "use-observable",
    file: "when-to-send-card.tsx",
    hook: "useState",
    line: 42,
    name: "isEditActionModalOpen",
    rationale:
      "The edit visibility flag and persistent action payload open together and can subscribe inside one stable wrapper around the resolved dialog target.",
    target: "formbricks-when-to-send",
  },
  {
    action: "use-observable",
    file: "when-to-send-card.tsx",
    hook: "useState",
    line: 43,
    name: "editingActionClass",
    rationale:
      "The payload controls one bounded dialog gate; moving the complete gate into an always-mounted leaf preserves the dialog's current open/close mount behavior.",
    target: "formbricks-when-to-send",
  },
  {
    action: "review-effect",
    file: "when-to-send-card.tsx",
    hook: "useEffect",
    line: 150,
    name: null,
    rationale:
      "The effect synchronizes card disclosure with changing survey inputs and should retain React timing.",
    target: "formbricks-when-to-send",
  },
  {
    action: "use-observable",
    file: "selected-row-settings.tsx",
    hook: "useState",
    line: 40,
    name: "isDeleting",
    rationale:
      "The true pending transition reaches chunk deletion before any other owner state changes, and only DeleteDialog subscribes; the existing finally block remains intact.",
    target: "formbricks-selected-row-settings",
  },
  {
    action: "use-observable",
    file: "selected-row-settings.tsx",
    hook: "useState",
    line: 51,
    name: "decrementQuotas",
    rationale:
      "The synchronized checkbox has a bounded leaf subscriber; the delete command should snapshot its value once before deferred work.",
    target: "formbricks-selected-row-settings",
  },
  {
    action: "review-effect",
    file: "selected-row-settings.tsx",
    hook: "useEffect",
    line: 61,
    name: null,
    rationale:
      "Preserve the React effect that reseeds the deletion option, changing only the observable draft sink.",
    target: "formbricks-selected-row-settings",
  },
  ...[
    [
      "formbricks-taxonomy-container",
      "topics-subtopics-container.tsx",
      66,
      "viewMode",
      "TaxonomyDisplay",
    ],
    [
      "formbricks-workflow-email-form",
      "workflow-email-action-form.tsx",
      75,
      "firstRender",
      "Editor",
    ],
    [
      "formbricks-workflows-list",
      "workflows-list-page.tsx",
      57,
      "isStatusDropdownOpen",
      "WorkflowFilterDropdown",
    ],
    ["formbricks-survey-editor", "survey-editor.tsx", 101, "localStylingChanges", "StylingView"],
    ["formbricks-theme-styling", "theme-styling.tsx", 84, "formStylingOpen", "FormStylingSettings"],
    ["formbricks-theme-styling", "theme-styling.tsx", 85, "cardStylingOpen", "CardStylingSettings"],
    [
      "formbricks-theme-styling",
      "theme-styling.tsx",
      86,
      "backgroundStylingOpen",
      "BackgroundStylingCard",
    ],
    ["formbricks-delete-account", "DeleteAccount.tsx", 29, "isModalOpen", "DeleteAccountModal"],
  ].map(([target, file, line, name, consumer]) => ({
    action: "use-observable" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale: `One branch-local ${consumer} call site owns the complete value and setter surface; owner-lifetime observable ownership preserves state across alternate returns or conditional mounts while isolating child updates.`,
    target: target as string,
  })),
  ...[
    [
      "formbricks-taxonomy-container",
      "topics-subtopics-container.tsx",
      64,
      "directoryId",
      "Directory identity feeds query keys, derived scope, and the complete taxonomy owner.",
    ],
    [
      "formbricks-workflow-email-form",
      "workflow-email-action-form.tsx",
      80,
      "touchedFields",
      "Touched-field state drives validation across several fields and cannot be isolated into the editor call site.",
    ],
    [
      "formbricks-workflows-list",
      "workflows-list-page.tsx",
      53,
      "searchValue",
      "Search state drives debouncing, persistence, and list queries rather than one presentation leaf.",
    ],
    [
      "formbricks-survey-editor",
      "survey-editor.tsx",
      91,
      "localSurvey",
      "The local survey is the editor's central mutable model and controls hooks, branches, and many children.",
    ],
    [
      "formbricks-theme-styling",
      "theme-styling.tsx",
      80,
      "previewSurveyType",
      "Survey type feeds multiple styling and preview consumers, so a one-call-site migration would be incomplete.",
    ],
  ].map(([target, file, line, name, rationale]) => ({
    action: "review-state" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale: rationale as string,
    target: target as string,
  })),
  ...[
    [
      "formbricks-taxonomy-container",
      "topics-subtopics-container.tsx",
      105,
      "Selection reconciliation follows changing tree data and the current selected node.",
    ],
    [
      "formbricks-survey-editor",
      "survey-editor.tsx",
      122,
      "Survey initialization coordinates several React states from a changing survey snapshot.",
    ],
  ].map(([target, file, line, rationale]) => ({
    action: "review-effect" as const,
    file: file as string,
    hook: "useEffect" as const,
    line: line as number,
    name: null,
    rationale: `${rationale} Keep the causal React synchronization under review rather than replacing it with a Legend reaction.`,
    target: target as string,
  })),
  {
    action: "keep-effect",
    file: "topics-subtopics-container.tsx",
    hook: "useEffect",
    line: 141,
    name: null,
    rationale:
      "A terminal taxonomy run status invalidates the external query cache after React commits; the effect should remain dependency-driven React integration.",
    target: "formbricks-taxonomy-container",
  },
  {
    action: "keep-effect",
    file: "workflow-email-action-form.tsx",
    hook: "useEffect",
    line: 131,
    name: null,
    rationale:
      "A changed trigger survey intentionally clears incompatible editor content and marks its fields touched after commit.",
    target: "formbricks-workflow-email-form",
  },
  {
    action: "keep-effect",
    file: "workflows-list-page.tsx",
    hook: "useEffect",
    line: 64,
    name: null,
    rationale:
      "Mount hydration reads browser storage and seeds the complete React filter model; this is React lifecycle ownership.",
    target: "formbricks-workflows-list",
  },
  {
    action: "keep-effect",
    file: "workflows-list-page.tsx",
    hook: "useEffect",
    line: 80,
    name: null,
    rationale:
      "Filter changes persist to browser storage after commit; this is a dependency-driven external sink, not a Legend reaction.",
    target: "formbricks-workflows-list",
  },
  {
    action: "keep-effect",
    file: "survey-editor.tsx",
    hook: "useEffect",
    line: 137,
    name: null,
    rationale:
      "The effect installs and removes a document visibility listener whose callback refreshes external workspace data.",
    target: "formbricks-survey-editor",
  },
  ...[
    ["formbricks-response-table", "ResponseTable.tsx", 88, "isTableSettingsModalOpen"],
    ["formbricks-contacts-table", "contacts-table.tsx", 69, "isTableSettingsModalOpen"],
    ["formbricks-attributes-table", "attributes-table.tsx", 51, "isTableSettingsModalOpen"],
  ].map(([target, file, line, name]) => ({
    action: "use-observable" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "Table controls issue open commands from broad and repeated surfaces, while one settings modal is the only value subscriber.",
    target: target as string,
  })),
  ...[
    [
      "formbricks-survey-list",
      "survey-list.tsx",
      155,
      "surveyFilters",
      "Filter state drives normalization, persistence, and list queries across the owner.",
    ],
    [
      "formbricks-response-table",
      "ResponseTable.tsx",
      86,
      "columnVisibility",
      "Visibility state is a controlled table model synchronized with storage and table rendering.",
    ],
    [
      "formbricks-contacts-table",
      "contacts-table.tsx",
      67,
      "columnVisibility",
      "Visibility state is a controlled table model synchronized with storage and table rendering.",
    ],
    [
      "formbricks-attributes-table",
      "attributes-table.tsx",
      49,
      "columnVisibility",
      "Visibility state is a controlled table model synchronized with storage and table rendering.",
    ],
    [
      "formbricks-attributes-table",
      "attributes-table.tsx",
      54,
      "searchValue",
      "Search state changes table derivation and filtering rather than one isolated presentation leaf.",
    ],
  ].map(([target, file, line, name, rationale]) => ({
    action: "review-state" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale: rationale as string,
    target: target as string,
  })),
  ...[
    [
      "formbricks-survey-list",
      "survey-list.tsx",
      159,
      "Storage hydration parses external data and reconciles the complete React filter model.",
    ],
    [
      "formbricks-survey-list",
      "survey-list.tsx",
      222,
      "Archived-filter reconciliation changes React list state from changing query results.",
    ],
    [
      "formbricks-response-table",
      "ResponseTable.tsx",
      170,
      "Storage hydration seeds several controlled table fields and must remain under causal review.",
    ],
    [
      "formbricks-contacts-table",
      "contacts-table.tsx",
      84,
      "Storage hydration seeds several controlled table fields and must remain under causal review.",
    ],
    [
      "formbricks-attributes-table",
      "attributes-table.tsx",
      84,
      "Storage hydration seeds several controlled table fields and must remain under causal review.",
    ],
    [
      "formbricks-attributes-table",
      "attributes-table.tsx",
      143,
      "Read-only data changes reconcile table visibility state rather than writing an external persistence sink.",
    ],
  ].map(([target, file, line, rationale]) => ({
    action: "review-effect" as const,
    file: file as string,
    hook: "useEffect" as const,
    line: line as number,
    name: null,
    rationale: rationale as string,
    target: target as string,
  })),
  ...[
    [
      48,
      "workspaces",
      "The asynchronous effect owns the workspace collection, which also drives options and submit error reporting.",
    ],
    [
      49,
      "workspacesLoading",
      "The dependency-driven Promise chain swaps the complete modal body, not one event-owned presentation leaf.",
    ],
  ].map(([line, name, rationale]) => ({
    action: "review-state" as const,
    file: "copy-survey-modal.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale: rationale as string,
    target: "formbricks-copy-survey-modal",
  })),
  {
    action: "review-effect",
    file: "copy-survey-modal.tsx",
    hook: "useEffect",
    line: 56,
    name: null,
    rationale:
      "The effect follows modal and workspace inputs, resets form state, loads data, and owns the Promise lifecycle.",
    target: "formbricks-copy-survey-modal",
  },
  ...[
    [
      "formbricks-create-organization-modal",
      "index.tsx",
      36,
      "loading",
      "React Hook Form's submit adapter reaches one awaited create command, while only the submit button renders its pending interval.",
    ],
    [
      "formbricks-setup-create-organization",
      "create-organization.tsx",
      23,
      "isSubmitting",
      "The inline React Hook Form submit adapter owns one pending interval whose button leaf is independent of the form fields and heading.",
    ],
    [
      "formbricks-action-settings",
      "ActionSettingsTab.tsx",
      53,
      "isUpdatingAction",
      "React Hook Form invokes the update command from the form event, and only the stable save button consumes its pending state.",
    ],
  ].map(([target, file, line, name, rationale]) => ({
    action: "use-observable" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale: rationale as string,
    target: target as string,
  })),
  {
    action: "use-observable",
    file: "index.tsx",
    hook: "useState",
    line: 55,
    name: "isLoading",
    rationale:
      "The loading flag has one stable button consumer and an independently useful transition before awaited work; repeated idempotent writes and later external updates do not prevent the owner render cut.",
    target: "formbricks-save-segment",
  },
  {
    action: "use-observable",
    file: "survey-menu-bar.tsx",
    hook: "useState",
    line: 71,
    name: "isLinkSurvey",
    rationale:
      "The true initializer must survive until the effect writes the survey-type comparison. Separate subscribers can own the two bounded conditional button surfaces while preserving that effect, its timing, and both conditional mounts.",
    target: "formbricks-survey-menu-bar",
  },
  {
    action: "keep-effect",
    file: "survey-menu-bar.tsx",
    hook: "useEffect",
    line: 91,
    name: null,
    rationale:
      "The true initializer must survive until the effect writes the survey-type comparison. Separate subscribers can own the two bounded conditional button surfaces while preserving that effect, its timing, and both conditional mounts.",
    target: "formbricks-survey-menu-bar",
  },
  {
    action: "review-state",
    file: "dashboard-date-filter.tsx",
    hook: "useState",
    line: 46,
    name: "isCustomMode",
    rationale:
      "The synchronized mode is read by an immediately invoked render computation that controls the selected value and custom-range mount.",
    target: "formbricks-dashboard-date-filter-state",
  },
  {
    action: "keep-effect",
    file: "survey-menu-bar.tsx",
    hook: "useEffect",
    line: 109,
    name: null,
    rationale:
      "The saved-flag reset reads a survey prop and a ref; the owner's audience-prompt state never reaches it, so no local state migration changes this effect.",
    target: "formbricks-survey-menu-bar",
  },
  {
    action: "keep-effect",
    file: "GoogleSheetWrapper.tsx",
    hook: "useEffect",
    line: 58,
    name: null,
    rationale:
      "The validation effect reaches `isConnected`, kept as React state, and `showReconnectButton`, which migrates to an observable; the effect stays and the reconnect write becomes an observable write.",
    target: "formbricks-google-sheet-wrapper",
  },
  {
    action: "move-state-down",
    file: "add-filter-modal.tsx",
    hook: "useState",
    line: 179,
    name: "activeTabId",
    rationale:
      "The tab id is read only by the tab bar and by `getTabContent`, an owner-level render helper used once inside the same filter column; both move into a leaf around that column, so the dialog body no longer renders per tab change.",
    target: "formbricks-add-filter-modal",
  },
  {
    action: "use-observable",
    file: "ElementFilterComboBox.tsx",
    hook: "useState",
    line: 88,
    name: "searchQuery",
    rationale:
      "The query is read only by the `filteredOptions` memo and the command input inside the conditionally mounted command list; the owner keeps the observable so the draft survives closing, and the list wrapper subscribes and hosts the memo.",
    target: "formbricks-element-filter-combobox",
  },
  {
    action: "use-observable",
    file: "response-options-card.tsx",
    hook: "useState",
    line: 53,
    name: "verifyEmailToggle",
    rationale:
      "The toggle is read only by one advanced-option row and written only by `handleVerifyEmailToogle`, whose sole use is that row's callback; the row mounts conditionally, so the owner keeps the observable and the row wrapper subscribes and hosts the handler with the survey props it still reads.",
    target: "formbricks-response-options-card",
  },
  {
    action: "use-observable",
    file: "when-to-send-card.tsx",
    hook: "useState",
    line: 45,
    name: "randomizerToggle",
    rationale:
      "The toggle is read by one advanced-option row and written only by its handler, which is used only there; the card has an early `return null`, so the owner keeps the observable and the row wrapper subscribes and hosts the handler.",
    target: "formbricks-when-to-send",
  },
] as const satisfies readonly GoldHookCase[];
