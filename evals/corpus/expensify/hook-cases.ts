import type { GoldHookCase } from "../contracts.js";
import type { HookAction } from "../../../src/core/types.js";

export const expensifyHookCases = [
  {
    action: "use-observable",
    file: "useCompleteOnboarding.ts",
    hook: "useState",
    line: 59,
    name: "isLoading",
    rationale:
      "The hook publishes loading without reading it, and both indexed onboarding screens render it only at one stable submit-button site; each screen can subscribe there while the async command stays hook-owned.",
    target: "expensify-complete-onboarding",
  },
  {
    action: "use-observable",
    file: "ImportSpreadsheet.tsx",
    hook: "useState",
    line: 57,
    name: "fileTopPosition",
    rationale:
      "The layout event can update an owner-lifetime observable while one stable positioned-view leaf inside the existing screen render callback subscribes to the only rendered projection.",
    target: "expensify-import-spreadsheet",
  },
  {
    action: "use-observable",
    file: "AttachmentPickerWithMenuItems.tsx",
    hook: "useState",
    line: 164,
    name: "popoverAnchorPosition",
    rationale:
      "The existing effect and promise continuation can retain their timing while one stable popover leaf inside the screen render callback subscribes to the calculated anchor position.",
    target: "expensify-attachment-picker-menu",
  },
  {
    action: "review-state",
    file: "ReportActionItem.tsx",
    hook: "useState",
    line: 227,
    name: "isReportActionActive",
    rationale:
      "Both projections share one narrow frame, but the hover setters cross a platform-selected wrapper and prop spread before reaching their event and effect producers; keep the opportunity under review until that chain is proven.",
    target: "expensify-report-action-item",
  },
  {
    action: "review-state",
    file: "ReceiptEmptyState.tsx",
    hook: "useState",
    line: 93,
    name: "isHovered",
    rationale:
      "The icon is a narrow consumer, but both hover setters are published through a runtime-selected component alias whose callback timing is unresolved; keep this opportunity under review.",
    target: "expensify-receipt-empty-state",
  },
  {
    action: "keep-effect",
    file: "ReceiptEmptyState.tsx",
    hook: "useEffect",
    line: 111,
    name: null,
    rationale:
      "The ref-latched load notification reads only a prop callback and a ref; the latch already survives Strict Mode replay, so a Legend mount hook would change behavior and no state migration touches this effect.",
    target: "expensify-receipt-empty-state",
  },
  {
    action: "keep-effect",
    file: "index.tsx",
    hook: "useEffect",
    line: 97,
    name: null,
    rationale:
      "Navigation state pauses the committed animation instance after render through one optional ref receiver chain.",
    target: "expensify-lottie",
  },
  {
    action: "keep-effect",
    file: "BaseSelectionList.tsx",
    hook: "useEffect",
    line: 453,
    name: null,
    rationale:
      "The mount effect guards and clears a timeout stored in a committed ref; its bare return and post-commit ordering stay in React.",
    target: "expensify-base-selection-list",
  },
  ...[
    [47, "currentCountry"],
    [48, "state"],
    [49, "city"],
    [50, "zipcode"],
  ].map(([line, name]) => ({
    action: "use-observable" as const,
    file: "AddressPage.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "The complete address draft is reseeded synchronously by one React effect and edited atomically through one form boundary; preserve the effect and subscribe in the form leaf.",
    target: "expensify-address",
  })),
  {
    action: "review-effect",
    file: "AddressPage.tsx",
    hook: "useEffect",
    line: 52,
    name: null,
    rationale:
      "Preserve the guarded React synchronization phase and dependency timing while replacing only its grouped draft sink.",
    target: "expensify-address",
  },
  {
    action: "use-observable",
    file: "index.tsx",
    hook: "useState",
    line: 51,
    name: "startPermissionsFlow",
    rationale:
      "The disabled-services return makes its modal transition mutually exclusive with starting the permission flow; one stable child wrapper can subscribe without rerendering the GPS controls.",
    target: "expensify-gps-permissions-flow",
  },
  {
    action: "use-observable",
    file: "index.tsx",
    hook: "useState",
    line: 115,
    name: "shouldShowTime",
    rationale:
      "Layout measurement controls one time-display gate; an always-mounted subscriber avoids rerendering all video controls.",
    target: "expensify-video-controls",
  },
  ...[
    ["expensify-upload-documents", 48],
    ["expensify-nonusd-upload-documents", 50],
  ].map(([target, line]) => ({
    action: "use-observable" as const,
    file: "UploadDocuments.tsx",
    hook: "useState" as const,
    line: line as number,
    name: "isPDSandFSGDownloadedTouched",
    rationale:
      "Validation touches only one compound error gate; keep Onyx state external and subscribe in an always-mounted error wrapper.",
    target: target as string,
  })),
  ...[
    [71, "currentCountry"],
    [72, "state"],
    [73, "city"],
    [74, "zipcode"],
  ].map(([line, name]) => ({
    action: "use-observable" as const,
    file: "AddressStep.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "The complete cascading address draft is synchronized atomically and rendered through one AddressForm leaf; TypeScript-only prop casts do not change transport ownership.",
    target: "expensify-bank-address-step",
  })),
  {
    action: "review-effect",
    file: "AddressStep.tsx",
    hook: "useEffect",
    line: 76,
    name: null,
    rationale:
      "Preserve the guarded React address synchronization effect and its exact dependency timing; replace only its grouped state sink.",
    target: "expensify-bank-address-step",
  },
  {
    action: "review-state",
    file: "DomainMemberDetailsPage.tsx",
    hook: "useState",
    line: 57,
    name: "isModalVisible",
    rationale:
      "One path reopens the decision modal while clearing its deferred force-close choice; migrating visibility alone could publish the reopened modal with the previous React snapshot.",
    target: "expensify-domain-member",
  },
  {
    action: "review-state",
    file: "ChronosScheduleOOOPage.tsx",
    hook: "useState",
    line: 54,
    name: "selectedDurationUnit",
    rationale:
      "The selected unit participates in the page's duration transaction and has no independently isolated presentation leaf.",
    target: "expensify-chronos",
  },
  {
    action: "review-state",
    file: "DomainMemberDetailsPage.tsx",
    hook: "useState",
    line: 58,
    name: "shouldForceCloseAccount",
    rationale:
      "The command reads and later resets this decision snapshot across an awaited custom-modal flow; source does not prove a committed render before another invocation can observe the reset.",
    target: "expensify-domain-member",
  },
  {
    action: "review-state",
    file: "index.tsx",
    hook: "useState",
    line: 140,
    name: "searchValue",
    rationale:
      "Search text drives filtering and result ownership in the address-search owner, so a leaf subscription cannot remove its render work.",
    target: "expensify-address-search",
  },
  {
    action: "review-state",
    file: "index.tsx",
    hook: "useState",
    line: 141,
    name: "locationErrorCode",
    rationale:
      "Location errors are published with geolocation result and loading transitions; an independent dismiss path does not make the other writes safe to split across React and Legend ownership.",
    target: "expensify-address-search",
  },
  ...[
    [66, "keep-effect"],
    [84, "keep-effect"],
    [367, "use-unmount"],
  ].map(([line, action]) => ({
    action: action as "keep-effect" | "use-unmount",
    file: "index.tsx",
    hook: "useEffect" as const,
    line: line as number,
    name: null,
    rationale:
      line === 367
        ? "The empty-dependency effect contains only unmount invalidation of the geolocation callback guard."
        : "The effect owns paired child-presence setup and cleanup against a changing callback dependency.",
    target: "expensify-address-search",
  })),
  ...[
    [41, "containerHeight"],
    [42, "uploadViewHeight"],
    [43, "altMethodsHeight"],
  ].map(([line, name]) => ({
    action: "use-observable" as const,
    file: "FileUpload.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "The three layout measurements form one observable model whose derived visibility is consumed only by the ReceiptAlternativeMethods gate.",
    target: "expensify-camera-file-upload",
  })),
  {
    action: "use-observable",
    file: "DynamicNewTaskPage.tsx",
    hook: "useState",
    line: 63,
    name: "error",
    rationale:
      "The immutable errorMessage projection is consumed only by FormAlertWithSubmitButton, isolating validation renders from the task page.",
    target: "expensify-dynamic-task",
  },
  {
    action: "keep-effect",
    file: "DynamicNewTaskPage.tsx",
    hook: "useEffect",
    line: 78,
    name: null,
    rationale:
      "The route task synchronization is one external command keyed by route state and remains a React effect.",
    target: "expensify-dynamic-task",
  },
  ...[
    [31, "isReimbursable", "use-observable"],
    [32, "flipAmountSign", "use-observable"],
    [33, "shouldShowError", "use-observable"],
  ].map(([line, name, action]) => ({
    action: action as "review-state" | "use-observable",
    file: "ImportTransactionsPage.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      line === 33
        ? "The validation flag projects only into one card-name error leaf; the full gate can subscribe without rerendering the form."
        : "The controlled toggle is the only live subscriber; the Next command can read its latest observable snapshot without rerendering the page.",
    target: "expensify-import-transactions",
  })),
  ...[
    [47, "defaultGroupForNewMembers", "use-observable"],
    [48, "strictlyEnforceWorkspaceRules", "use-observable"],
    [49, "restrictDefaultLoginSelection", "use-observable"],
    [50, "restrictExpenseWorkspaceCreation", "use-observable"],
    [51, "expensifyCardPreferredWorkspace", "review-state"],
    [52, "preferredWorkspace", "review-state"],
  ].map(([line, name, action]) => ({
    action: action as "review-state" | "use-observable",
    file: "DomainGroupCreatePage.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      (line as number) <= 50
        ? "One controlled toggle owns the live value while form submission reads a non-tracking snapshot; isolating it avoids rerendering the domain form."
        : "This toggle participates in conditional availability and companion workflow writes, so a standalone observable cut is not proven.",
    target: "expensify-domain-group-create",
  })),
  {
    action: "use-unmount",
    file: "DomainGroupCreatePage.tsx",
    hook: "useEffect",
    line: 72,
    name: null,
    rationale:
      "The effect has no setup work and only clears the preferred-policy resource on unmount.",
    target: "expensify-domain-group-create",
  },
  {
    action: "use-observable",
    file: "Nationality.tsx",
    hook: "useState",
    line: 33,
    name: "selectedCountry",
    rationale:
      "The country picker is the only live subscriber; the form submit command reads one latest snapshot without rerendering the surrounding form.",
    target: "expensify-beneficial-owner-nationality",
  },
  ...[
    [103, "isDeleteWorkspaceFlowVisible", "use-observable"],
    [183, "pendingRulesDocumentFile", "review-state"],
  ].map(([line, name, action]) => ({
    action: action as "review-state" | "use-observable",
    file: "WorkspaceOverviewPage.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      line === 103
        ? "One owner-scoped observable and an always-mounted full-gate subscriber preserve the keyed delete-flow lifetime while avoiding overview rerenders."
        : "The rules document payload drives several owner commands and render sites, so a single leaf subscription is not proven.",
    target: "expensify-workspace-overview",
  })),
  {
    action: "keep-effect",
    file: "WorkspaceOverviewPage.tsx",
    hook: "useEffect",
    line: 280,
    name: null,
    rationale:
      "This effect issues one committed-ref command when the external workspace signal changes and remains in React.",
    target: "expensify-workspace-overview",
  },
  ...[
    ["expensify-workspace-categories", "WorkspaceCategoriesPage.tsx", 72],
    ["expensify-workspace-per-diem", "WorkspacePerDiemPage.tsx", 98],
    ["expensify-workspace-tags", "WorkspaceTagsPage.tsx", 94],
  ].map(([target, file, line]) => ({
    action: "use-observable" as const,
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: "isDownloadFailureModalVisible",
    rationale:
      "A source-resolved deferred option command owns this failure flag and one stable DecisionModal is its only subscriber; converting the literal commands preserves callback timing while removing broad page rerenders.",
    target: target as string,
  })),
  {
    action: "use-observable",
    file: "ImportTagsOptionsPage.tsx",
    hook: "useState",
    line: 62,
    name: "isDownloadFailureModalVisible",
    rationale:
      "A direct UI command owns this failure flag and one stable DecisionModal is its only subscriber.",
    target: "expensify-import-tags-options",
  },
  {
    action: "review-state",
    file: "ImportTagsOptionsPage.tsx",
    hook: "useState",
    line: 63,
    name: "shouldRunPostUpgradeFlow",
    rationale:
      "A focus lifecycle callback consumes this latch; React state currently republishes callback identity when the value changes.",
    target: "expensify-import-tags-options",
  },
  {
    action: "review-state",
    file: "WorkspaceOverviewDescriptionPage.tsx",
    hook: "useState",
    line: 38,
    name: "description",
    rationale:
      "The value and setter are already wholly owned by one compact input boundary, while form submission consumes form values rather than this state; adding an owner observable has no proven benefit.",
    target: "expensify-workspace-description",
  },
  ...[
    [134, "expirationDate", "review-state"],
    [177, "cardNumber", "use-observable"],
  ].map(([line, name, action]) => ({
    action: action as "review-state" | "use-observable",
    file: "PaymentCardForm.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      line === 177
        ? "A direct string draft is rendered by one stable InputWrapper; isolate its high-frequency updates from the rest of the payment form."
        : "The expiration draft snapshots external Onyx form state, so direct primitive initialization does not prove ownership.",
    target: "expensify-payment-card",
  })),
  ...[
    [41, "isSkippedSectionExpanded", "review-state"],
    [42, "isVisible", "use-observable"],
  ].map(([line, name, action]) => ({
    action: action as "review-state" | "use-observable",
    file: "HRSyncResultsModal.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      line === 42
        ? "A true-initialized visibility value has one stable Modal consumer and independent close commands."
        : "Expansion changes both icon presentation and skipped-employee list cardinality, so it is not a single leaf subscription.",
    target: "expensify-hr-sync-results",
  })),
  {
    action: "use-ref",
    file: "BigNumberPad.tsx",
    hook: "useState",
    line: 39,
    enforced: false,
    name: "timer",
    rationale:
      "The interval handle is written by long-press setup and read only by the release command; it never renders.",
    // Rendered calls or mutable reads still need an independent-refresh proof.
    target: "expensify-big-number-pad",
  },
  {
    action: "keep-effect",
    file: "BigNumberPad.tsx",
    hook: "useEffect",
    line: 43,
    name: null,
    rationale:
      "This effect keeps the latest numberPressed prop in an imperative ref and should retain React dependency timing.",
    target: "expensify-big-number-pad",
  },
  {
    action: "review-state",
    file: "index.tsx",
    hook: "useState",
    line: 126,
    name: "isUsingKeyboardMovement",
    rationale:
      "The value renders inside the list renderItem callback and also participates in focus callbacks; it is not command-only state.",
    target: "expensify-emoji-picker-menu",
  },
  ...[
    [127, "highlightEmoji"],
    [128, "highlightFirstEmoji"],
  ].map(([line, name]) => ({
    action: "review-state" as const,
    file: "index.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "Highlight state participates in focus callbacks and repeated emoji rendering in an owner with ref-driven focus management; a command-only ref migration is not proven.",
    target: "expensify-emoji-picker-menu",
  })),
  {
    action: "use-observable",
    file: "WorkspaceMemberCustomFieldPage.tsx",
    hook: "useState",
    line: 50,
    name: "customField",
    rationale:
      "The editable value renders in one InputWrapper and is read by the save event, isolating keystrokes from the page shell.",
    target: "expensify-workspace-custom-field",
  },
  ...[
    [
      144,
      "makeMeAdmin",
      "use-observable",
      "The conditional admin switch owns one presentation subscriber while confirmation reads its latest value as an event snapshot.",
    ],
    [
      134,
      "workspaceNameFirstCharacter",
      "review-state",
      "The workspace-name character drives avatar presentation and form coordination beyond one controlled leaf.",
    ],
    [
      148,
      null,
      "use-unmount",
      "The empty-dependency cleanup only clears the form draft on unmount.",
    ],
  ].map(([line, name, action, rationale]) => ({
    action: action as HookAction,
    file: "WorkspaceConfirmationForm.tsx",
    hook: (name === null ? "useEffect" : "useState") as "useEffect" | "useState",
    line: line as number,
    name: name as string | null,
    rationale: rationale as string,
    target: "expensify-workspace-confirmation",
  })),
  {
    action: "use-observable",
    file: "NamePage.tsx",
    hook: "useState",
    line: 45,
    name: "name",
    rationale:
      "The tax-name draft can keep owner-lifetime observable state while InputWrapper and submit validation subscribe below a state-independent not-found return.",
    target: "expensify-tax-name",
  },
  {
    action: "review-state",
    file: "SpendRulesCurrencyBase.tsx",
    hook: "useState",
    line: 54,
    name: "selectedCurrencies",
    rationale:
      "Selection currently shapes the complete list data passed through the search hook; membership syntax alone does not prove a smaller live subscriber.",
    target: "expensify-spend-rule-currencies",
  },
  {
    action: "review-state",
    file: "SpendRuleCardPage.tsx",
    hook: "useState",
    line: 106,
    name: "selectedCardIDs",
    rationale:
      "A focus lifecycle reseeds the selection and the value drives the controlled SelectionList and save validation, so a row-only observable rewrite is incomplete.",
    target: "expensify-spend-rule-cards",
  },
  {
    action: "use-observable",
    file: "index.tsx",
    hook: "useState",
    line: 50,
    name: "isSaving",
    rationale:
      "After validation and route decisions, the pending write starts one awaited save command and only the stable save button needs its loading subscription.",
    target: "expensify-gps-trip-edit",
  },
  {
    action: "review-state",
    file: "index.tsx",
    hook: "useState",
    line: 52,
    name: "pendingTrim",
    rationale:
      "The trim draft drives route geometry, distance calculations, slider presentation, and the save payload rather than one bounded status leaf.",
    target: "expensify-gps-trip-edit",
  },
  {
    action: "keep-effect",
    file: "index.tsx",
    hook: "useEffect",
    line: 70,
    name: null,
    rationale: "Keep the Mapbox token setup and paired teardown in one React lifecycle effect.",
    target: "expensify-gps-trip-edit",
  },
  {
    action: "review-state",
    file: "WorkspaceCompanyCardAddWorkEmailPage.tsx",
    hook: "useState",
    line: 57,
    name: "loading",
    rationale:
      "A synchronous email-state write follows the Promise-chain start, so the owner rerenders before completion and the loading transition is not an isolated leaf update.",
    target: "expensify-company-card-work-email",
  },
  {
    action: "review-state",
    file: "CardSection.tsx",
    hook: "useState",
    line: 126,
    name: "billingStatus",
    rationale:
      "Billing status replaces a top-level banner and changes multiple controls, so it has no bounded subscriber leaf.",
    target: "expensify-subscription-card",
  },
  {
    action: "review-effect",
    file: "CardSection.tsx",
    hook: "useEffect",
    line: 153,
    name: null,
    rationale:
      "This effect reconciles external subscription inputs with a dismissible local override; preserve React synchronization timing.",
    target: "expensify-subscription-card",
  },
  {
    action: "keep-effect",
    file: "CardSection.tsx",
    hook: "useEffect",
    line: 195,
    name: null,
    rationale:
      "Authentication-link navigation is an external lifecycle command keyed by subscription status, not a Legend observable reaction.",
    target: "expensify-subscription-card",
  },
  {
    action: "use-observable",
    enforced: false,
    file: "ImportSpreadsheet.tsx",
    hook: "useState",
    line: 56,
    name: "isReadingFile",
    rationale:
      "One Promise-chain command owns the literal reading interval, and only the choose-file button needs to subscribe while the broader importer stays stable.",
    target: "expensify-import-spreadsheet",
  },
  {
    action: "use-observable",
    file: "ImportMultiLevelTagsSettingsPage.tsx",
    hook: "useState",
    line: 54,
    name: "isImportingTags",
    rationale:
      "A conditionally selected event command starts one pending interval before its first await, and only the footer button subscribes; close and reset behavior stays in the owner.",
    target: "expensify-import-multi-level-tags",
  },
  {
    action: "use-mount",
    file: "ImportMultiLevelTagsSettingsPage.tsx",
    hook: "useEffect",
    line: 59,
    name: null,
    rationale:
      "This setup-only effect writes fixed imported configuration flags and captures no owner-local value; useMount is appropriate when suppressing development replay is intentional.",
    target: "expensify-import-multi-level-tags",
  },
  ...[
    [68, "isModifyTripLoading"],
    [69, "isTripSupportLoading"],
  ].map(([line, name]) => ({
    action: "use-observable" as const,
    enforced: false as const,
    file: "TripDetailsPage.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "One menu item owns the complete pending surface while independent reservation details remain outside its subscriber, so link completion need not invalidate the trip screen.",
    target: "expensify-trip-details",
  })),
  {
    action: "keep-state",
    file: "WalletStatementPage.tsx",
    hook: "useState",
    line: 47,
    name: "isDownloading",
    rationale:
      "Download status belongs to a four-element statement screen and guards the command as well as its header action, so the React owner is already cohesive.",
    target: "expensify-wallet-statement",
  },
  {
    action: "keep-effect",
    file: "WalletStatementPage.tsx",
    hook: "useEffect",
    line: 59,
    name: null,
    rationale:
      "Keep route validation and modal dismissal in a dependency-driven React effect; it is an external navigation command, not an observable reaction.",
    target: "expensify-wallet-statement",
  },
  {
    action: "review-state",
    file: "BaseOnboardingPersonalDetails.tsx",
    hook: "useState",
    line: 73,
    name: "isLoading",
    rationale:
      "Loading spans several onboarding branches, command guards, and the shared FormProvider, while completion mutates external onboarding state; one leaf subscription is incomplete.",
    target: "expensify-onboarding-personal-details",
  },
  {
    action: "use-mount",
    file: "BaseOnboardingPersonalDetails.tsx",
    hook: "useEffect",
    line: 83,
    name: null,
    rationale:
      "This empty-dependency setup only clears a module-owned onboarding error and captures no changing component value; useMount expresses the intended once-only setup.",
    target: "expensify-onboarding-personal-details",
  },
  ...[
    [
      39,
      "animationFile",
      "The effect deliberately publishes a new animation source after commit; deriving the prop during render would change fallback and native animation lifecycle timing.",
    ],
  ].map(([line, name, rationale]) => ({
    action: "review-state" as const,
    file: "index.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale: rationale as string,
    target: "expensify-lottie",
  })),
  {
    action: "keep-state",
    file: "index.tsx",
    hook: "useState",
    line: 40,
    name: "isInteractionComplete",
    rationale:
      "The transition gate is written only by its cancellable effect and read only by this two-element owner's root fallback, so an observable could not remove a render; the effect keeps its React timing.",
    target: "expensify-lottie",
  },
  {
    action: "review-effect",
    file: "index.tsx",
    hook: "useEffect",
    line: 42,
    name: null,
    rationale:
      "This prop-to-state effect intentionally changes the native animation source after commit; deleting it or replacing it with an observable reaction changes lifecycle timing.",
    target: "expensify-lottie",
  },
  {
    action: "keep-effect",
    file: "index.tsx",
    hook: "useEffect",
    line: 46,
    name: null,
    rationale:
      "Keep the post-transition scheduler and its exact cancellation cleanup in one React lifecycle effect.",
    target: "expensify-lottie",
  },
  {
    action: "review-state",
    file: "DynamicWorkspaceOverviewPlanTypePage.tsx",
    hook: "useState",
    line: 49,
    name: "currentPlan",
    rationale:
      "The selected plan rebuilds list item data and drives submit and navigation decisions across the page.",
    target: "expensify-dynamic-plan-type",
  },
  {
    action: "keep-effect",
    file: "DynamicWorkspaceOverviewPlanTypePage.tsx",
    hook: "useEffect",
    line: 57,
    name: null,
    rationale:
      "Loading the external workspace plan when policy identity changes belongs to React resource lifecycle ownership.",
    target: "expensify-dynamic-plan-type",
  },
  {
    action: "review-effect",
    file: "DynamicWorkspaceOverviewPlanTypePage.tsx",
    hook: "useEffect",
    line: 64,
    name: null,
    rationale:
      "This effect seeds an editable plan selection from changing props; preserve its React synchronization timing.",
    target: "expensify-dynamic-plan-type",
  },
  {
    action: "review-state",
    file: "AddAgentRuleSuggestionsTab.tsx",
    hook: "useState",
    line: 45,
    name: "searchValue",
    rationale:
      "Search changes the filtered row set and therefore still requires the owner to rebuild list data.",
    target: "expensify-agent-rule-suggestions",
  },
  {
    action: "use-observable",
    file: "AddAgentRuleSuggestionsTab.tsx",
    hook: "useState",
    line: 46,
    name: "selectedSuggestionID",
    rationale:
      "Stable suggestion rows can subscribe by ID while the footer resolves the selected suggestion in a separate leaf and the Next command snapshots it once.",
    target: "expensify-agent-rule-suggestions",
  },
  {
    action: "keep-state",
    file: "SingleSelect.tsx",
    hook: "useState",
    line: 70,
    name: "selectedItem",
    rationale:
      "Selection rebuilds the options passed to the cohesive SelectionList owner; a row-only observable would not remove that required render.",
    target: "expensify-search-single-select",
  },
  {
    action: "review-state",
    file: "SortByPopup.tsx",
    hook: "useState",
    line: 62,
    name: "selectedItem",
    rationale:
      "The selected sort value rebuilds the complete options model and is consumed by the Apply command inside the popup owner.",
    target: "expensify-sort-popup",
  },
  {
    action: "review-state",
    file: "SpendRuleSelectionPage.tsx",
    hook: "useState",
    line: 54,
    name: "cardRuleID",
    rationale:
      "Selection rebuilds list data and participates in validation, mutation payload, and navigation, so per-row equality is not a complete observable boundary.",
    target: "expensify-spend-rule-selection",
  },
  ...[
    [
      24,
      "highlightedIndex",
      "The cursor is synchronized from external preferred-tone state by a React effect, so a row-only selector would leave lifecycle ownership unresolved.",
    ],
    [
      25,
      "isSkinToneListVisible",
      "Visibility selects the complete compact picker branch and is closed by external preferred-tone synchronization.",
    ],
  ].map(([line, name, rationale]) => ({
    action: "review-state" as const,
    file: "EmojiSkinToneList.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale: rationale as string,
    target: "expensify-emoji-skin-tone",
  })),
  ...[
    [
      41,
      "The effect closes the picker when externally stored preferred tone changes; keep React dependency and commit timing.",
    ],
    [
      51,
      "The effect synchronizes a local hover cursor from externally stored preferred tone and is not a Legend-only reaction.",
    ],
  ].map(([line, rationale]) => ({
    action: "review-effect" as const,
    file: "EmojiSkinToneList.tsx",
    hook: "useEffect" as const,
    line: line as number,
    name: null,
    rationale: rationale as string,
    target: "expensify-emoji-skin-tone",
  })),
  ...[
    [
      45,
      "selectedCompanySize",
      "Selection rebuilds the SelectionList data model and participates in submit validation, so a row-only subscriber is incomplete.",
    ],
    [
      46,
      "error",
      "Validation error is coupled to the selection transaction and rendered through the list footer rather than an independent leaf command.",
    ],
  ].map(([line, name, rationale]) => ({
    action: "review-state" as const,
    file: "BaseOnboardingEmployees.tsx",
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale: rationale as string,
    target: "expensify-onboarding-employees",
  })),
  {
    action: "use-observable",
    file: "DynamicDebugDetailsDateTimePickerPage.tsx",
    hook: "useState",
    line: 35,
    name: "date",
    rationale:
      "DatePicker owns editing while the separate time-submit command snapshots the date, leaving the screen header and other picker independent.",
    target: "expensify-debug-date-time",
  },
  {
    action: "use-observable",
    file: "SignUpWelcomeForm.tsx",
    hook: "useState",
    line: 34,
    name: "hasSMSMarketingConsent",
    rationale:
      "The conditional checkbox is the only rendered consumer and the join command reads one consent snapshot without invalidating the form.",
    target: "expensify-signup-welcome",
  },
  {
    action: "use-observable",
    file: "WorkspaceCreateTaxValuePage.tsx",
    hook: "useState",
    line: 41,
    name: "currentValue",
    rationale:
      "The number form owns editing while the save command snapshots the value; header and navigation work stay outside the subscriber.",
    target: "expensify-create-tax-value",
  },
  {
    action: "keep-effect",
    file: "index.tsx",
    hook: "useEffect",
    line: 74,
    name: null,
    rationale:
      "A changed report permission closes the external modal after an imported emptiness guard.",
    target: "expensify-report-add-attachment",
  },
  {
    action: "keep-effect",
    file: "index.tsx",
    hook: "useEffect",
    line: 81,
    name: null,
    rationale:
      "The owner-local fetch callback closes only over route params and Onyx hook results, so the effect and its dependencies are independent of every local React state in this owner.",
    target: "expensify-report-add-attachment",
  },
  {
    action: "keep-effect",
    file: "DomainMemberForceTwoFactorAuthPage.tsx",
    hook: "useEffect",
    line: 33,
    name: null,
    rationale:
      "Membership in the changed exemption list drives one external navigation correction after commit.",
    target: "expensify-force-2fa",
  },
  {
    action: "keep-effect",
    file: "NewChatConfirmPage.tsx",
    hook: "useEffect",
    line: 64,
    name: null,
    rationale:
      "The file loader's success and failure callbacks write a parent-owned setter prop and an Onyx action, not local React state, so no state migration inside this owner changes the effect.",
    target: "expensify-new-chat-confirm",
  },
  ...[26, 35].map((line) => ({
    action: "keep-effect" as const,
    file: "ExpenseDefaultsSetter.tsx",
    hook: "useEffect" as const,
    line,
    name: null,
    rationale:
      "React dependency changes intentionally synchronize one default across the current external transaction collection.",
    target: "expensify-expense-defaults",
  })),
  {
    action: "keep-effect",
    file: "SearchAutocompleteList.tsx",
    hook: "useEffect",
    line: 674,
    name: null,
    rationale:
      "Changed search inputs drive one guarded command on the committed list ref after React commits.",
    target: "expensify-search-autocomplete",
  },
  {
    action: "review-state",
    file: "DynamicContactMethodDetailsPage.tsx",
    hook: "useState",
    line: 68,
    name: "isValidateCodeFormVisible",
    rationale:
      "The true initializer differs from the prop-derived effect value; preserving the first committed value and child mount inputs requires keeping the synchronization lifecycle.",
    target: "expensify-contact-method-details",
  },
  {
    action: "review-effect",
    file: "DynamicContactMethodDetailsPage.tsx",
    hook: "useEffect",
    line: 183,
    name: null,
    rationale:
      "The true initializer differs from the prop-derived effect value; preserving the first committed value and child mount inputs requires keeping the synchronization lifecycle.",
    target: "expensify-contact-method-details",
  },
  ...[
    ["expensify-emoji-picker-button-lifecycle", "EmojiPickerButton.tsx", 79],
    ["expensify-emoji-picker-dropdown-lifecycle", "EmojiPickerButtonDropdown.tsx", 47],
    ["expensify-add-reaction-lifecycle", "AddReactionBubble.tsx", 68],
  ].map(([target, file, line]) => ({
    action: "use-unmount" as const,
    file: file as string,
    hook: "useEffect" as const,
    line: line as number,
    name: null,
    rationale:
      "The empty-dependency effect returns an existing cleanup function without running setup work.",
    target: target as string,
  })),
  {
    action: "keep-effect",
    file: "Expensify.tsx",
    hook: "useEffect",
    line: 223,
    name: null,
    rationale:
      "The returned call starts an interval and produces its disposer, so React must retain the paired setup and cleanup.",
    target: "expensify-root-lifecycle",
  },
  ...[
    ["expensify-signer-info-lifecycle", 95],
    ["expensify-global-reimbursements-lifecycle", 61],
  ].map(([target, line]) => ({
    action: "keep-effect" as const,
    file: "index.tsx",
    hook: "useEffect" as const,
    line: line as number,
    name: null,
    rationale:
      "The returned call performs mount-time form cleanup and returns no disposer; it is not an unmount callback value.",
    target: target as string,
  })),
  {
    action: "review-effect",
    file: "MapViewImpl.web.tsx",
    hook: "useEffect",
    line: 173,
    name: null,
    rationale:
      "The resolved callback performs guarded imperative map geometry work; resolving its binding does not prove a safer lifecycle replacement.",
    target: "expensify-map-reset-boundaries",
  },
  {
    action: "review-state",
    file: "MapViewImpl.web.tsx",
    hook: "useState",
    line: 79,
    name: "userInteractedWithMap",
    rationale:
      "React effects consume a callback that closes over this flag, so a ref-only rewrite would stop callback-identity invalidation.",
    target: "expensify-map-reset-boundaries",
  },
  {
    action: "review-effect",
    file: "useSearchPageSetup.ts",
    hook: "useEffect",
    line: 58,
    name: null,
    rationale:
      "The function-declaration callback is shared with focus lifecycle and mutates external selection state, so it remains an explicit review boundary.",
    target: "expensify-search-page-setup",
  },
  {
    action: "keep-effect",
    file: "ReportLifecycleHandler.tsx",
    hook: "useEffect",
    line: 68,
    name: null,
    rationale:
      "The uniquely resolved local callback clears an external report integration from React focus dependencies and is also reused by the app-focus event.",
    target: "expensify-report-lifecycle",
  },
  {
    action: "use-ref",
    file: "index.tsx",
    hook: "useState",
    line: 85,
    name: "isRendered",
    rationale:
      "The post-mount latch never renders; only the selection-change event reads it, so a ref removes the mount-effect rerender without changing lifecycle timing.",
    target: "expensify-composer-lifecycle-state",
  },
  {
    action: "review-state",
    file: "MapView.tsx",
    hook: "useState",
    line: 65,
    name: "isIdle",
    rationale:
      "The value re-arms a focused-screen reaction through callback identity; replacing it with a ref alone would stop the focus effect from reacting to an idle transition.",
    target: "expensify-map-lifecycle-state",
  },
  {
    action: "review-state",
    file: "MapView.tsx",
    hook: "useState",
    line: 68,
    name: "userInteractedWithMap",
    rationale:
      "React and focus effects consume a callback that closes over this flag, so a ref-only rewrite would stop callback-identity invalidation.",
    target: "expensify-map-lifecycle-state",
  },
  {
    action: "review-state",
    file: "useStableOptimisticSortedData.ts",
    hook: "useState",
    line: 89,
    name: "cachedItemIndex",
    rationale:
      "The cached index participates in synchronous render-time list reconstruction and is only safe to remove as part of the coupled optimistic-item state model.",
    target: "expensify-stable-optimistic-state",
  },
  ...([13, 14] as const).map((line) => ({
    action: "use-ref" as const,
    file: "useReviewDuplicatesNavigation.tsx",
    hook: "useState" as const,
    line,
    name: line === 13 ? "nextScreen" : "prevScreen",
    rationale:
      "The effect-derived route cursor never renders and is consumed only by returned navigation commands; a ref is valid once the returned callback boundary is proven.",
    target: "expensify-review-duplicates-state",
  })),
  {
    action: "use-ref",
    file: "WorkspaceDuplicateSelectFeaturesForm.tsx",
    hook: "useState",
    line: 48,
    enforced: false,
    name: "duplicatedWorkspaceAvatar",
    rationale:
      "The asynchronously loaded file never renders and is consumed only by the eventual confirm command; conversion requires proving the memoized confirmation callback chain.",
    // Rendered calls or mutable reads still need an independent-refresh proof.
    target: "expensify-workspace-duplicate-features-state",
  },
  {
    action: "review-state",
    file: "WorkspaceNewRoomPage.tsx",
    hook: "useState",
    line: 93,
    name: "shouldEnableValidation",
    rationale:
      "Source resolution proves the form invokes validation from a child effect as well as commands; a ref could replace the effect's render-captured latch snapshot with a newer mutable value.",
    target: "expensify-workspace-new-room-state",
  },
  {
    action: "review-state",
    file: "useFilesValidation.tsx",
    hook: "useState",
    line: 46,
    name: "isValidatingFiles",
    rationale:
      "The returned validation command reads this reentrancy guard before writing it; a ref would expose the first synchronous call's write to a second call before React commits a new render snapshot.",
    target: "expensify-files-validation-state",
  },
  {
    action: "review-state",
    file: "base.ts",
    hook: "useState",
    line: 198,
    name: "maxResults",
    rationale:
      "The pagination cursor is consumed throughout an immediately invoked render-time option builder, so updates must invalidate the hook owner.",
    target: "expensify-search-selector-render-state",
  },
  {
    action: "use-observable",
    file: "BaseSelectionList.tsx",
    hook: "useState",
    line: 121,
    name: "itemsToHighlight",
    rationale:
      "Highlight membership renders inside the list's renderItem callback; an owner-lifetime observable with per-row membership subscribers can avoid rebuilding the full selection list, but this requires an explicit rendered-callback boundary proof.",
    target: "expensify-base-selection-list",
  },
  {
    action: "review-state",
    file: "useAttachmentErrors.ts",
    hook: "useState",
    line: 27,
    name: "attachmentErrors",
    rationale:
      "The hook publishes a state-reading getter to render consumers; React state is the notification mechanism that refreshes that getter.",
    target: "expensify-attachment-errors",
  },
  {
    action: "review-state",
    file: "AttachmentStateContextProvider.tsx",
    hook: "useState",
    line: 35,
    name: "attachmentLoaded",
    rationale:
      "A Context value publishes a getter over this state, so replacing it with a ref would stop Provider updates from reaching render consumers.",
    target: "expensify-attachment-state-provider",
  },
  {
    action: "review-state",
    file: "index.tsx",
    hook: "useState",
    line: 117,
    name: "reportRHPWidthHints",
    rationale:
      "A Context action getter exposes this state to downstream lifecycle consumers; local ref conversion cannot preserve publication semantics.",
    target: "expensify-wide-rhp",
  },
  ...([114, 117] as const).map((line) => ({
    action: "review-state" as const,
    file: "PopoverReportActionContextMenu.tsx",
    hook: "useState" as const,
    line,
    name: line === 114 ? "composerToRefocusOnClose" : "isContextMenuOpening",
    rationale:
      "useImperativeHandle exposes a raw state snapshot; a ref-only conversion would leave that public snapshot stale unless the API also changes.",
    target: "expensify-context-menu",
  })),
  {
    action: "use-ref",
    file: "index.tsx",
    hook: "useState",
    line: 31,
    name: "statusBarStyle",
    rationale:
      "The style is a previous-command snapshot inside one effect-owned memoized callback; a ref preserves the comparison while removing only the state-driven callback refresh and listener churn.",
    target: "expensify-custom-status-bar",
  },
  ...([47, 48, 49, 50, 51] as const).map((line) => ({
    action: "use-ref" as const,
    file: "index.tsx",
    hook: "useState" as const,
    line,
    name: ["isMouseDown", "initialScrollLeft", "initialScrollTop", "initialX", "initialY"][
      line - 47
    ]!,
    rationale:
      "This pointer snapshot can become latest-value ref storage only with a stable-listener rewrite that preserves current effect registration cadence.",
    target: "expensify-image-view",
  })),
  ...[
    ["expensify-iou-description", "IOURequestStepDescription.tsx", 92, "currentDescription"],
    ["expensify-iou-merchant", "IOURequestStepMerchant.tsx", 77, "currentMerchant"],
  ].map(([target, file, line, name]) => ({
    action: "use-ref" as const,
    enforced: name !== "currentDescription",
    file: file as string,
    hook: "useState" as const,
    line: line as number,
    name: name as string,
    rationale:
      "The command snapshot never renders, and source resolution proves its custom-hook getter is refreshed through a ref and invoked only from effect-registered navigation commands.",
    target: target as string,
  })),
  {
    action: "keep-effect",
    file: "useSearchPageSetup.ts",
    hook: "useEffect",
    line: 62,
    name: null,
    rationale:
      "The search trigger reads the hook argument, context and Onyx hook results, and a module-level cache; it is scheduled by props and external values with no local React state involved.",
    target: "expensify-search-page-setup",
  },
  {
    action: "keep-effect",
    file: "index.tsx",
    hook: "useEffect",
    line: 273,
    name: null,
    rationale:
      "The full-size toggle prop alone schedules the scroll restoration; the previous scroll and height states are read as snapshots that would become `.peek()` reads, so the React effect stays in place.",
    target: "expensify-composer-lifecycle-state",
  },
  {
    action: "keep-state",
    file: "index.tsx",
    hook: "useState",
    line: 64,
    name: "hasNavigatedAway",
    rationale:
      "Navigation listeners write the flag from effects and it renders only this two-element owner's fallback branch and remount key, so observable ownership could not narrow the render.",
    target: "expensify-lottie",
  },
  {
    action: "keep-effect",
    file: "SearchAutocompleteList.tsx",
    hook: "useEffect",
    line: 322,
    name: null,
    rationale:
      "The focus reset reaches only the `isInitialRender` flag, which is kept as React state in this owner, so no Legend effect action applies.",
    target: "expensify-search-autocomplete",
  },
  {
    action: "keep-effect",
    file: "index.tsx",
    hook: "useEffect",
    line: 181,
    name: null,
    rationale:
      "The theme effect reaches `statusBarStyle` only through the memoized status-bar command; that state migrates to a ref, so the effect stays and the command's writes follow the ref finding.",
    target: "expensify-custom-status-bar",
  },
  {
    action: "use-observable",
    file: "ReportCardLostPage.tsx",
    hook: "useState",
    line: 72,
    name: "shouldShowAddressError",
    rationale:
      "The address error flag is written with literals from submit commands and transported once to FormAlertWithSubmitButton, which forwards `isAlertVisible` to FormAlertWrapper where it only gates alert JSX; a leaf subscriber removes the page render.",
    target: "expensify-report-card-lost",
  },
  {
    action: "use-observable",
    file: "ReportCardLostPage.tsx",
    hook: "useState",
    line: 73,
    name: "shouldShowReasonError",
    rationale:
      "The reason error flag follows the same forwarded `isAlertVisible` contract through FormAlertWithSubmitButton into FormAlertWrapper's alert gate, so the broad page keeps the observable and the call site subscribes.",
    target: "expensify-report-card-lost",
  },
  {
    action: "use-observable",
    file: "ShareBankAccount.tsx",
    hook: "useState",
    line: 57,
    name: "isAlertVisible",
    rationale:
      "The alert flag is written with literals from validation and submit commands and transported once to FormAlertWithSubmitButton, whose forwarded `isAlertVisible` only gates alert JSX inside FormAlertWrapper; a stable leaf subscriber removes the page render.",
    target: "expensify-share-bank-account",
  },
  {
    action: "use-observable",
    file: "Button.tsx",
    hook: "useState",
    line: 59,
    name: "isHovered",
    rationale:
      "The hover flag exists only to be published through `ButtonContext`; the button never reads it itself, and the two primitives that read it (`ButtonText`, `ButtonIcon`) bind it by name through `useButtonContext`. An observable in the context value keeps the value object stable, so hovering re-renders only the primitives that render hover styling instead of the whole button.",
    target: "expensify-button-composed",
  },
] as const satisfies readonly GoldHookCase[];
