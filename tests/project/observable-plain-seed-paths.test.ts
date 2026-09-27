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
