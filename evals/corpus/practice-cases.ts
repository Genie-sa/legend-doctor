import type { GoldPracticeCase } from "./contracts.js";
import { hoaluPracticeCases } from "./hoalu/practice-cases.js";
import { legendAppsPracticeCases } from "./legend-apps/practice-cases.js";
import { legendMusicPracticeCases } from "./legend-music/practice-cases.js";
import { legendPhotosPracticeCases } from "./legend-photos/practice-cases.js";
import { noriPracticeCases } from "./nori/practice-cases.js";
import { noutubePracticeCases } from "./noutube/practice-cases.js";

export const goldPracticeCases: readonly GoldPracticeCase[] = [
  ...legendMusicPracticeCases,
  ...hoaluPracticeCases,
  ...legendPhotosPracticeCases,
  ...legendAppsPracticeCases,
  ...noutubePracticeCases,
  ...noriPracticeCases,
];
