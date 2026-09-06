import type { GoldStateGroupCase } from "./contracts.js";
import { expensifyStateGroups } from "./expensify/state-groups.js";
import { formbricksStateGroups } from "./formbricks/state-groups.js";
import { legendMusicStateGroups } from "./legend-music/state-groups.js";

export const goldStateGroups: readonly GoldStateGroupCase[] = [
  ...legendMusicStateGroups,
  ...expensifyStateGroups,
  ...formbricksStateGroups,
];
