import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { SubscriptionInventory } from "../../../src/core/subscriptions.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const LEAVES = "<A/><B/><C/><D/><E/><F/><G/><H/><I/><J/><K/><L/>";

async function inventoryOf(
  context: test.TestContext,
  source: string,
  binding = "selected",
): Promise<{ entry: SubscriptionInventory; entries: SubscriptionInventory[]; actions: string[] }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-read-kinds-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "Screen.tsx"),
    `import { useObservable, useValue } from "@legendapp/state/react";
    import * as React from "react";
    import { useCallback, useEffect, useMemo } from "react";
    ${source}`,
  );
  const report = await analyzePath(root);
  const entries = report.subscriptionAnalysis?.inventory ?? [];
  const entry = entries.find((item) => item.binding === binding);
  assert.ok(entry);
  return { entry, entries, actions: report.practices.map((finding) => finding.action) };
}

function inventory(
  context: test.TestContext,
  setup: string,
  content: string,
): Promise<{ entry: SubscriptionInventory; entries: SubscriptionInventory[]; actions: string[] }> {
  return inventoryOf(
    context,
    `export function Screen({ items }: { items: string[] }) {
      const state$ = useObservable({ selected: "", track: { title: "" } });
      const selected = useValue(state$.selected);
      ${setup}
      return <main>${LEAVES}${content}</main>;
    }`,
  );
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

test("dependency lists share the kind of the effect or callback they guard", async (context) => {
  for (const [setup, expected] of [
    ["useEffect(() => sync(), [selected]);", "effect"],
    ["React.useLayoutEffect(() => sync(), [selected]);", "effect"],
    ["const onSave = useCallback(() => save(), [selected]);", "event-or-callback"],
    ['useHotkeys("mod+s", save, [selected]);', "unknown"],
  ] as const) {
    const { entry } = await inventory(context, setup, "");
    assert.deepEqual(kinds(entry), [expected], setup);
  }
});

test("a render gate over JSX is a render read; a read inside the selected element is not the gate", async (context) => {
  for (const [content, expected] of [
    ["{selected && <p/>}", ["render"]],
    ["{selected ?? <p/>}", ["render"]],
    ["{items.length > 1 || !selected ? <p/> : null}", ["render"]],
    ["{items.length ? <p/> : selected ? <b/> : null}", ["render"]],
    ["{selected && <p key={selected}/>}", ["render", "unknown"]],
    ["{format(selected) && <p/>}", ["unknown"]],
    ["{selected && <p/>}{(state$.track.title = selected) && <b/>}", ["render", "unknown"]],
  ] as const) {
    const { entry } = await inventory(context, "", content);
    assert.deepEqual(kinds(entry), expected, content);
  }
});

test("a JSX tag chosen by a gate controls mount identity and stays unsupported", async (context) => {
  const { entry } = await inventoryOf(
    context,
    `export function Screen() {
      const state$ = useObservable({ panel: null as null | (() => null) });
      const Panel = useValue(state$.panel);
      return <main>${LEAVES}{Panel ? <Panel/> : null}</main>;
    }`,
    "Panel",
  );
  assert.deepEqual(kinds(entry), ["render", "unknown"]);
});

test("early returns and returned conditionals that select JSX are render gates", async (context) => {
  for (const [body, expected] of [
    ["if (!selected) return null; return <main/>;", ["render"]],
    ["if (selected === items[0]) { return <p/>; } return <main/>;", ["render"]],
    ["return selected ? <p/> : null;", ["render"]],
    ["return items.length > 0 && selected ? <p/> : <main/>;", ["render"]],
    ["if (selected) { track(selected); } return <main/>;", ["unknown", "unknown"]],
    ["if (!selected) { log(); return null; } return <main/>;", ["unknown"]],
    ["if (!selected) return null; else log(); return <main/>;", ["unknown"]],
    ["if (isValid(selected)) return null; return <main/>;", ["unknown"]],
    ["if (!selected) return null; return items;", ["unknown"]],
    ["return selected ? items : null;", ["unknown"]],
  ] as const) {
    const { entry } = await inventoryOf(
      context,
      `export function Screen({ items }: { items: string[] }) {
        const state$ = useObservable({ selected: "" });
        const selected = useValue(state$.selected);
        ${body}
      }`,
    );
    assert.deepEqual(kinds(entry), expected, body);
  }
});

test("templates and comparisons are pure only when no operand can run conversion code", async (context) => {
  for (const [binding, content, expected] of [
    ["selected", `<p className={\`row \${selected ? "on" : "off"}\`}/>`, "render"],
    ["selected", `<p title={\`\${selected}\`}/>`, "render"],
    ["selected", "<p hidden={selected != null}/>", "render"],
    ["selected", '<p hidden={selected < "m"}/>', "render"],
    ["track", `<p title={\`\${track}\`}/>`, "unknown"],
    ["track", "<p hidden={track > 0}/>", "unknown"],
    ["track", "<p hidden={track == 0}/>", "unknown"],
  ] as const) {
    const { entry } = await inventoryOf(
      context,
      `export function Screen() {
        const state$ = useObservable({ selected: "", track: { title: "" } });
        const selected = useValue(state$.selected);
        const track = useValue(state$.track);
        return <main>${LEAVES}${content}</main>;
      }`,
      binding,
    );
    assert.deepEqual(kinds(entry), [expected], content);
  }
});

test("nested redeclarations are not reads, but still block name-keyed flow facts", async (context) => {
  const { entry } = await inventory(
    context,
    `const label = selected;
    const describe = () => { const selected = "x"; const label = selected; return label; };`,
    `<p>{label}</p><ul>{items.map((selected) => <li key={selected}>{selected}</li>)}</ul>`,
  );
  assert.deepEqual(kinds(entry), ["derivation", "render"]);
  assert.deepEqual(
    entry.derivations.map((derivation) => derivation.name),
    ["label"],
  );
  assert.ok(entry.reasons.includes("shadowed-or-reassigned-binding"));
  assert.ok(!entry.reasons.includes("no-render-consumer"));
});

test("a reassignable subscription binding stays unresolved", async (context) => {
  const { entries } = await inventory(
    context,
    `let chosen = useValue(state$.selected);
    if (items.length === 0) chosen = "";`,
    "<p>{chosen}</p>",
  );
  const chosen = entries.find((item) => item.binding === "chosen");
  assert.ok(chosen?.reasons.includes("shadowed-or-reassigned-binding"));
});
