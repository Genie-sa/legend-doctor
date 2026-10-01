import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

const PLAYER = `
import { observable, observe } from "@legendapp/state";

const player$ = observable({ index: 0, playing: false });
const queue$ = observable({ count: 0 });

observe(() => {
  player$.index.get();
  player$.playing.get();
});

export function play(index: number) {
  player$.index.set(index);
  player$.playing.set(true);
}

export function enqueue(index: number, count: number) {
  queue$.count.set(count);
  player$.index.set(index);
}
`;

test("React renders separate writes once, so only writes a non-React tracker spans are combined", async () => {
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
        transactions.map(({ action, disposition, location }) => ({
          action,
          disposition,
          line: location.line,
        })),
        [{ action: "assign-observable-fields", disposition: "change", line: 13 }],
      );
      assert.match(transactions[0]?.message ?? "", /observers publish once/u);
    },
  );
});
