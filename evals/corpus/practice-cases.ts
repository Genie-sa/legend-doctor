import type { GoldPracticeCase } from "./contracts.js";
import { gptmePracticeCases } from "./gptme/practice-cases.js";
import { hoaluPracticeCases } from "./hoalu/practice-cases.js";
import { juntoPracticeCases } from "./junto/practice-cases.js";
import { legendAppsPracticeCases } from "./legend-apps/practice-cases.js";
import { legendMusicPracticeCases } from "./legend-music/practice-cases.js";
import { legendPhotosPracticeCases } from "./legend-photos/practice-cases.js";
import { noriPracticeCases } from "./nori/practice-cases.js";
import { noutubePracticeCases } from "./noutube/practice-cases.js";
import { openWebuiReactNativePracticeCases } from "./open-webui-react-native/practice-cases.js";
import { zenborgPracticeCases } from "./zenborg/practice-cases.js";

export const goldPracticeCases: readonly GoldPracticeCase[] = [
  ...legendMusicPracticeCases,
  ...hoaluPracticeCases,
  ...openWebuiReactNativePracticeCases,
  ...legendPhotosPracticeCases,
  ...legendAppsPracticeCases,
  ...noutubePracticeCases,
  ...noriPracticeCases,
  ...gptmePracticeCases,
  ...zenborgPracticeCases,
  ...juntoPracticeCases,
];
