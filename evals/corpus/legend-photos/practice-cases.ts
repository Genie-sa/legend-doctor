import type { GoldPracticeCase } from "../contracts.js";

const LEGACY_USE_VALUE =
  "The pinned lockfile resolves @legendapp/state 3.0.0-beta.30, which predates `useValue`; the supported baseline is the latest v3, where `useValue` is an alias of useSelector, so the rename changes no subscription.";

const legacyUseValueLines = {
  "App.tsx": [27],
  "components/ColorPicker.tsx": [13],
  "components/Img.tsx": [32],
  "features/Filmstrip.tsx": [24, 43, 45],
  "features/FullscreenPhoto.tsx": [91, 92, 95, 96],
  "features/HotkeyHelp.tsx": [23, 24],
  "features/MainSidebar.tsx": [15, 16, 17],
  "features/Photo.tsx": [18],
  "features/PhotosView.tsx": [55, 56, 57, 60, 117, 118, 119],
  "features/PhotosViewContainer.tsx": [25, 28],
  "hooks/useBreakpoints.tsx": [25],
  "legend-kit/react-native/windowDimensions.tsx": [48],
  "plugin-system/PluginRenderer.tsx": [14],
  "plugins/PluginFlagReject.tsx": [37, 92],
  "plugins/PluginFullscreenPhotoInfo.tsx": [15],
  "plugins/PluginRating.tsx": [75],
  "settings/GeneralSettings.tsx": [11, 12],
  "settings/HotkeySettings.tsx": [17, 64, 66],
  "settings/LibrarySettings.tsx": [10],
  "theme/ThemeProvider.tsx": [43],
};

export const legendPhotosPracticeCases = [
  {
    action: "use-peek-for-snapshot",
    file: "features/FullscreenPhoto.tsx",
    line: 112,
    rationale:
      "The image onLoad callback checks the open flag once before starting the open transition; it needs a snapshot, not a dependency.",
    target: "legend-photos",
  },
  {
    action: "use-peek-for-snapshot",
    file: "features/FullscreenPhoto.tsx",
    line: 113,
    rationale:
      "The same onLoad callback reads the selected photo once to seed the opening animation.",
    target: "legend-photos",
  },
  {
    action: "use-peek-for-snapshot",
    file: "legend-kit/react-native/windowDimensions.tsx",
    line: 38,
    rationale:
      "The source-proven HookToObservable contract invokes getValue only from a React layout effect, so the settings check needs a non-tracking snapshot.",
    target: "legend-photos",
  },
  {
    action: "use-value-for-render-read",
    file: "plugins/PluginRating.tsx",
    line: 20,
    rationale:
      "RatingComponent is created without observer and reads photoMetadata$.rating.get() in render, so it never subscribes. Today PluginRenderer rerenders it only because shouldRender calls use$ inside a filter callback, a conditional hook; subscribing in the component keeps the same value and output. The pinned Legend State beta exports no useValue, so the instruction names the use$ the file already imports.",
    target: "legend-photos",
  },
  {
    action: "use-peek-for-snapshot",
    file: "settings/HotkeySettings.tsx",
    line: 103,
    rationale: "The press handler checks the editing flag once before entering edit mode.",
    target: "legend-photos",
  },
  {
    action: "batch-observable-writes",
    enforced: "known-miss",
    file: "settings/HotkeySettings.tsx",
    line: 104,
    rationale:
      "Known miss (non-React observer): the useObserveEffect at line 110 reads isEditing$ and accumulatedKeys$, so a separate write runs it with edit mode on and the previous keys still accumulated, which can save stale keys.",
    target: "legend-photos",
  },
  {
    action: "use-peek-for-snapshot",
    file: "settings/LibrarySettings.tsx",
    line: 17,
    rationale:
      "The async remove handler reads the current paths once to locate the index to splice.",
    target: "legend-photos",
  },
  {
    action: "reuse-observable-reference",
    file: "theme/ThemeProvider.tsx",
    line: 75,
    rationale:
      "useObservable of an existing global observable only wraps it; the provider can use themeState$ directly.",
    target: "legend-photos",
  },
  ...Object.entries(legacyUseValueLines).flatMap(([file, lines]) =>
    lines.map((line) => ({
      action: "replace-legacy-use-value" as const,
      disposition: "style" as const,
      file,
      line,
      rationale: LEGACY_USE_VALUE,
      target: "legend-photos",
    })),
  ),
] as const satisfies readonly GoldPracticeCase[];
