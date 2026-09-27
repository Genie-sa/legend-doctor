import type { LegendPracticeFinding } from "../../../src/core/types.js";
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

interface TransactionReport {
  readonly concurrentRoot: boolean;
  readonly transactions: readonly Pick<LegendPracticeFinding, "action" | "disposition">[];
}

async function transactionsUnder(
  dependencies: Readonly<Record<string, string>>,
): Promise<TransactionReport> {
  let result: TransactionReport = { concurrentRoot: false, transactions: [] };
  await withProject(
    {
      "package.json": JSON.stringify({ dependencies, name: "app", private: true }),
      "player.ts": PLAYER,
    },
    async (root) => {
      const report = await analyzePath(root);
      result = {
        concurrentRoot: report.capabilities.concurrentRoot,
        transactions: report.practices
          .filter(({ practice }) => practice === "assign" || practice === "batch")
          .map(({ action, disposition }) => ({ action, disposition })),
      };
    },
  );
  return result;
}

test("separate writes stay a proven render cost where a legacy root can render them", async () => {
  for (const dependencies of [{ "react-native": "0.78.2" }, { "react-dom": "18.3.1" }, {}]) {
    assert.deepEqual(await transactionsUnder(dependencies), {
      concurrentRoot: false,
      transactions: [
        { action: "assign-observable-fields", disposition: "change" },
        { action: "batch-observable-writes", disposition: "change" },
      ],
    });
  }
});

test("a concurrent root already renders separate writes once, so combining them is a review", async () => {
  for (const dependencies of [{ "react-native": "0.86.2" }, { "react-dom": "19.2.3" }]) {
    assert.deepEqual(await transactionsUnder(dependencies), {
      concurrentRoot: true,
      transactions: [
        { action: "assign-observable-fields", disposition: "candidate" },
        { action: "batch-observable-writes", disposition: "candidate" },
      ],
    });
  }
});

test("a concurrent-root review names the only observers that still see separate writes", async () => {
  await withProject(
    {
      "package.json": JSON.stringify({ dependencies: { "react-native": "0.86.2" }, name: "app" }),
      "player.ts": PLAYER,
    },
    async (root) => {
      const report = await analyzePath(root);
      const review = report.practices.find(({ action }) => action === "batch-observable-writes");
      assert.ok(review);
      assert.match(review.message, /^Review only: React already renders these writes once\./u);
      assert.match(review.message, /only when a non-React observer/u);
      assert.ok(review.evidence.some((line) => line.includes("only concurrent roots")));
    },
  );
});
