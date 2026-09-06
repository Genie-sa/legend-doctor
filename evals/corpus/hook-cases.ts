import type { GoldHookCase } from "./contracts.js";
import { crossRepositoryHookCases } from "./cross-repository/hook-cases.js";
import { excalidrawHookCases } from "./excalidraw/hook-cases.js";
import { expensifyHookCases } from "./expensify/hook-cases.js";
import { formbricksHookCases } from "./formbricks/hook-cases.js";
import { hoaluHookCases } from "./hoalu/hook-cases.js";
import { legendMusicHookCases } from "./legend-music/hook-cases.js";
import { openWebuiReactNativeHookCases } from "./open-webui-react-native/hook-cases.js";
import { outlineHookCases } from "./outline/hook-cases.js";

export const goldCases: readonly GoldHookCase[] = [
  ...legendMusicHookCases,
  ...excalidrawHookCases,
  ...expensifyHookCases,
  ...formbricksHookCases,
  ...outlineHookCases,
  ...openWebuiReactNativeHookCases,
  ...hoaluHookCases,
  ...crossRepositoryHookCases,
];
