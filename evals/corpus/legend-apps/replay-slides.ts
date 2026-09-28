import type { ReplayCommit } from "../contracts.js";

const repository = "legend-apps";
const slidesRoot = "apps/slides";
const slidesSourceRoot = "apps/slides/src";
const presentationRoot = "packages/presentation/src";
const effect = "useEffect(() => {";
const lifecycle = "useSlideLifecycle()";

const snapshotStoreMigrationRationale =
  "Replaces a per-field useSyncExternalStore selector with the matching slidesState$ leaf or selector; both compare the selected value, so the subscription granularity is unchanged.";

const slidesStoreMigration = {
  cases: [
    ...(
      [
        ["AudienceWindow.tsx", 10, "useSlidesState((state) => state.currentSlide)"],
        ["AudienceWindow.tsx", 11, "useSlidesState((state) => state.config.theme?.backgroundColor"],
        ["AudienceWindow.tsx", 17, "useSlidesState((state) => state.currentSlide)"],
        ["AudienceWindow.tsx", 18, "useSlidesState((state) => state.blackout)"],
        ["AudienceWindow.tsx", 19, "useSlidesState((state) => state.slides)"],
        ["AudienceWindow.tsx", 20, "useSlidesState((state) => state.config.transition)"],
        ["AudienceWindow.tsx", 21, "useSlidesState((state) => state.revision)"],
        ["DeckRenderer.tsx", 68, "useSlidesState((state) => state.currentSlide)"],
        ["DeckRenderer.tsx", 69, "useSlidesState((state) => state.currentStep)"],
        ["DeckRenderer.tsx", 70, "useSlidesState((state) => state.slideStartedAt)"],
        ["DeckRenderer.tsx", 71, "useSlidesState((state) => state.stepEpochs)"],
        ["DeckRenderer.tsx", 72, "useSlidesState((state) => state.direction)"],
        ["DeckRenderer.tsx", 73, "useSlidesState((state) => state.stepStartedAt)"],
        ["DeckRenderer.tsx", 74, "useSlidesState((state) => state.templates)"],
        ["DeckRenderer.tsx", 139, "useSlidesState((state) => state.config.theme)"],
        ["DeckRenderer.tsx", 224, "useSlidesState((state) => state.component)"],
        ["DeckRenderer.tsx", 225, "useSlidesState((state) => state.revision)"],
        ["DeckRenderer.tsx", 226, "useSlidesState((state) => state.retryRevision)"],
        ["DeckRenderer.tsx", 252, "useSlidesState((state) => state.currentSlide)"],
        ["DeckRenderer.tsx", 253, "useSlidesState((state) => state.config.theme?.backgroundColor"],
        ["DeckRenderer.tsx", 260, "useSlidesState((state) => state.config)"],
        ["PresenterWindow.tsx", 104, "useSlidesState((state) => state.slides.length)"],
        ["PresenterWindow.tsx", 105, "useSlidesState((state) => state.currentStep)"],
        [
          "PresenterWindow.tsx",
          106,
          "useSlidesState((state) => getSlideStepCount(state.slides[index]))",
        ],
        ["PresenterWindow.tsx", 149, "useSlidesState((state) => state.currentStep)"],
      ] as const
    ).map(([file, line, source]) => ({
      expected: "excluded" as const,
      file,
      line,
      rationale: snapshotStoreMigrationRationale,
      source,
    })),
    {
      action: "use-observable",
      expected: "enforced",
      file: "PresenterWindow.tsx",
      line: 489,
      rationale:
        "keyboardJump is written only by the key listener and its timeout, which already read the ref mirror, and renders only in one inline jump label; every digit press re-rendered the whole presenter instead of a leaf.",
      source: 'useState("")',
    },
    {
      action: "move-use-value-down",
      expected: "non-enforced",
      file: "PresenterWindow.tsx",
      line: 492,
      rationale:
        "The owner takes the whole store snapshot and renders nearly every field. The cut rewrites the snapshot store as an observable, extracts four components, and changes PresenterToolbar's props through a connected wrapper.",
      source: "useSlidesState((value) => value)",
    },
    {
      expected: "excluded",
      file: "PresenterWindow.tsx",
      line: 690,
      rationale:
        "Moves the window-title effect into PresenterDeckContent with the deckPath read; it still runs once per deck path change.",
      source: effect,
    },
  ],
  commit: "248bda38e1d5457a7de0c79734b53d28cf6db91f",
  parent: "bfab152df117ef5e4b3ef378d00c36aadda8f4bf",
  repository,
  root: slidesSourceRoot,
} as const satisfies ReplayCommit;

