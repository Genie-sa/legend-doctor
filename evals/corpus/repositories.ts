import type { CorpusRepository } from "./contracts.js";
import { excalidrawRepository } from "./excalidraw/repository.js";
import { expensifyRepository } from "./expensify/repository.js";
import { formbricksRepository } from "./formbricks/repository.js";
import { fractalsRepository } from "./fractals/repository.js";
import { gptmeRepository } from "./gptme/repository.js";
import { hoaluRepository } from "./hoalu/repository.js";
import { juntoRepository } from "./junto/repository.js";
import { legendAppsRepository } from "./legend-apps/repository.js";
import { legendMusicRepository } from "./legend-music/repository.js";
import { legendPhotosRepository } from "./legend-photos/repository.js";
import { noriRepository } from "./nori/repository.js";
import { noutubeRepository } from "./noutube/repository.js";
import { openWebuiReactNativeRepository } from "./open-webui-react-native/repository.js";
import { outlineRepository } from "./outline/repository.js";
import { zenborgRepository } from "./zenborg/repository.js";

/** Public applications every contributor can check out; a private slice may extend this list. */
export const repositories: readonly CorpusRepository[] = [
  legendMusicRepository,
  excalidrawRepository,
  expensifyRepository,
  formbricksRepository,
  outlineRepository,
  openWebuiReactNativeRepository,
  hoaluRepository,
  legendPhotosRepository,
  legendAppsRepository,
  noutubeRepository,
  noriRepository,
  gptmeRepository,
  zenborgRepository,
  juntoRepository,
  fractalsRepository,
];
