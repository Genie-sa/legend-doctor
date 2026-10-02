import type { ReplayCommit } from "../contracts.js";

const effect = "useEffect(() => {";
const rootThemeContext =
  "Each themed leaf subscribed to the stored preference itself; reading a root-provided context instead removes per-leaf subscriptions, but a preference change still renders every leaf, so no render is removed.";
const deferredTabMount =
  "The screen's content now mounts on first focus or once launch has settled, a mount-timing change rather than a hook recommendation.";

const foodAppPerformanceImprovements = {
  cases: [
    {
      action: "move-state-down",
      expected: "non-enforced",
      file: "app/(app)/dinners/index.tsx",
      line: 25,
      rationale:
        "Every keystroke in the new-dinner field re-rendered DinnersScreen and its FlatList. The draft's readers and writers are host elements and onCreate inside the FlatList's inline ListHeaderComponent, not an existing child, so the edit must extract a new component that a third-party list renders, and the draft's lifetime then rests on VirtualizedList keeping its header mounted.",
      source: "useState('')",
    },
    {
      expected: "excluded",
      file: "app/(app)/dinners/index.tsx",
      line: 28,
      rationale: "The double-submit guard moves with the draft; a ref write renders nothing.",
      source: "useRef(false)",
    },
    {
      expected: "excluded",
      file: "app/_layout.tsx",
      line: 40,
      rationale:
        "ThemedRoot becomes the one subscriber and provides the scheme and locale through context, the provider side of a context hoist.",
      source: "useResolvedScheme()",
    },
    {
      expected: "excluded",
      file: "components/swipe-to-delete.tsx",
      line: 46,
      rationale:
        "The row's pan gesture is wrapped in useMemo so it is not rebuilt each render, a memo boundary.",
      source: "const pan = Gesture.Pan()",
    },
    {
      expected: "excluded",
      file: "components/week-board.tsx",
      line: 334,
      rationale: "DraggableDinnerCard is wrapped in memo, a memo boundary.",
      source: "function DraggableDinnerCard({",
    },
    {
      expected: "excluded",
      file: "hooks/use-theme.ts",
      line: 15,
      rationale: rootThemeContext,
      source: "useColorScheme()",
    },
    {
      expected: "excluded",
      file: "hooks/use-theme.ts",
      line: 16,
      rationale: rootThemeContext,
      source: "useThemePreference()",
    },
    {
      expected: "excluded",
      file: "lib/store/StoreProvider.tsx",
      line: 33,
      rationale:
        "Boot runs in the state initializer when the store is already hydrated, moving migrations and seeding from a passive effect into the first render, a mount-timing change.",
      source: "useState<unknown>(null)",
    },
    {
      expected: "excluded",
      file: "lib/store/StoreProvider.tsx",
      line: 51,
      rationale:
        "The effect now boots only when hydration is asynchronous, the other half of the same mount-timing change.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "lib/store/household.ts",
      line: 66,
      rationale:
        "Two field writes become one assign. React 19 already renders them once, and the only non-React listener, the sync engine's root onChange, marks the row dirty without reading the written values.",
      source: "store$.households[id].name.set(name)",
    },
    {
      expected: "excluded",
      file: "lib/store/household.ts",
      line: 90,
      rationale:
        "An equality guard skips the write and its updated_at bump when the servings are unchanged; no hook-level action guards a same-value write.",
      source: "store$.households[id].default_servings.set(servings)",
    },
    {
      expected: "excluded",
      file: "lib/store/settings.ts",
      line: 35,
      rationale: rootThemeContext,
      source: "useValue(() => {",
    },
  ],
  commit: "f75bd4b3b52f9ab817735adfb52c475d27d6eb26",
  parent: "1c0c385f0b19ec7e780fd0d110d7dc38b9ac08cd",
  repository: "food-app-expo",
  root: "src",
} as const satisfies ReplayCommit;

const foodAppHotPaths = {
  cases: [
    {
      expected: "excluded",
      file: "app/(app)/account/index.tsx",
      line: 40,
      rationale: deferredTabMount,
      source: "export default function AccountScreen() {",
    },
    {
      expected: "excluded",
      file: "app/(app)/dinners/index.tsx",
      line: 35,
      rationale: deferredTabMount,
      source: "export default function DinnersScreen() {",
    },
    {
      action: "select-primitive-projection",
      equivalents: ["narrow-use-value-subscription"],
      expected: "non-enforced",
      file: "app/(app)/index.tsx",
      line: 55,
      rationale:
        "useWeekPlanningContext wraps useValue(() => getWeekPlanningContext(weekStart)), whose selector builds a new object on every run, so any dinners, plans or entries write re-rendered PlansScreen although it reads only planning.dates.length > 0. A boolean selector cuts those renders only for a week without a plan: otherwise usePlanEntries returns an object that re-renders the screen on the same writes, and the projection goes through a custom hook's return in another module.",
      source: "useWeekPlanningContext(weekStartKey)",
    },
    {
      expected: "excluded",
      file: "app/(app)/shopping/index.tsx",
      line: 27,
      rationale: deferredTabMount,
      source: "export default function ShoppingListsScreen() {",
    },
    {
      action: "move-use-value-down",
      equivalents: ["split-use-value-leaves"],
      expected: "non-enforced",
      file: "app/(app)/shopping/index.tsx",
      line: 31,
      rationale:
        "useShoppingLists returns the shoppingLists$ computed, rebuilt with fresh summaries on every shoppingListItems write, so each tick re-rendered the lists screen, which stays mounted under an open list, and every row. Moving the read into extracted rows saves nothing alone, since each row would still read the rebuilt summaries; the cut needs the maintainer's id-only and per-list count derivations in the store module.",
      source: "useShoppingLists()",
    },
    {
      expected: "excluded",
      file: "app/sheets/plan-week.tsx",
      line: 43,
      rationale:
        "The selector becomes a cached computed, but at this parent a computed returning an object notifies on every re-run and the selector already rebuilt its object on each tracked write, so the sheet renders as often; only the per-render recompute is saved.",
      source: "useValue(() => getSuggestionContext(weekStart))",
    },
    {
      expected: "excluded",
      file: "components/ai-classification-worker.tsx",
      line: 24,
      rationale:
        "The polling timer stops while the app is in the background and a per-item query invalidation is dropped, a scheduling and network change that keeps the effect.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/dinner-image-uploader.tsx",
      line: 25,
      rationale:
        "The upload timer stops while the app is in the background instead of waking to skip, a scheduling change that keeps the effect.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "lib/auth/session.tsx",
      line: 116,
      rationale:
        "The dependency list names the never-changing controller instead of silencing the lint rule, so the React Compiler compiles the provider; the effect still runs once.",
      source: effect,
    },
  ],
  commit: "4dc2a61a23a5706cbb5095d92b92261a0a5015f9",
  parent: "acecdcc68f60b9188f1a10de4249a14766995c6c",
  repository: "food-app-expo",
  root: "src",
} as const satisfies ReplayCommit;

/** The food-app-expo maintainer's render-performance commits, classified against each parent tree. */
export const foodAppExpoReplayCommits: readonly ReplayCommit[] = [
  foodAppPerformanceImprovements,
  foodAppHotPaths,
];