const displaySelectionRationale =
  "The owner derives selectedDisplay from displays and selectedDisplayId in its render body, so removing the owner render needs that derivation moved into the start command; the expert moved both into a presenter$ store the toolbar reads.";

const elapsedTimerRationale =
  "PresenterToolbar renders null, and elapsed feeds only the toolbar-text effect and a render-phase ref mirror, so each one-second interval tick re-rendered the toolbar just to run that native call.";

const timerRunningRationale =
  "timerRunning also drives the window-options effect alongside five props, so removing its render needs a dependency-driven observer; the saving is one null render per start or stop.";

const presenterControlsAndClocks = {
  cases: [
    {
      action: "move-use-value-down",
      expected: "non-enforced",
      file: "decks/react-native-desktop/packs/performance/FrameBudget.tsx",
      line: 64,
      rationale:
        "The per-frame time renders in a playhead, two cursors, and sixteen frame cells. The cut needs useEffectTime to return an observable and four new leaf components with time$ props.",
      source: "useEffectTime(3.7)",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "decks/react-native-desktop/packs/shared/effectRuntime.ts",
      line: 19,
      rationale:
        "The hook-owned clock is written every animation frame; publishing it changes the hook's return type, and the scalar useEffectTime wrapper keeps every other consumer rendering per frame.",
      source: "useState(isPreview ? previewTime : 0)",
    },
    {
      action: "use-observable",
      expected: "enforced",
      file: "src/Effect.tsx",
      line: 65,
      rationale:
        "The clock is written only by the animation-frame effect and reaches render only through the RuntimeShader's uniforms, so every frame re-rendered the canvas, both groups, and the image instead of one shader leaf.",
      source: "useState({ epoch: startedAt, time: isPreview ? previewTime : 0 })",
    },
    {
      expected: "excluded",
      file: "src/PresenterWindow.tsx",
      line: 254,
      rationale:
        "layout still renders in PresenterWorkspace through useValue; the edit only replaces the ref mirror with peek.",
      source: "useState(getPresenterLayout)",
    },
    {
      action: "use-observable",
      expected: "enforced",
      file: "src/PresenterWindow.tsx",
      line: 358,
      rationale: elapsedTimerRationale,
      source: "useState(0)",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "src/PresenterWindow.tsx",
      line: 359,
      rationale: timerRunningRationale,
      source: "useState(false)",
    },
    {
      action: "use-observe-effect",
      expected: "non-enforced",
      file: "src/PresenterWindow.tsx",
      line: 417,
      rationale: timerRunningRationale,
      source: effect,
    },
    {
      action: "use-observe-effect",
      expected: "non-enforced",
      file: "src/PresenterWindow.tsx",
      line: 427,
      rationale: timerRunningRationale,
      source: effect,
    },
    {
      expected: "excluded",
      file: "src/PresenterWindow.tsx",
      line: 443,
      rationale:
        "The toolbar-text effect becomes an observer as part of the elapsed conversion at line 358, which carries the case.",
      source: effect,
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "src/PresenterWindow.tsx",
      line: 485,
      rationale: displaySelectionRationale,
      source: "useState<Display[]>([])",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "src/PresenterWindow.tsx",
      line: 486,
      rationale: displaySelectionRationale,
      source: "useState<string | null>(null)",
    },
    {
      action: "use-observable",
      expected: "enforced",
      file: "src/PresenterWindow.tsx",
      line: 487,
      rationale:
        "The owner reads rehearsalEnabled only in the start command and passes it to ConnectedPresenterToolbar, so each rehearsal toggle re-rendered the whole presenter. An owner observable with a leaf subscriber around the toolbar keeps the toolbar's props and effects and removes that render.",
      source: "useState(false)",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "src/PresenterWindow.tsx",
      line: 488,
      rationale:
        "activeMode is also read in the owner's render for the notesEditable prop, so the owner render stays unless that expression moves into PresenterDeckContent, which changes its props.",
      source: "useState<PresenterMode | null>(null)",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "src/PresenterWindow.tsx",
      line: 490,
      rationale:
        "The version reaches PresenterDeckContent only as resetVersion; whether a leaf subscriber preserves the child's reset timing depends on that child's contract, which is unproven.",
      source: "useState(0)",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "src/PresenterWindow.tsx",
      line: 489,
      rationale:
        "notesEditing reaches the toolbar as a prop and the key listener as a dependency; peeking it in the listener is sound, but dropping the owner render needs the toolbar to take a presenter$ observable, an API change.",
      source: "useState(false)",
    },
  ],
  commit: "0ea5341ad6975b4d141c0adf5246a28a097dfb68",
  parent: "be2e8425250a0e55163fd56ed693e410aa977e97",
  repository,
  root: slidesRoot,
} as const satisfies ReplayCommit;

