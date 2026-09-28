import assert from "node:assert/strict";
import { buildSourceIndex } from "../../src/project/source-components/source-components.js";
import path from "node:path";
import test from "node:test";
import { withProject } from "./with-project.js";

test("resolves imported observable paths seeded with plain data", async () => {
  await withProject(
    {
      "player.ts": `
        import { observable } from "@legendapp/state";
        declare const WIDTH: number;
        declare const defaults: object;
        export const player$ = observable({ playing: false, index: -1, width: WIDTH, tags: ["a"] });
        export const lazy$ = observable({ ready: () => true });
        export const spread$ = observable({ open: false, ...defaults });
        export let mutable$ = observable({ open: false });
      `,
      "screen.tsx":
        'import { lazy$, mutable$, player$, spread$ } from "./player"; export function Screen() { return null; }',
    },
    (root, sources) => {
      const paths = buildSourceIndex(root, sources).observablePlainSeedPathsFor(
        path.join(root, "screen.tsx"),
      );
      assert.deepEqual([...paths].toSorted(), ["player$.index", "player$.playing", "player$.tags"]);
    },
  );
});

test("proves seeds that name a module constant of a plain scalar literal", async () => {
  await withProject(
    {
      "constants.ts": `
        export const HEIGHT = 132;
        export const LABEL = "compact" as const;
        export let MUTABLE = 1;
        export const COMPUTED = Math.max(1, 2);
      `,
      "barrel.ts": 'export { LABEL } from "./constants";',
      "overlay.ts": `
        import { observable } from "@legendapp/state";
        import { COMPUTED, HEIGHT, MUTABLE } from "./constants";
        import { LABEL } from "./barrel";
        const WIDTH = -340;
        const SHADOWED = 1;
        export function resize(SHADOWED: number) { return SHADOWED; }
        export const overlay$ = observable({
          height: HEIGHT,
          width: WIDTH,
          label: LABEL,
          frame: { height: HEIGHT },
          mutable: MUTABLE,
          computed: COMPUTED,
          shadowed: SHADOWED,
        });
      `,
      "screen.tsx":
        'import { overlay$ } from "./overlay"; export function Screen() { return null; }',
    },
    (root, sources) => {
      const paths = buildSourceIndex(root, sources).observablePlainSeedPathsFor(
        path.join(root, "screen.tsx"),
      );
      assert.deepEqual([...paths].toSorted(), [
        "overlay$.frame",
        "overlay$.frame.height",
        "overlay$.height",
        "overlay$.label",
        "overlay$.width",
      ]);
    },
  );
});
