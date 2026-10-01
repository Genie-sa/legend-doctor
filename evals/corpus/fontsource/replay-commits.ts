import type { ReplayCommit } from "../contracts.js";

const effect = "useEffect(() => {";
const observerGetToUseValue =
  "An observer render read of the same path becomes useValue of that path, so the subscription keeps its granularity and no render is removed.";
const listenerInRender =
  "An onChange listener registered in the render body, a new one on every render and never removed, is deleted in favour of derived state or a computed child; a leak fix with no hook-level action.";
const mountWriteMovedToInitializer =
  "The mount-time write of the font's default language preview moves into the route's useObservable initializer in another file, so deleting it alone would render the latin preview, and the server render and first commit change. The route also gains an effect to reset the preview on client navigation.";

const fontsourceLegendStateV3 = {
  cases: [
    {
      expected: "excluded",
      file: "components/preview/Buttons.tsx",
      line: 81,
      rationale: observerGetToUseValue,
      source: "state$.preview.lineHeight.get()",
    },
    {
      expected: "excluded",
      file: "components/preview/Buttons.tsx",
      line: 82,
      rationale: observerGetToUseValue,
      source: "state$.preview.letterSpacing.get()",
    },
    {
      expected: "excluded",
      file: "components/preview/Buttons.tsx",
      line: 83,
      rationale: observerGetToUseValue,
      source: "state$.preview.color.get()",
    },
    {
      expected: "excluded",
      file: "components/preview/Buttons.tsx",
      line: 84,
      rationale: observerGetToUseValue,
      source: "state$.preview.transparency.get()",
    },
    {
      action: "delete-effect",
      expected: "non-enforced",
      file: "components/preview/Language.tsx",
      line: 19,
      rationale: mountWriteMovedToInitializer,
      source: "useMountOnce(() => {",
    },
    {
      expected: "excluded",
      file: "components/preview/Language.tsx",
      line: 25,
      rationale: observerGetToUseValue,
      source: "state$.preview.language.get()",
    },
    {
      expected: "excluded",
      file: "components/preview/SizeSlider.tsx",
      line: 20,
      rationale:
        "The read runs in a click handler, outside render tracking, so switching it to peek() inside a batch changes no subscription.",
      source: "state$.variable.ital.get()",
    },
    {
      expected: "excluded",
      file: "components/preview/SizeSlider.tsx",
      line: 30,
      rationale: observerGetToUseValue,
      source: "state$.preview.size.get()",
    },
    {
      expected: "excluded",
      file: "components/preview/SizeSlider.tsx",
      line: 37,
      rationale: observerGetToUseValue,
      source: "state$.preview.size.get()",
    },
    {
      expected: "excluded",
      file: "components/preview/SizeSlider.tsx",
      line: 65,
      rationale: observerGetToUseValue,
      source: "state$.preview.italic.get()",
    },
    {
      expected: "excluded",
      file: "components/preview/TextArea.tsx",
      line: 63,
      rationale: observerGetToUseValue,
      source: "state$.preview.get()",
    },
    {
      expected: "excluded",
      file: "components/preview/TextArea.tsx",
      line: 64,
      rationale: observerGetToUseValue,
      source: "state$.fontVariation.get()",
    },
    {
      expected: "excluded",
      file: "components/preview/TextArea.tsx",
      line: 68,
      rationale:
        "The color-scheme effect moves from every TextBox into their TextArea parent, so it runs once instead of once per weight; hoisting an effect into a parent has no hook-level action.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/preview/TextArea.tsx",
      line: 122,
      rationale: observerGetToUseValue,
      source: "state$.preview.italic.get()",
    },
    {
      action: "delete-effect",
      expected: "non-enforced",
      file: "components/preview/TextArea.tsx",
      line: 128,
      rationale: mountWriteMovedToInitializer,
      source: effect,
    },
    {
      action: "narrow-use-value-subscription",
      expected: "enforced",
      file: "components/preview/VariableButtons.tsx",
      line: 62,
      rationale:
        "Each axis slider read the whole variable object to render only variable[tag], so dragging one axis re-rendered every slider. The writers assign one key or set the whole object, and the observer-memoized sliders receive only stable props, so subscribing to variable[tag] keeps every read and renders only the dragged axis.",
      source: "state$.variable.get()[tag]",
    },
    {
      expected: "excluded",
      file: "components/search/Hits.tsx",
      line: 70,
      rationale: observerGetToUseValue,
      source: "state$.display.get()",
    },
    {
      expected: "excluded",
      file: "components/search/Hits.tsx",
      line: 71,
      rationale: observerGetToUseValue,
      source: "state$.size.get()",
    },
    {
      expected: "excluded",
      file: "components/search/Hits.tsx",
      line: 80,
      rationale:
        "The per-row computed becomes a useValue selector over the renamed customValue and presetValue fields; the row still renders on the same preview changes.",
      source: "useComputed(() => {",
    },
    {
      expected: "excluded",
      file: "components/search/Hits.tsx",
      line: 193,
      rationale:
        "The read follows the preview fields' rename to customValue and presetValue, a state restructure that removes no render.",
      source: "state$.preview.value.get()",
    },
    {
      expected: "excluded",
      file: "components/search/Hits.tsx",
      line: 302,
      rationale:
        "The language listener now always updates the preset preview, even while custom text is shown, a behavior change.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/search/PreviewTextInput.tsx",
      line: 39,
      rationale:
        "ItemButton reads no observable in render, so dropping its observer wrapper removes no subscription.",
      source: "const ItemButton = observer(",
    },
    {
      expected: "excluded",
      file: "components/search/PreviewTextInput.tsx",
      line: 55,
      rationale:
        "The label is now derived from presetLabel and customValue instead of a label field a listener rewrote, a state restructure; the selector already rendered on every customValue change through the input.",
      source: "state$.preview.label.get()",
    },
    {
      expected: "excluded",
      file: "components/search/PreviewTextInput.tsx",
      line: 113,
      rationale: observerGetToUseValue,
      source: "state$.preview.inputView.get()",
    },
    {
      expected: "excluded",
      file: "components/search/SizeSlider.tsx",
      line: 12,
      rationale: observerGetToUseValue,
      source: "state$.size.get()",
    },
    {
      expected: "excluded",
      file: "components/search/Sort.tsx",
      line: 37,
      rationale: observerGetToUseValue,
      source: "state$.display.get()",
    },
    {
      expected: "excluded",
      file: "components/tools/FontConverter.tsx",
      line: 28,
      rationale: observerGetToUseValue,
      source: "state$.files.get()",
    },
    {
      expected: "excluded",
      file: "components/tools/FontConverter.tsx",
      line: 29,
      rationale: observerGetToUseValue,
      source: "state$.results.get()",
    },
    {
      expected: "excluded",
      file: "components/tools/FontConverter.tsx",
      line: 30,
      rationale: observerGetToUseValue,
      source: "state$.isConverting.get()",
    },
    {
      expected: "excluded",
      file: "components/tools/FontConverter.tsx",
      line: 31,
      rationale: observerGetToUseValue,
      source: "state$.isCreatingZip.get()",
    },
    {
      expected: "excluded",
      file: "components/tools/FontConverter.tsx",
      line: 32,
      rationale: observerGetToUseValue,
      source: "state$.formats.get()",
    },
    {
      action: "move-use-value-into-child",
      equivalents: ["move-use-value-down"],
      expected: "enforced",
      file: "components/tools/FontConverter.tsx",
      line: 33,
      rationale:
        "progress is rendered only by passing it to ProgressIndicator, its single call site, and useFontConverter writes it alone after each file's conversion settles, per ZIP entry, and in a delayed reset. Each write re-rendered the whole uncompiled observer form with its file list and results table; subscribing inside ProgressIndicator keeps isVisible as a prop and renders only the bar.",
      source: "state$.progress.get()",
    },
    {
      expected: "excluded",
      file: "components/tools/FontConverter.tsx",
      line: 34,
      rationale: observerGetToUseValue,
      source: "state$.downloadError.get()",
    },
    {
      expected: "excluded",
      file: "routes/_index.tsx",
      line: 205,
      rationale:
        "The inline initial state moves into a shared createSearchState factory with renamed preview fields; the owner keeps the same lifetime and subscriptions.",
      source: "useObservable<SearchObject>({",
    },
    {
      expected: "excluded",
      file: "routes/_index.tsx",
      line: 218,
      rationale: listenerInRender,
      source: "state$.preview.inputView.onChange(",
    },
    {
      expected: "excluded",
      file: "routes/fonts.$id._index.tsx",
      line: 130,
      rationale:
        "The initializer now computes the font's default language and preview text and turns fontVariation into a computed child; it is the companion of the deleted mount writes, which are labeled where they were.",
      source: "useObservable<FontIDObject>({",
    },
    {
      expected: "excluded",
      file: "routes/fonts.$id._index.tsx",
      line: 147,
      rationale: listenerInRender,
      source: "state$.preview.language.onChange(",
    },
    {
      expected: "excluded",
      file: "routes/fonts.$id._index.tsx",
      line: 153,
      rationale: listenerInRender,
      source: "state$.preview.color.onChange(",
    },
    {
      expected: "excluded",
      file: "routes/fonts.$id._index.tsx",
      line: 158,
      rationale: listenerInRender,
      source: "state$.variable.onChange(",
    },
  ],
  commit: "342fac0f8c453bb0426dcb85255d042ff14714b7",
  parent: "7c92e11b48a07c3eb860b2eddcef7d4369a9b529",
  repository: "fontsource",
  root: "website/app",
} as const satisfies ReplayCommit;

/** The fontsource maintainer's Legend State v3 migration, classified against each parent tree. */
export const fontsourceReplayCommits: readonly ReplayCommit[] = [fontsourceLegendStateV3];