const observableRuntimeFields = {
  cases: [
    {
      expected: "excluded",
      file: "runtime.tsx",
      line: 21,
      rationale:
        "Wraps the provided snapshot in an observable; usePresentation still subscribes to the whole runtime, and no production consumer adopts the new field hook in this commit.",
      source: "<PresentationContext.Provider value={value}>",
    },
    {
      expected: "excluded",
      file: "runtime.tsx",
      line: 25,
      rationale:
        "usePresentation becomes useValue over the whole runtime observable, the same granularity as reading the context snapshot.",
      source: "useContext(PresentationContext)",
    },
    {
      expected: "excluded",
      file: "background.tsx",
      line: 15,
      rationale:
        "Background registers an observable handle instead of the runtime snapshot. The re-registration it saves comes from the provider publishing a stable observable, a cross-module context migration no action expresses.",
      source: "usePresentation()",
    },
    {
      expected: "excluded",
      file: "background.tsx",
      line: 41,
      rationale:
        "Adds the slideIndex subscription the observable registry needs to pick a background; no render is removed.",
      source: "const selected =",
    },
  ],
  commit: "b73924ebfb09c3a48bc2db9dfe63e26fdc477ba6",
  parent: "c9b2f24d8e43856786831b9fd85cf05e873a5f3d",
  repository,
  root: presentationRoot,
} as const satisfies ReplayCommit;

const deckClockRationale =
  "Deck read these slide clocks only to build the provider value. Moving them into a computed runtime observable needs every context consumer converted to field subscriptions, and fixed previews now publish their own slide and step instead of the live ones.";

