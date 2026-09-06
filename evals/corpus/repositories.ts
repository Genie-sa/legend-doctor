import type { CorpusRepository } from "./contracts.js";
import { excalidrawRepository } from "./excalidraw/repository.js";
import { expensifyRepository } from "./expensify/repository.js";
import { formbricksRepository } from "./formbricks/repository.js";
import { hoaluRepository } from "./hoalu/repository.js";
import { legendMusicRepository } from "./legend-music/repository.js";
import { openWebuiReactNativeRepository } from "./open-webui-react-native/repository.js";
import { outlineRepository } from "./outline/repository.js";

/** Public applications every contributor can check out; a private slice may extend this list. */
export const repositories: readonly CorpusRepository[] = [
  legendMusicRepository,
  excalidrawRepository,
  expensifyRepository,
  formbricksRepository,
  outlineRepository,
  openWebuiReactNativeRepository,
  hoaluRepository,
];
