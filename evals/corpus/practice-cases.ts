import type { GoldPracticeCase } from "./contracts.js";
import { hoaluPracticeCases } from "./hoalu/practice-cases.js";
import { legendMusicPracticeCases } from "./legend-music/practice-cases.js";
import { openWebuiReactNativePracticeCases } from "./open-webui-react-native/practice-cases.js";

export const goldPracticeCases: readonly GoldPracticeCase[] = [
  ...legendMusicPracticeCases,
  ...openWebuiReactNativePracticeCases,
  ...hoaluPracticeCases,
];
