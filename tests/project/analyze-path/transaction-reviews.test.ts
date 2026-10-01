import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

const PLAYER = `
import { observable } from "@legendapp/state";

const player$ = observable({ index: 0, playing: false });
const queue$ = observable({ count: 0 });

export function play(index: number) {
  player$.index.set(index);
  player$.playing.set(true);
}

export function enqueue(index: number, count: number) {
  queue$.count.set(count);
  player$.index.set(index);
}
`;

test("React already renders separate writes once, so combining them is a review naming the remaining observers", async () => {
  await withProject(
    {
      "package.json": JSON.stringify({ name: "app", private: true }),
      "player.ts": PLAYER,
    },
    async (root) => {
      const report = await analyzePath(root);
      const transactions = report.practices.filter(
        ({ practice }) => practice === "assign" || practice === "batch",
      );
      assert.deepEqual(
        transactions.map(({ action, disposition }) => ({ action, disposition })),
        [
          { action: "assign-observable-fields", disposition: "candidate" },
          { action: "batch-observable-writes", disposition: "candidate" },
        ],
      );
      for (const { message } of transactions) {
        assert.match(message, /^Review only: React already renders these writes once\./u);
        assert.match(message, /only when a non-React observer/u);
      }
    },
  );
});