const runtimeFieldSubscriptions = {
  cases: [
    ...(
      [
        [
          "decks/react-native-desktop/GlassCaption.tsx",
          8,
          "usePresentation()",
          "usePresentation subscribes to the whole presentation runtime, and GlassCaption reads only isActive, isPreview, isPreparing, stepIndex, and stepEpochs",
        ],
        [
          "decks/react-native-desktop/packs/backgrounds/AmbientAurora.tsx",
          33,
          lifecycle,
          "AmbientAurora reads only isActive and isPreview",
        ],
        [
          "decks/react-native-desktop/packs/presenting/Attention.tsx",
          20,
          lifecycle,
          "AttentionStage reads only isActive and isPreview",
        ],
        [
          "decks/react-native-desktop/packs/presenting/FreezeFrame.tsx",
          10,
          lifecycle,
          "FreezeFrame reads only isActive, isPreview, and startedAt",
        ],
        [
          "decks/react-native-desktop/packs/presenting/motion.ts",
          6,
          lifecycle,
          "useMotion reads only isActive and isPreview",
        ],
        [
          "decks/react-native-desktop/packs/shared/effectRuntime.ts",
          19,
          lifecycle,
          "useEffectTime$ reads only isActive, isPreview, and startedAt",
        ],
        [
          "examples/components/LifecycleAnimation.tsx",
          8,
          lifecycle,
          "LifecycleAnimation reads only isActive and isPreview",
        ],
        [
          "examples/components/SkiaNebula.tsx",
          32,
          lifecycle,
          "SkiaNebula reads only isActive and isPreview",
        ],
        [
          "examples/components/TypeGPUBoids.tsx",
          146,
          lifecycle,
          "BoidsScene reads only isActive and isPreview",
        ],
        [
          "examples/components/TypeGPUGameOfLife.tsx",
          11,
          lifecycle,
          "TypeGPUGameOfLife reads only isActive and isPreview",
        ],
        [
          "src/Effect.tsx",
          147,
          lifecycle,
          "Effect reads only isActive, isPreview, isPreparing, startedAt, and stepStartedAt",
        ],
        ["src/LiquidGlass.tsx", 42, lifecycle, "LiquidGlass reads only isActive and isPreview"],
        [
          "src/TypeGPU.tsx",
          34,
          lifecycle,
          "TypeGPU reads only isActive, isPreview, isPreparing, slideIndex, and startedAt",
        ],
        ["src/steps.tsx", 28, lifecycle, "Step reads only stepIndex, isPreview, and isActive"],
      ] as const
    ).map(([file, line, source, reads]) => ({
      action: "split-use-value-leaves" as const,
      expected: "enforced" as const,
      file,
      line,
      rationale: `${source === lifecycle ? "useSlideLifecycle subscribes to the whole presentation runtime through usePresentation, and " : ""}${reads}, so updates to the other runtime fields re-rendered it; the parent already exports usePresentationValue for field subscriptions.`,
      source,
    })),
    ...(
      [
        ["examples/components/FocusEngine.tsx", 7, "FocusEngine reads only isActive"],
        ["src/steps.tsx", 85, "Steps reads only stepIndex"],
      ] as const
    ).map(([file, line, reads]) => ({
      action: "narrow-use-value-subscription" as const,
      equivalents: ["split-use-value-leaves"] as const,
      expected: "enforced" as const,
      file,
      line,
      rationale: `useSlideLifecycle subscribes to the whole presentation runtime through usePresentation, and ${reads}, so updates to every other runtime field re-rendered it.`,
      source: lifecycle,
    })),
    {
      action: "use-observable",
      expected: "enforced",
      file: "decks/react-native-desktop/packs/backgrounds/AmbientAurora.tsx",
      line: 36,
      rationale:
        "time is written only by the animation-frame effect and renders only in the inline Shader's uniforms, so every frame re-rendered the view and canvas instead of one shader leaf.",
      source: "useState(isPreview ? 8 : 0)",
    },
    {
      expected: "excluded",
      file: "examples/components/LifecycleAnimation.tsx",
      line: 9,
      rationale:
        "Moves the Animated.Value into a lazy useState initializer to avoid a render-time ref read under React Compiler; no render or effect run changes.",
      source: "useRef(new Animated.Value(isPreview ? 1 : 0)).current",
    },
    {
      expected: "excluded",
      file: "examples/components/TypeGPUGameOfLife.tsx",
      line: 15,
      rationale:
        "Moves the GPU setup into an imperative module function for React Compiler; the effect's dependencies and runs are unchanged.",
      source: effect,
    },
    ...(
      [
        [69, "useValue(slidesState$.currentSlide)"],
        [70, "useValue(slidesState$.currentStep)"],
        [71, "useValue(slidesState$.slideStartedAt)"],
        [72, "useValue(slidesState$.stepEpochs)"],
        [73, "useValue(slidesState$.direction)"],
        [74, "useValue(slidesState$.stepStartedAt)"],
      ] as const
    ).map(([line, source]) => ({
      action: "move-use-value-down" as const,
      expected: "non-enforced" as const,
      file: "src/DeckRenderer.tsx",
      line,
      rationale: deckClockRationale,
      source,
    })),
    {
      action: "narrow-use-value-subscription",
      expected: "enforced",
      file: "src/DeckRenderer.tsx",
      line: 253,
      rationale:
        "SlideCanvas reads currentSlide only in targetIndex ?? currentSlide, so a fixed preview with a targetIndex re-rendered on every live slide change; selecting the coalesced index keeps the same prop.",
      source: "useValue(slidesState$.currentSlide)",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "src/LiquidGlass.tsx",
      line: 44,
      rationale:
        "progress is written every animation frame and renders into Effect's blur and uniforms and the overlay opacity; the cut needs Effect to accept observable and function props, which changes its API.",
      source: "useState(target)",
    },
  ],
  commit: "2e57a26171722656e9be002df6e32a732d431dea",
  parent: "b73924ebfb09c3a48bc2db9dfe63e26fdc477ba6",
  repository,
  root: slidesRoot,
} as const satisfies ReplayCommit;

const annotationConsumerRationale =
  "Each annotation reads one target's bounds from a context object rebuilt on every measurement; a per-target selector needs the context to carry an observable and the stage to publish per-target writes.";

const annotationMeasurements = {
  cases: [
    {
      expected: "excluded",
      file: "decks/react-native-desktop/packs/presenting/Attention.tsx",
      line: 18,
      rationale:
        "The stage still subscribes to width and height, so a resize re-renders the same components.",
      source: "useState({ width: 0, height: 0 })",
    },
    {
      action: "use-observable",
      expected: "non-enforced",
      file: "decks/react-native-desktop/packs/presenting/Attention.tsx",
      line: 19,
      rationale:
        "The bounds map is replaced whenever any target moves, re-rendering the stage and every annotation. The cut needs an observable context, per-target selectors, and a hand-diffed per-key batch write, since replacing the whole map would still notify every target.",
      source: "useState<Record<string, Bounds>>({})",
    },
    {
      action: "narrow-use-value-subscription",
      expected: "non-enforced",
      file: "decks/react-native-desktop/packs/presenting/Attention.tsx",
      line: 82,
      rationale: annotationConsumerRationale,
      source: "useContext(Measurements)",
    },
    {
      action: "narrow-use-value-subscription",
      expected: "non-enforced",
      file: "decks/react-native-desktop/packs/presenting/Attention.tsx",
      line: 97,
      rationale: annotationConsumerRationale,
      source: "useContext(Measurements)",
    },
  ],
  commit: "bb5a17ef40257c78aa61ebfce1992238ecc65f26",
  parent: "3bac1e19de2d988808a9c985cb28b3003c3885d5",
  repository,
  root: slidesRoot,
} as const satisfies ReplayCommit;

