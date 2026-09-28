import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { SubscriptionInventory } from "../../src/core/subscriptions.js";
import { analyzePath } from "../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function inventory(
  context: test.TestContext,
  body: string,
): Promise<Map<string, SubscriptionInventory>> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-selectors-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "Row.tsx"),
    `import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const selected$ = observable<string | null>(null);
    const items$ = observable<Record<string, { title: string; done: boolean }>>({});
    const list$ = observable<string[]>([]);
    const theme$ = observable({ accent: "#fff", dark: false });
    ${body}`,
  );
  const report = await analyzePath(root);
  const entries = report.subscriptionAnalysis?.inventory ?? [];
  const source = body.split("\n");
  return new Map(
    entries.map((entry) => {
      const line = source[entry.location.line - 7] ?? "";
      return [
        /const \[?(?<name>\w+)|(?<keyword>return)/u.exec(line)?.slice(1).find(Boolean) ?? line,
        entry,
      ];
    }),
  );
}

test("models proven selector reads and the primitive a per-item comparison returns", async (context) => {
  const entries = await inventory(
    context,
    `export function Row({ id, dimmed }: { id: string; dimmed: boolean }) {
      const isSelected = useValue(() => selected$.get() === id);
      const title = useValue(() => {
        const item = items$[id].title.get();
        if (!item) {
          return "";
        }
        return item.trim();
      });
      const faded = useValue(() => dimmed && theme$.dark.get());
      const both = useValue(() => (theme$.dark.get() ? items$.get() : null));
      const flags = useValue(() => (theme$.dark.get() === true) | (selected$.get() === id));
      return <li className={isSelected ? "on" : "off"}>{title}{String(faded)}{both}{flags}</li>;
    }`,
  );
  assert.deepEqual(entries.get("isSelected")?.selector, {
    tracks: ["selected$"],
    result: "boolean",
  });
  assert.equal(entries.get("isSelected")?.observable, "selected$");
  assert.deepEqual(
    entries.get("isSelected")?.reads.map((read) => read.kind),
    ["render"],
  );
  assert.deepEqual(entries.get("title")?.selector, {
    tracks: ["items$[id].title"],
    result: "primitive",
  });
  assert.deepEqual(entries.get("faded")?.selector, {
    tracks: ["theme$.dark"],
    result: "primitive",
  });
  assert.deepEqual(entries.get("both")?.selector, {
    tracks: ["theme$.dark", "items$"],
    result: "unknown",
  });
  assert.equal(entries.get("both")?.observable, null);
  assert.equal(
    entries.get("flags")?.selector?.result,
    "primitive",
    "bitwise OR of booleans is a number",
  );
  assert.ok([...entries.values()].every((entry) => entry.status === "unresolved"));
});

test("abstains from selectors whose tracking depends on unproven reads or calls", async (context) => {
  const entries = await inventory(
    context,
    `function compute(value: string | null): boolean { return value === theme$.accent.get(); }
    export function Row({ other$ }: { other$: unknown }) {
      const computed = useValue(() => compute(selected$.get()));
      const prop = useValue(() => (other$ as { get(): number }).get() > 0);
      const shallow = useValue(() => list$.length > 0);
      const snapshot = useValue(() => selected$.peek() === "a");
      const optional = useValue(() => selected$?.get() === "a");
      const closure = useValue(() => typeof compute === "function");
      const stateful = useValue(function* () { yield selected$.get(); });
      return <li>{computed}{prop}{shallow}{snapshot}{optional}{closure}{stateful}</li>;
    }`,
  );
  const reasons = (name: string): readonly string[] | undefined => entries.get(name)?.reasons;
  assert.deepEqual(reasons("computed"), ["selector-calls-unproven-function"]);
  assert.deepEqual(reasons("prop"), ["selector-observable-binding-not-proven"]);
  assert.deepEqual(reasons("shallow"), ["selector-read-not-proven"]);
  assert.deepEqual(reasons("snapshot"), ["selector-read-not-proven"]);
  assert.deepEqual(reasons("optional"), ["selector-read-not-proven"]);
  assert.deepEqual(reasons("closure"), ["selector-tracks-no-observable"]);
  assert.deepEqual(reasons("stateful"), ["selector-function-not-proven"]);
  for (const entry of entries.values()) {
    assert.equal(entry.selector, undefined);
    assert.deepEqual(entry.reads, []);
  }
});

test("a shadowed builtin or a block-scoped const cannot fake a primitive result", async (context) => {
  const entries = await inventory(
    context,
    `export function Row({ flag }: { flag: object }) {
      const Boolean = (value: unknown) => ({ value });
      const wrapped = useValue(() => Boolean(selected$.get()));
      const leaked = useValue(() => {
        if (selected$.get()) {
          const flag = true;
        }
        return flag;
      });
      return <li>{String(wrapped)}{String(leaked)}</li>;
    }`,
  );
  assert.deepEqual(entries.get("wrapped")?.reasons, ["selector-calls-unproven-function"]);
  assert.deepEqual(entries.get("leaked")?.selector, { tracks: ["selected$"], result: "unknown" });
});

test("names why a direct useValue result is not a bound subscription", async (context) => {
  const entries = await inventory(
    context,
    `export function useTheme() {
      return useValue(theme$);
    }
    export function Row() {
      const accent = useValue(theme$.accent) ?? "#000";
      const [first] = useValue(list$);
      const optioned = useValue(theme$.accent, { suspense: true });
      return <li>{accent}{first}{optioned}</li>;
    }`,
  );
  assert.deepEqual(entries.get("return")?.reasons, ["returned-result"]);
  assert.deepEqual(entries.get("accent")?.reasons, ["wrapped-result"]);
  assert.deepEqual(entries.get("optioned")?.reasons, ["use-value-options"]);
  assert.deepEqual(entries.get("first")?.reasons, ["destructured-result"]);
});
