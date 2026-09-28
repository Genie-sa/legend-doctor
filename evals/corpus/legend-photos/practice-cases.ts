import type { GoldPracticeCase } from "../contracts.js";

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
    action: "batch-observable-writes",
    file: "features/FullscreenPhoto.tsx",
    line: 118,
    rationale: "Setting open and open-or-closing together is one fullscreen opening transition.",
    target: "legend-photos",
  },
  {
    action: "batch-observable-writes",
    file: "features/FullscreenPhoto.tsx",
    line: 175,
    rationale:
      "Uncovering window controls and clearing open-or-closing belong to one closing transition.",
    target: "legend-photos",
  },
  {
    action: "batch-observable-writes",
    file: "features/FullscreenPhoto.tsx",
    line: 197,
    rationale:
      "The close animation completion clears the photo and the open flag as one transition.",
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
      "RatingComponent is created without observer and reads photoMetadata$.rating.get() in render, so it never subscribes. Today PluginRenderer rerenders it only because shouldRender calls use$ inside a filter callback, a conditional hook; subscribing in the component keeps the same value and output.",
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
    file: "settings/HotkeySettings.tsx",
    line: 104,
    rationale:
      "Entering edit mode and clearing accumulated keys are one transition that the observing effect should see together.",
    target: "legend-photos",
  },
  {
    action: "narrow-use-value-subscription",
    file: "settings/LibrarySettings.tsx",
    line: 10,
    rationale:
      "The legacy useSelector subscribes to the whole library settings object, but render reads only paths; sibling library preferences should not invalidate the screen.",
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
] as const satisfies readonly GoldPracticeCase[];
