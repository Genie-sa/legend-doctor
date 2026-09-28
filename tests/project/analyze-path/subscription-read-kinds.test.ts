import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { SubscriptionInventory } from "../../../src/core/subscriptions.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const LEAVES = "<A/><B/><C/><D/><E/><F/><G/><H/><I/><J/><K/><L/>";

async function inventory(
  context: test.TestContext,
  setup: string,
  content: string,
): Promise<{ entry: SubscriptionInventory; actions: string[] }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-read-kinds-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "Screen.tsx"),
    `import { useObservable, useValue } from "@legendapp/state/react";
    import * as React from "react";
    import { useMemo } from "react";
    export function Screen({ items }: { items: string[] }) {
      const state$ = useObservable({ selected: "" });
      const selected = useValue(state$.selected);
      ${setup}
      return <main>${LEAVES}${content}</main>;
    }`,
  );
  const report = await analyzePath(root);
  const entry = report.subscriptionAnalysis?.inventory.find((item) => item.binding === "selected");
  assert.ok(entry);
  return { entry, actions: report.practices.map((finding) => finding.action) };
}

function kinds(entry: SubscriptionInventory): string[] {
  return entry.reads.map((read) => read.kind);
}

test("memo callbacks and their dependency lists are memo reads, not event callbacks", async (context) => {
  for (const memo of ["useMemo", "React.useMemo"]) {
    const { entry, actions } = await inventory(
      context,
      `const label = ${memo}(() => format(selected), [selected]);`,
      "<output>{label}</output>",
    );
    assert.deepEqual(kinds(entry), ["memo", "memo"], memo);
    assert.deepEqual(entry.reasons, ["memo-consumer", "no-render-consumer"], memo);
    assert.ok(!actions.includes("move-use-value-down"), memo);
  }
});

test("synchronous array callbacks in the returned JSX are render reads that repeat", async (context) => {
  const { entry, actions } = await inventory(
    context,
    "",
    `<ul>{items.map((item) => <li key={item} aria-selected={item === selected}>{item}</li>)}</ul>
    <p>{items.find((item) => item === selected)}</p>
    <p>{(() => selected)()}</p>`,
  );
  assert.deepEqual(kinds(entry), ["render-callback", "render-callback", "render-callback"]);
  assert.deepEqual(entry.reasons, ["render-callback-consumer"]);
  assert.ok(!actions.includes("move-use-value-down"));
});

test("deferred, eager, and returned callbacks keep their callback or unsupported kinds", async (context) => {
  for (const [setup, content, expected] of [
    ["", "<button onClick={() => items.map((item) => item === selected)}/>", "event-or-callback"],
    ["", "<ul>{items.map(async (item) => item === selected)}</ul>", "event-or-callback"],
    ["", "<ul>{items.map(function* (item) { yield selected; })}</ul>", "event-or-callback"],
    ["const visible = items.filter((item) => item === selected);", "<p>{visible}</p>", "unknown"],
    [
      "const matches = useMemo(items.filter((item) => item === selected), []);",
      "<p>{matches}</p>",
      "unknown",
    ],
    [
      "const onSelect = useMemo(() => () => selected, []);",
      "<p onClick={onSelect}/>",
      "event-or-callback",
    ],
  ] as const) {
    const { entry } = await inventory(context, setup, content);
    assert.deepEqual(kinds(entry), [expected], setup || content);
  }
});
