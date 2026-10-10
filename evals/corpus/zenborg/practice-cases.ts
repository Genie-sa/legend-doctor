import type { GoldPracticeCase } from "../contracts.js";

const LEGACY_ALIAS =
  "The pinned lockfile resolves @legendapp/state 3.0.0-beta.35, which exports `use$`, `useSelector` and `useValue` as the same function, so renaming the call to `useValue` changes no subscription.";

const DIRECT_OBSERVABLE =
  "The selector returns one static `.get()` of a module observable, so passing the observable subscribes to the same path through the same useSelector code path.";

const HAND_FIXED =
  "The author hand-fixed the same stale memo in components/banded-heatmap/CycleDeckHeatmap.tsx:30-37.";

const legacyUseValueLines = [
  ["app/plant/page.tsx", [49, 50, 51]],
  ["components/AreaBoardBuilder.tsx", [35, 36, 37]],
  ["components/AreaSelector.tsx", [82]],
  ["components/banded-heatmap/BandedHeatmap.tsx", [155]],
  ["components/banded-heatmap/BandedHeatmapCycleBlock.tsx", [41]],
  ["components/CommandPalette.tsx", [52]],
  ["components/CultivateZoomToggle.tsx", [16]],
  ["components/DayHeaderTitle.tsx", [35, 36]],
  ["components/DayNoteBody.tsx", [31]],
  ["components/gap/TimerOverlay.tsx", [18]],
  ["components/GroupedHabitView.tsx", [508, 509, 510]],
  ["components/HabitAutocompleteInline.tsx", [54, 55]],
  ["components/HabitFormDialog.tsx", [78, 110, 111, 858]],
  ["components/LayoutClient.tsx", [54, 55, 56]],
  ["components/MentionAutocompleteInline.tsx", [52, 53, 54]],
  ["components/MentionBadges.tsx", [24, 25]],
  ["components/MentionSummary.tsx", [21, 22]],
  ["components/MomentCard.tsx", [60]],
  ["components/MomentFormDialog.tsx", [90, 111, 113, 383, 388]],
  ["components/PeopleBoardBuilder.tsx", [439, 440, 441]],
  ["components/PersonFormDialog.tsx", [61, 73]],
  ["components/PhaseSelector.tsx", [46]],
  ["components/PlaceFormDialog.tsx", [50, 55]],
  ["components/PlacesMapView.tsx", [51, 52]],
  ["components/PlacesTreeView.tsx", [150, 151]],
  ["components/PlanHabitsList.tsx", [143]],
  ["components/PlantToolbar.tsx", [91]],
  ["components/RelationshipTagger.tsx", [29, 30, 31, 32, 33, 187, 188, 189, 190]],
  ["components/TagAutocompleteInline.tsx", [60, 61]],
  ["components/TaggedNameInput.tsx", [67]],
  ["components/Timeline.tsx", [135, 136, 138, 139]],
  ["components/TimelineCell.tsx", [78, 79, 231, 232]],
  ["components/VaultStatusSection.tsx", [95]],
  ["hooks/useAreaHasWilting.ts", [17, 18, 19, 20]],
  ["hooks/useCommandPaletteSearch.ts", [51, 52, 53, 54]],
  ["hooks/useEntityActions.ts", [54, 55, 56]],
  ["hooks/useFocusManager.ts", [16, 17]],
  ["hooks/useGlobalKeyboard.ts", [37]],
  ["hooks/useHabitHealth.ts", [29, 30, 31, 32]],
  ["hooks/useHistory.ts", [43, 44, 45]],
  ["hooks/useSelection.ts", [24, 27]],
] as const;

const directObservableLines = [
  ["components/banded-heatmap/CycleDeckHeatmap.tsx", [23, 24, 25, 26]],
  ["components/CycleCalendarDialog.tsx", [39]],
  ["components/CycleDeck.tsx", [64, 68, 69, 70, 71, 72]],
  ["components/CycleStrip.tsx", [29, 30]],
] as const;

