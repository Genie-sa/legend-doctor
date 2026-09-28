import type { ReplayCommit } from "../contracts.js";

const repository = "legend-photos";
const root = "src";

const photoSelection = {
  cases: [
    {
      action: "select-primitive-projection",
      equivalents: ["narrow-use-value-subscription"],
      expected: "enforced",
      file: "Photo.tsx",
      line: 22,
      rationale:
        "selectedIndex is read only in the isSelected comparison with the row's index, so every photo re-rendered on each selection change; a boolean selector re-renders only the two photos whose selection flips.",
      source: "useSelector(state$.selectedPhotoIndex)",
    },
  ],
  commit: "f7d85c45ea5e41a78e0d76ca84ba6d3a4d480d02",
  parent: "9bcdcfdf99b9c006746974f3f83dc43752deaffa",
  repository,
  root,
} as const satisfies ReplayCommit;

const imageLoadCaching = {
  cases: [
    {
      expected: "excluded",
      file: "FullscreenPhoto.tsx",
      line: 93,
      rationale:
        "Wraps onLoad in useCallback with no dependencies so the newly memoized Img can skip renders; adding a memo boundary is not a vocabulary action, and the callback now reads the fullscreen photo when it fires.",
      source: "const onLoad = () => {",
    },
    {
      expected: "excluded",
      file: "Img.tsx",
      line: 20,
      rationale:
        "Seeds the aspect ratio from a module-level cache so a remounted image skips its post-load resize; caching across mounts changes the first frame and is not a render or lifecycle proof.",
      source: "useState(1)",
    },
  ],
  commit: "d4426c2f7acaa1e6be8571543a40ddb188c0d5de",
  parent: "f7d85c45ea5e41a78e0d76ca84ba6d3a4d480d02",
  repository,
  root,
} as const satisfies ReplayCommit;

const pluginShouldRender = {
  cases: [
    {
      expected: "excluded",
      file: "plugins/FlagRejectPlugin.tsx",
      line: 45,
      rationale:
        "Moves the null guard into a new plugin shouldRender hook that PluginRenderer calls while filtering; this reshapes the plugin API rather than removing a subscription.",
      source: "if (!photoMetadata) {",
    },
    {
      expected: "excluded",
      file: "plugins/RatingPlugin.tsx",
      line: 21,
      rationale:
        "The metadata subscription moves into shouldRender, which now hides unrated photos' rating UI, and the same commit adds rating toggles; both are product changes.",
      source: "use$(photoMetadata$)",
    },
  ],
  commit: "f3338914617ab54cdbc250e5955f672c3fc0c27b",
  parent: "6893d33b5069e844840ffff6f1cc4ee485f717b2",
  repository,
  root,
} as const satisfies ReplayCommit;

const filmstripWidth = {
  cases: [
    {
      expected: "excluded",
      file: "features/Filmstrip.tsx",
      line: 45,
      rationale:
        "Adds a window-width subscription so the list gets an explicit width and stops re-laying out natively each frame; it adds a render dependency rather than removing one.",
      source: "const listRef = useRef<LegendListRef>(null);",
    },
  ],
  commit: "cfa939e035f3e1d3d3ed7409e69b6ec0cfb82bed",
  parent: "3d6000fb3de43860ffa8fdd5eb38e5738a57c442",
  repository,
  root,
} as const satisfies ReplayCommit;

/** Every hook edit in Jay Meistrich's Legend Photos performance commits, classified against the parent tree. */
export const legendPhotosReplayCommits: readonly ReplayCommit[] = [
  pluginShouldRender,
  photoSelection,
  imageLoadCaching,
  filmstripWidth,
];