const glassSelectorRationale =
  "Replaces a dependency-driven computed observable with a selector function to stop render-phase observable updates; the leaves still re-render on every animation frame and LiquidGlass already did not.";

const glassLeafSelectors = {
  cases: [
    [67, "useObservable(() => isPreview || !isActive ? target : progress$.get()"],
    [68, "useObservable(() => Math.max(0, blur) * displayedProgress$.get()"],
    [69, "useObservable(() => ({ progress: displayedProgress$.get()"],
  ].map(([line, source]) => ({
    expected: "excluded" as const,
    file: "LiquidGlass.tsx",
    line: line as number,
    rationale: glassSelectorRationale,
    source: source as string,
  })),
  commit: "81c6183f8c36cb9591163dd1e6f9b8e9ba2c9eeb",
  parent: "0dbd7cc62c8595918a3b9a0df4354c48bb1b3c2e",
  repository,
  root: slidesSourceRoot,
} as const satisfies ReplayCommit;

const narrowSlideConfigSubscriptions = {
  cases: [
    {
      expected: "excluded",
      file: "DeckRenderer.tsx",
      line: 92,
      rationale:
        "Narrows the projection's slide read to metadata.steps; a notes edit produced the same stepCount, so field subscribers never re-rendered and only the computation re-run is saved.",
      source: "useRuntimeProjection(() => {",
    },
    {
      action: "split-use-value-leaves",
      expected: "enforced",
      file: "DeckRenderer.tsx",
      line: 138,
      rationale:
        "MarkdownText reads only theme.color and theme.fontFamily from the whole theme subscription, so other theme fields re-rendered every markdown text node.",
      source: "useValue(slidesState$.config.theme)",
    },
    {
      action: "split-use-value-leaves",
      expected: "enforced",
      file: "DeckRenderer.tsx",
      line: 260,
      rationale:
        "SlideCanvasContent reads only aspectRatio, width, height, and theme.backgroundColor from the whole config subscription, so transition, presenter, and text theme changes re-rendered the canvas.",
      source: "useValue(slidesState$.config)",
    },
  ],
  commit: "3447570350d560617654e522f59753123734954e",
  parent: "81c6183f8c36cb9591163dd1e6f9b8e9ba2c9eeb",
  repository,
  root: slidesSourceRoot,
} as const satisfies ReplayCommit;

const narrowPresentationHooks = {
  cases: [
    {
      action: "split-use-value-leaves",
      expected: "enforced",
      file: "runtime.tsx",
      line: 40,
      rationale:
        "useSlideLifecycle returns eight fields from a whole-runtime subscription, so currentSlide, direction, and stepEpochs updates re-rendered every caller; usePresentationValue already exists in the file.",
      source: "usePresentation()",
    },
    {
      action: "narrow-use-value-subscription",
      equivalents: ["split-use-value-leaves"],
      expected: "enforced",
      file: "runtime.tsx",
      line: 46,
      rationale:
        "useStep reads stepIndex only through comparisons with at, plus the at-th epoch, isActive, isPreview, and direction, so step changes that flip neither comparison and every other runtime field re-rendered each caller.",
      source: "usePresentation()",
    },
  ],
  commit: "3447570350d560617654e522f59753123734954e",
  parent: "81c6183f8c36cb9591163dd1e6f9b8e9ba2c9eeb",
  repository,
  root: presentationRoot,
} as const satisfies ReplayCommit;

/** Jay Meistrich's Slides runtime and presentation commits, classified against each parent tree. */
export const legendAppsSlidesReplayCommits: readonly ReplayCommit[] = [
  slidesStoreMigration,
  presenterControlsAndClocks,
  observableRuntimeFields,
  runtimeFieldSubscriptions,
  annotationMeasurements,
  glassLeafSelectors,
  narrowSlideConfigSubscriptions,
  narrowPresentationHooks,
];
