import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { SubscriptionRuleGate } from "../../../src/core/subscriptions.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function ruleGates(
  context: test.TestContext,
  store: string,
  body: string,
): Promise<SubscriptionRuleGate[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-rule-gates-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "Player.tsx"),
    `import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    import { synced } from "@legendapp/state/sync";
    import { useRef } from "react";
    declare function compute(): boolean;
    ${store}
    export function Player() {
      ${body}
    }`,
  );
  const report = await analyzePath(root);
  const [entry, ...others] = report.subscriptionAnalysis?.inventory ?? [];
  assert.ok(entry);
  assert.equal(others.length, 0);
  return entry.ruleGates;
}

const plain = "const player$ = observable({ playing: false });";

test("an unresolved subscription names the gate where peek-unrendered-use-value abstained", async (context) => {
  for (const [gate, store, body] of [
    [
      "binding-not-owner-level-const",
      plain,
      "let playing = useValue(player$.playing); return null;",
    ],
    [
      "subscription-call-not-proven",
      plain,
      "const playing = useValue(player$.playing, {}); return null;",
    ],
    [
      "plain-seed-not-proven",
      "const player$ = observable({ playing: synced({ get: () => false }) });",
      "const playing = useValue(player$.playing); return null;",
    ],
    [
      "read-not-snapshot-safe",
      plain,
      "const playing = useValue(player$.playing); return <p>{String(playing)}</p>;",
    ],
    [
      "fallback-not-rewritable",
      plain,
      "const playing = useValue(player$.playing) ?? compute(); return null;",
    ],
    [
      "render-reads-untracked-state",
      plain,
      "const count = useRef(0); const playing = useValue(player$.playing); return <p>{count.current}</p>;",
    ],
  ] as const) {
    assert.deepEqual(
      await ruleGates(context, store, body),
      [{ action: "peek-unrendered-use-value", gate }],
      gate,
    );
  }
});

test("a subscription the rule proves carries no gate", async (context) => {
  assert.deepEqual(
    await ruleGates(context, plain, "const playing = useValue(player$.playing); return null;"),
    [],
  );
});
