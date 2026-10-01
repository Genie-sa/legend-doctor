import type { GoldHookCase } from "../contracts.js";

const CYCLE_DRAFT =
  "Each keystroke in the inline cycle name and date inputs (CycleDeck.tsx:239-261) rerenders the whole `CycleDeck` owner, which rebuilds the virtual deck cards from every plan, habit, area and moment without memoization (:153-175). The draft cluster is read only by those inputs and the save commands (:203-211), so leaf subscribers keep typing out of the deck while the sync effect at :128-136 assigns the draft in one place.";

const DEAD_PLAN_AREA_CARD =
  "No module imports `PlanAreaCard` (only comments in EmptyAreaCard.tsx:32 and :188 name it), so the state never renders and converting it removes no cost.";

const ALIAS_DRAFT_LEAF =
  "`AliasesSelector` is already the leaf: besides the input it renders only the Popover shell, a static header and the alias chips, and `commitDraft` reads `draft` from the Popover close handler, so the keystroke render it would remove is a handful of host elements.";

export const zenborgHookCases = [
  {
    action: "delete-unused-state",
    file: "app/StoreInitializer.tsx",
    hook: "useState",
    line: 15,
    name: "_isInitialized",
    rationale:
      "`_isInitialized` is never read; its only write after `initializeStore` resolves (:20) rerenders a component that returns null, so deleting the state removes that render.",
    target: "zenborg",
  },
  {
    action: "use-observable",
    file: "components/AreaColumnHeader.tsx",
    hook: "useState",
    line: 45,
    name: "emojiPickerOpen",
    rationale:
      "`emojiPickerOpen` is read only by the emoji `Popover` at :93; opening and dismissing it rerenders the whole header, including the name editor, the add button and the settings `DropdownMenu` with its `ColorPicker` (:158-188). A leaf around the Popover keeps them out.",
    target: "zenborg",
  },
  {
    action: "review-state",
    enforced: false,
    file: "components/AreaColumnSubtoolbar.tsx",
    hook: "useState",
    line: 27,
    name: "attitudeSelectorOpen",
    rationale:
      "Known false positive (leaf is the owner): the analyzer emits `use-observable` with a leaf around `AttitudeSelector` (:51-63), but the rest of the owner is one wrapper div, `TagBadges` (:67) and two expand buttons (:70-88), so the open and close renders it removes are negligible.",
    target: "zenborg",
  },
  {
    action: "review-state",
    enforced: false,
    file: "components/CircularPhaseSlider.tsx",
    hook: "useState",
    line: 68,
    name: "draggingPointer",
    rationale:
      "Known false positive (owner renders anyway): the analyzer emits `use-observable` with a per-row selector, but `draggingPointer` changes only on pointer down and up (:268, :273), while every pointermove in between calls `onUpdatePhase` (:238-252), which writes `phaseConfigs$` at SettingsModal.tsx:267 and rerenders the slider through its `phaseConfigs` prop. The pointer rows are keyed by hour (:478), so they remount on every move as well.",
    target: "zenborg",
  },
  {
    action: "use-observable",
    file: "components/CycleDeck.tsx",
    hook: "useState",
    line: 93,
    name: "createDialogOpen",
    rationale:
      "`createDialogOpen` is read only as the `open` prop of the four `CycleCalendarDialog` call sites (:194, :467, :499, :541), one per return branch and each a direct child of that branch's root `<div>`; it is written only by the plan-cycle buttons (:187, :371) and each dialog's `onClose`. Opening or closing the dialog rerenders the whole deck, which rebuilds the virtual deck cards without memoization (:153-175), so a leaf around each call site keeps them out.",
    target: "zenborg",
  },
  {
    action: "use-observable",
    file: "components/CycleDeck.tsx",
    hook: "useState",
    line: 117,
    name: "editName",
    rationale: CYCLE_DRAFT,
    target: "zenborg",
  },
  {
    action: "use-observable",
    file: "components/CycleDeck.tsx",
    hook: "useState",
    line: 118,
    name: "editStartDate",
    rationale: CYCLE_DRAFT,
    target: "zenborg",
  },
  {
    action: "use-observable",
    file: "components/CycleDeck.tsx",
    hook: "useState",
    line: 121,
    name: "editEndDate",
    rationale: CYCLE_DRAFT,
    target: "zenborg",
  },
  {
    action: "review-state",
    enforced: false,
    file: "components/HabitFormDialog.tsx",
    hook: "useState",
    line: 744,
    name: "draft",
    rationale: `Known false positive (leaf is the owner): the analyzer emits \`use-observable\` with a leaf around the alias <input> at :816, but ${ALIAS_DRAFT_LEAF} (:766-847, close handler at :772)`,
    target: "zenborg",
  },
  {
    action: "use-observable",
    enforced: false,
    file: "components/OracleSettingsSection.tsx",
    hook: "useState",
    line: 63,
    name: "newOracleName",
    rationale:
      "Every keystroke of the new oracle name (:535) rerenders the 69-element section with every oracle entry and route; the name is read in render only by that input and the add button's `disabled` (:534, :562). The reset at :142 shares `handleAddOracle` with `setData` and `setExpanded`, but that handler runs only from the Enter keydown (:537) and the button click (:561), discrete React events where the observable write and both React writes commit in one render.",
    target: "zenborg",
  },
  {
    action: "use-observable",
    file: "components/OracleSettingsSection.tsx",
    hook: "useState",
    line: 64,
    name: "newOracleType",
    rationale:
      "`newOracleType` is read in render only by the MCP and CLI toggle buttons (:544-557) and otherwise by `handleAddOracle` as a command (:138); each toggle rerenders the 69-element section, and per-row selectors confine the click to the two buttons.",
    target: "zenborg",
  },
  {
    action: "review-state",
    enforced: false,
    file: "components/PlaceFormDialog.tsx",
    hook: "useState",
    line: 474,
    name: "copied",
    rationale:
      "Known false positive (leaf is the owner): the analyzer emits `use-observable` with an always-mounted leaf at the copy <button> (:507), but `UrlField` is already the leaf: the rest is one wrapper div and the URL Popover, whose `TextFieldEditor` content (:498) mounts only while open, so the two renders per copy (:479, :480) cost a trigger button and an icon.",
    target: "zenborg",
  },
  {
    action: "review-state",
    enforced: false,
    file: "components/PlaceFormDialog.tsx",
    hook: "useState",
    line: 622,
    name: "draft",
    rationale: `Known false positive (leaf is the owner): the analyzer emits \`use-observable\` with a leaf around the alias <input> at :682, but ${ALIAS_DRAFT_LEAF} (:638-707, close handler at :642)`,
    target: "zenborg",
  },
  {
    action: "keep-state",
    file: "components/PlanAreaCard.tsx",
    hook: "useState",
    line: 65,
    name: "emojiPickerOpen",
    rationale: DEAD_PLAN_AREA_CARD,
    target: "zenborg",
  },
  {
    action: "keep-state",
    file: "components/PlanAreaCard.tsx",
    hook: "useState",
    line: 66,
    name: "attitudeSelectorOpen",
    rationale: DEAD_PLAN_AREA_CARD,
    target: "zenborg",
  },
  {
    action: "keep-state",
    file: "components/PlanHabitItem.tsx",
    hook: "useState",
    line: 35,
    name: "name",
    rationale:
      "No module imports `PlanHabitItem`, so the name draft read by the <input> at line 63 never renders and converting it removes no cost.",
    target: "zenborg",
  },
  {
    action: "use-observable",
    file: "components/SettingsModal.tsx",
    hook: "useState",
    line: 72,
    name: "importMessage",
    rationale:
      "`importMessage` is written by export, import and reset (:154-210, plus a 3 s clear timer) and read only in the data pane (:417-428); each write rerenders the whole 98-element observer modal. A leaf over the data subtree at :370 keeps the dialog shell and navigation out, and every co-writer in the import and reset continuations is a member of the same observable.",
    target: "zenborg",
  },
  {
    action: "use-observable",
    file: "components/SettingsModal.tsx",
    hook: "useState",
    line: 76,
    name: "isImporting",
    rationale:
      "`isImporting` flips around the awaited import (:173, :193) and is read only by the import buttons and the spinner in the data pane (:390, :405, :430); both flips rerender the whole 98-element modal, and the other write in the same continuation is `importMessage`, which moves into the same observable.",
    target: "zenborg",
  },
  {
    action: "use-observable",
    file: "components/SettingsModal.tsx",
    hook: "useState",
    line: 77,
    name: "isResetting",
    rationale:
      "`isResetting` is set before the awaited reset (:201) and cleared with `importMessage` on failure (:207-208); it is read only inside the reset subtree at :434 (:442, :454), so a leaf there keeps the rest of the modal out of both writes.",
    target: "zenborg",
  },
  {
    action: "use-observable",
    file: "components/SettingsModal.tsx",
    hook: "useState",
    line: 78,
    name: "showResetConfirm",
    rationale:
      "`showResetConfirm` is written only by the reset and cancel clicks (:441, :467) and read only by the reset subtree at :434 (:438); each toggle rerenders the whole 98-element modal.",
    target: "zenborg",
  },
  {
    action: "review-state",
    enforced: false,
    file: "components/SettingsModal.tsx",
    hook: "useState",
    line: 131,
    name: "hasChecked",
    rationale:
      "Known false positive (atomic split after await): the analyzer emits `use-observable`, but `setHasChecked(true)` (:136) runs in the continuation of `checkForUpdate`, whose `setState` clearing `checking` and replacing `update` (hooks/useUpdater.ts:35-39) is still pending in the default lane. The observable commits first in the sync lane, so on a repeat check the stale `update` block (:561) shows beside the `Checking...` button (:556) until the React write commits.",
    target: "zenborg",
  },
  {
    action: "keep-state",
    file: "components/banded-heatmap/BandedHeatmap.tsx",
    hook: "useState",
    line: 200,
    name: "popupAnchorEl",
    rationale:
      "`setPopupAnchorEl` is the callback ref of the create-cycle anchor `<div>` (:570), so the state holds a DOM node React has attached. An observable `set` walks that node's `__reactFiber$` key into the cyclic fiber graph and overflows the stack, so the anchor must stay React state.",
    target: "zenborg",
  },
] as const satisfies readonly GoldHookCase[];