export const zenborgPracticeCases = [
  {
    action: "snapshot-mutated-use-value",
    disposition: "change",
    file: "app/harvest/page.tsx",
    line: 42,
    rationale: `\`cycles$[id].set\` in application/services/CycleService.ts:211 and :286 replaces one child and keeps the record reference, so the \`cycleList\` memo at :50 stays stale and an edited cycle does not reach the harvest view. ${HAND_FIXED}`,
    target: "zenborg",
  },
  {
    action: "snapshot-mutated-use-value",
    disposition: "change",
    file: "app/harvest/page.tsx",
    line: 43,
    rationale: `Moment allocation and removal write children in place (application/services/CycleService.ts:499, :520; hooks/useGlobalKeyboard.ts:185), keeping the \`moments$\` record reference, so the \`momentList\` memo at :51 and the season derived from it stay stale. ${HAND_FIXED}`,
    target: "zenborg",
  },
  {
    action: "snapshot-mutated-use-value",
    disposition: "change",
    file: "app/harvest/page.tsx",
    line: 44,
    rationale: `Area creation and updates write \`areas$[id]\` in place (application/services/AreaService.ts:19, :42), keeping the record reference, so the \`areaList\` memo at :52 stays stale. ${HAND_FIXED}`,
    target: "zenborg",
  },
  {
    action: "snapshot-mutated-use-value",
    disposition: "change",
    file: "app/harvest/page.tsx",
    line: 45,
    rationale:
      "Phase edits, visibility toggles and slider drags write `phaseConfigs$[id]` in place (components/SettingsModal.tsx:95, :105, :267), keeping the record reference, so the `phaseConfigList` memo at :53 stays stale.",
    target: "zenborg",
  },
  {
    action: "snapshot-mutated-use-value",
    disposition: "change",
    file: "components/PhaseSelector.tsx",
    line: 46,
    rationale:
      "Visibility toggles and label edits write `phaseConfigs$[id]` in place (components/SettingsModal.tsx:95, :105), keeping the record reference, so the visible-phase list memoized at :47 keeps hidden or renamed phases.",
    target: "zenborg",
  },
  {
    action: "snapshot-mutated-use-value",
    disposition: "change",
    file: "components/PlacesMapView.tsx",
    line: 51,
    rationale:
      "Place edits, creation and deletion write `places$[id]` in place (app/plant/page.tsx:215, :228, :235), keeping the record reference, so the `allPlaces` memo at :60 and the map derived from it stay stale.",
    target: "zenborg",
  },
  {
    action: "snapshot-mutated-use-value",
    disposition: "change",
    file: "components/PlacesTreeView.tsx",
    line: 150,
    rationale:
      "Place edits, creation and deletion write `places$[id]` in place (app/plant/page.tsx:215, :228, :235), keeping the record reference, so the `allPlaces` memo at :153 and the tree built from it stay stale.",
    target: "zenborg",
  },
  {
    action: "snapshot-mutated-use-value",
    disposition: "change",
    file: "components/RelationshipTagger.tsx",
    line: 29,
    rationale:
      "Tagging writes `relationships$[id]` in place (:56, :64, :245; components/PeopleBoardBuilder.tsx:386, :396), keeping the record reference, so the `entityRels` and `existingLabels` memos at :39 and :47 miss the tag just added or removed.",
    target: "zenborg",
  },
  {
    action: "snapshot-mutated-use-value",
    disposition: "change",
    file: "components/TaggedNameInput.tsx",
    line: 67,
    rationale:
      "Place edits, creation and deletion write `places$[id]` in place (app/plant/page.tsx:215, :228, :235), keeping the record reference, so the `placeKeys` memo at :69 misses new or renamed place keys.",
    target: "zenborg",
  },
  {
    action: "move-use-value-into-child",
    disposition: "change",
    file: "components/LayoutClient.tsx",
    line: 56,
    rationale:
      "Only CommandPalette's `open` prop reads the palette flag, and no other LayoutClient subscription tracks it, so each Cmd+K open and close rerenders the top bar, TodayButton, ModeSelector, HamburgerMenuButton, UpdateNotification and SettingsModal today; subscribing inside the existing CommandPalette child keeps its render and lifetime.",
    target: "zenborg",
  },
  {
    action: "toggle-observable",
    disposition: "style",
    file: "commands/view-commands.ts",
    line: 30,
    rationale:
      "The command palette action flips `cycleDeckCollapsed$` from its own peek; `toggle()` performs the same single write.",
    target: "zenborg",
  },
  {
    action: "toggle-observable",
    disposition: "style",
    file: "commands/view-commands.ts",
    line: 91,
    rationale:
      "The Open Settings action flips `isSettingsOpen$` from its own peek; `toggle()` performs the same single write.",
    target: "zenborg",
  },
  {
    action: "toggle-observable",
    disposition: "style",
    file: "components/CycleDeck.tsx",
    line: 76,
    rationale:
      "The collapse handler flips `cycleDeckCollapsed$` from its own peek; `toggle()` performs the same single write.",
    target: "zenborg",
  },
  {
    action: "peek-unrendered-use-value",
    disposition: "change",
    file: "components/MomentCard.tsx",
    line: 60,
    rationale:
      "`allPhaseConfigs` feeds only the initializer of `_phaseConfig`, which nothing reads, so every `phaseConfigs$` write rerenders each card for nothing. No component that renders the card (TimelineCell, MomentStack, the DnDProvider overlay, or their cultivate-page ancestors) subscribes to `phaseConfigs$`, and the store seeds it with plain data under an eager syncObservable. The maintainer deleted this subscription in 4b383b6.",
    target: "zenborg",
  },
  {
    action: "use-peek-for-snapshot",
    disposition: "style",
    file: "components/DnDProvider.tsx",
    line: 210,
    rationale:
      "`handleDragEnd` reads the selection once at drop time; the dnd-kit callback is no tracking context, so `.get()` and `.peek()` return the same snapshot.",
    target: "zenborg",
  },
  ...directObservableLines.flatMap(([file, lines]) =>
    lines.map((line) => ({
      action: "pass-observable-to-use-value" as const,
      disposition: "style" as const,
      file,
      line,
      rationale: DIRECT_OBSERVABLE,
      target: "zenborg",
    })),
  ),
  ...legacyUseValueLines.flatMap(([file, lines]) =>
    lines.map((line) => ({
      action: "replace-legacy-use-value" as const,
      disposition: "style" as const,
      file,
      line,
      rationale: LEGACY_ALIAS,
      target: "zenborg",
    })),
  ),
] as const satisfies readonly GoldPracticeCase[];
