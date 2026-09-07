import type { GoldHookCase } from "../contracts.js";

export const excalidrawHookCases = [
  {
    action: "use-observable",
    file: "useHandleAppTheme.ts",
    hook: "useState",
    line: 20,
    name: "editorTheme",
    rationale:
      "The hook never reads its effect-written editor theme; its sole broad consumer forwards the value to one stable Excalidraw call site, so a hook-lifetime observable preserves effect timing while removing the wrapper render.",
    target: "excalidraw-app-theme",
  },
  {
    action: "keep-effect",
    file: "components/FontPicker/FontPickerList.tsx",
    hook: "useEffect",
    line: 295,
    name: null,
    rationale:
      "The hovered font row scrolls its committed button ref after render; the optional method chain does not escape the ref-owned DOM command.",
    target: "excalidraw",
  },
  {
    action: "keep-effect",
    file: "components/TTDDialog/CodeMirrorEditor.tsx",
    hook: "useEffect",
    line: 218,
    name: null,
    rationale:
      "The effect aliases the committed CodeMirror view, reads its document, and dispatches the external value only after React commits.",
    target: "excalidraw",
  },
  {
    action: "use-observable",
    file: "components/LibraryMenuHeaderContent.tsx",
    hook: "useState",
    line: 89,
    name: "showRemoveLibAlert",
    rationale:
      "One local zero-argument JSX factory owns the complete confirmation leaf; open and close commands can update an owner-lifetime observable without rerendering the independent library menu and selection counter.",
    target: "excalidraw",
  },
  {
    action: "review-state",
    file: "components/LibraryMenuHeaderContent.tsx",
    hook: "useState",
    line: 102,
    name: "showPublishLibraryDialog",
    rationale:
      "The success transition atomically swaps this dialog flag with a sibling payload, so a per-flag observable would split one workflow transaction.",
    target: "excalidraw",
  },
  {
    action: "keep-state",
    file: "components/Avatar.tsx",
    hook: "useState",
    line: 24,
    name: "error",
    rationale:
      "Image-error state already belongs to a two-element avatar leaf, so observable ownership cannot narrow rendering.",
    target: "excalidraw",
  },
  {
    action: "keep-state",
    file: "components/FilledButton.tsx",
    hook: "useState",
    line: 56,
    name: "isLoading",
    rationale:
      "Async click status controls one cohesive leaf button's class, disabled state, and spinner; the button itself must rerender.",
    target: "excalidraw",
  },
  {
    action: "review-state",
    file: "components/ColorPicker/ColorInput.tsx",
    hook: "useState",
    line: 31,
    name: "innerValue",
    rationale:
      "The editable local buffer is synchronized from a non-observable prop and owns validation and input behavior.",
    target: "excalidraw",
  },
  {
    action: "review-state",
    file: "components/ImageExportDialog.tsx",
    hook: "useState",
    line: 80,
    name: "exportSelectionOnly",
    rationale:
      "The value feeds owner-side export preparation as well as a Switch, so a leaf subscription does not remove owner work.",
    target: "excalidraw",
  },
  {
    action: "use-observable",
    file: "components/PublishLibrary.tsx",
    hook: "useState",
    line: 223,
    name: "libraryData",
    rationale:
      "The mount-time storage read is a detached effect write: no effect reads the draft, six host inputs render its fields as reactive props, and the input and submit commands snapshot it, so the broad form stops rendering on every keystroke while the effect keeps its position.",
    target: "excalidraw",
  },
  {
    action: "use-observable",
    file: "components/PublishLibrary.tsx",
    hook: "useState",
    line: 232,
    name: "isSubmitting",
    rationale:
      "A broad form only renders submit status in one action-button leaf while command paths own every write; the resolved DialogActionButton contract is verified as render-only.",
    target: "excalidraw",
  },
  {
    action: "use-observable",
    file: "components/Stats/index.tsx",
    hook: "useState",
    line: 148,
    name: "sceneDimension",
    rationale:
      "Throttled dimensions need owner-lifetime observable storage because Collapsible unmounts its rows while closed; subscribe only in the scene-dimension rows while preserving the owner effect and throttle cleanup.",
    target: "excalidraw",
  },
  {
    action: "use-observable",
    file: "components/UserList.tsx",
    hook: "useState",
    line: 148,
    name: "searchTerm",
    rationale:
      "The source-resolved search input and exact filter share one directly returned repeated producer, so one subscriber can keep the filter single-run while typing skips the owner's collection preprocessing without changing state lifetime.",
    target: "excalidraw",
  },
  ...[
    ["components/ColorPicker/ColorInput.tsx", 37],
    ["components/LibraryMenuItems.tsx", 83],
  ].map(([file, line]) => ({
    action: "review-effect" as const,
    file: file as string,
    hook: "useEffect" as const,
    line: line as number,
    name: null,
    rationale:
      "Mixed external cleanup, focus timing, prop synchronization, or first-render restoration requires lifecycle review.",
    target: "excalidraw",
  })),
  ...[
    ["components/ColorPicker/ColorInput.tsx", 64],
    ["components/ColorPicker/Picker.tsx", 143],
    ["components/LibraryMenuItems.tsx", 255],
  ].map(([file, line]) => ({
    action: "keep-effect" as const,
    file: file as string,
    hook: "useEffect" as const,
    line: line as number,
    name: null,
    rationale:
      "The effect operates on a committed DOM ref for focus or focus restoration; preserve React post-commit ordering.",
    target: "excalidraw",
  })),
  ...[
    ["components/ColorPicker/Picker.tsx", 124],
    ["components/ColorPicker/ColorInput.tsx", 72],
  ].map(([file, line]) => ({
    action: "keep-effect" as const,
    file: file as string,
    hook: "useEffect" as const,
    line: line as number,
    name: null,
    rationale:
      "The effect owns dependency-sensitive external cleanup rather than a mechanical Legend reaction.",
    target: "excalidraw",
  })),
  ...[
    ["components/Tooltip.tsx", 93],
    ["components/TTDDialog/MermaidToExcalidraw.tsx", 128],
    ["components/ConvertElementTypePopup.tsx", 180],
  ].map(([file, line]) => ({
    action: "use-unmount" as const,
    file: file as string,
    hook: "useEffect" as const,
    line: line as number,
    name: null,
    rationale: "The empty-dependency effect contains only module-level unmount cleanup.",
    target: "excalidraw",
  })),
  {
    action: "keep-effect",
    file: "components/ColorPicker/CustomColorList.tsx",
    hook: "useEffect",
    line: 36,
    name: null,
    rationale:
      "Focus follows the committed color button as picker state changes, so React post-commit ordering is required.",
    target: "excalidraw",
  },
  {
    action: "review-state",
    file: "components/PublishLibrary.tsx",
    hook: "useState",
    line: 243,
    name: "clonedLibItems",
    rationale:
      "The editable list controls row cardinality and is captured before and after async preview generation; a generic observable snapshot rewrite could change command timing and must remain a whole-workflow review.",
    target: "excalidraw",
  },
  {
    action: "keep-effect",
    file: "components/PublishLibrary.tsx",
    hook: "useEffect",
    line: 234,
    name: null,
    rationale:
      "The mount-time storage read only writes the publish draft, which migrates to an observable; the effect keeps its position and dependencies and changes only its write target.",
    target: "excalidraw",
  },
  {
    action: "review-effect",
    file: "components/PublishLibrary.tsx",
    hook: "useEffect",
    line: 247,
    name: null,
    rationale:
      "Keep the React synchronization phase; a future paired migration may replace only its React-state sink with an atomic observable draft assignment.",
    target: "excalidraw",
  },
  {
    action: "use-ref",
    enforced: false,
    file: "components/PasteChartDialog.tsx",
    hook: "useState",
    line: 47,
    name: "chartElements",
    rationale:
      "The layout effect produces chart elements for the insert command. The rendered label also comes from getChartTypeLabel and translation calls; a ref migration remains an opportunity until their independent refresh is proven.",
    target: "excalidraw",
  },
  {
    action: "review-state",
    file: "components/ElementLinkDialog.tsx",
    hook: "useState",
    line: 42,
    name: "linkEdited",
    rationale:
      "The flag is captured by a memoized confirmation callback that owns a keyboard-listener effect, so it is not command-only ref state.",
    target: "excalidraw",
  },
  {
    action: "keep-effect",
    file: "components/TTDDialog/CodeMirrorEditor.tsx",
    hook: "useEffect",
    line: 192,
    name: null,
    rationale:
      "The theme swap reads a prop and committed refs only; the owner has no React state that could migrate into this effect.",
    target: "excalidraw",
  },
  {
    action: "keep-state",
    file: "components/LoadingMessage.tsx",
    hook: "useState",
    line: 16,
    name: "isWaiting",
    rationale:
      "The delay timer writes the flag from its effect and the flag gates this four-element owner's own render, so an observable could not remove a render and the timer keeps React lifecycle.",
    target: "excalidraw",
  },
] as const satisfies readonly GoldHookCase[];
