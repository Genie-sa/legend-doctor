import { actions, requireValue } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

test("keeps empty-dependency effects that Legend's lifecycle hooks would only rename", () => {
  for (const [effect, alias] of [
    ["useEffect(() => () => clearTimeout(timer.current), []);", "useUnmount"],
    ["useEffect(() => { preload(); }, []);", "useMount"],
    ["useEffect(() => { client.warm(); }, []);", "useMount"],
  ] as const) {
    const [finding] = analyzeSource(
      `
      import { useEffect, useRef } from "react";
      import { preload } from "./preload";
      export function Screen({ client }: { client: { warm: () => void } }) {
        const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
        ${effect}
        return null;
      }
    `,
      "fixture.tsx",
    );
    assert.equal(requireValue(finding).action, "keep-effect", effect);
    assert.equal(requireValue(finding).disposition, "keep", effect);
    assert.match(requireValue(finding).message, new RegExp(`\`${alias}\` runs this same`, "u"));
  }
});

function emptyEffectMessage(body: string): string {
  const [finding] = analyzeSource(
    `
    import { useEffect } from "react";
    export function Screen() {
      useEffect(() => { ${body} }, []);
      return null;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "keep-effect", body);
  return requireValue(finding).message;
}

test("does not call returned setup work a teardown-only effect", () => {
  for (const cleanup of [
    `subscribe()`,
    `source.listen()`,
    `cleanupRef.current`,
    `ready ? cleanupA : cleanupB`,
  ]) {
    assert.doesNotMatch(emptyEffectMessage(`return ${cleanup};`), /useUnmount/u, cleanup);
  }
});

test("recognizes direct returned cleanup function values", () => {
  for (const cleanup of [`() => release()`, `function cleanup() { release(); }`, `cleanup`]) {
    assert.match(emptyEffectMessage(`return ${cleanup};`), /`useUnmount` runs this same/u, cleanup);
  }
});

test("keeps an effect whose cleanup is returned under a branch or try instead of converting it", () => {
  for (const [label, body, dependencies, action] of [
    [
      "observable reaction, branch",
      `if (enabled) { const id = setInterval(() => console.log("tick"), 1000); return () => clearInterval(id); }`,
      `[enabled]`,
      "keep-effect",
    ],
    [
      "observable reaction, try",
      `try { if (enabled) { const id = setInterval(() => console.log("tick"), 1000); return () => clearInterval(id); } } catch { console.log("failed"); }`,
      `[enabled]`,
      "keep-effect",
    ],
    [
      "empty dependencies, branch",
      `if (window.matchMedia("(pointer: fine)").matches) { window.addEventListener("resize", onResize); return () => window.removeEventListener("resize", onResize); }`,
      `[]`,
      "keep-effect",
    ],
  ] as const) {
    const [finding] = analyzeSource(
      `
        import { useEffect } from "react";
        import { useValue } from "@legendapp/state/react";
        import { settings$ } from "./settings";
        function onResize() { document.title = String(window.innerWidth); }
        export function Watcher() {
          const enabled = useValue(settings$.enabled);
          useEffect(() => { ${body} }, ${dependencies});
          return <span>{String(settings$.peek())}</span>;
        }
      `,
      "fixture.tsx",
    );
    assert.equal(requireValue(finding).action, action, label);
    assert.equal(requireValue(finding).assumption, undefined, label);
  }
});

test("does not count a bare return or a nested function's return as effect cleanup", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      import { useValue } from "@legendapp/state/react";
      export function Title({ title$ }: { title$: unknown }) {
        const title = useValue(title$);
        useEffect(() => {
          if (!title) {
            return;
          }
          const format = (value: string) => {
            return value + "!";
          };
          document.title = format(String(title));
        }, [title]);
        return null;
      }
    `),
    ["use-observe-effect"],
  );
});

test("leaves a state-scheduled effect with a conditional cleanup under review", () => {
  const [, effect] = analyzeSource(
    `
      import { useEffect, useState } from "react";
      export function Badge({ label }: { label: string }) {
        const [copied, setCopied] = useState(false);
        useEffect(() => {
          if (copied) {
            const timer = setTimeout(() => setCopied(false), 5000);
            return () => clearTimeout(timer);
          }
        }, [copied]);
        return (
          <section>
            <header><h1>{label}</h1><p>Intro</p></header>
            <main><p>Body</p><p>More</p></main>
            <button onClick={() => setCopied(true)}>{copied ? "Copied" : "Copy"}</button>
          </section>
        );
      }
    `,
    "fixture.tsx",
  );
  assert.equal(requireValue(effect).action, "review-effect");
});
