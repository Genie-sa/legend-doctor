import { actions, requireValue } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

test("reviews setup-only empty effects because useMount changes Strict Mode semantics", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      export function Analytics() {
        useEffect(() => { trackVisit(); }, []);
        return null;
      }
    `),
    ["review-effect"],
  );
});

test("suggests useMount only for module-global setup without owner-local captures", () => {
  const [finding] = analyzeSource(
    `
    import { useEffect } from "react";
    import { warmCache } from "./cache";
    export function App() {
      useEffect(() => { warmCache(); }, []);
      return null;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-mount");
  assert.equal(requireValue(finding).disposition, "candidate");

  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      export function App({ client }: { client: { warm: () => void } }) {
        useEffect(() => { client.warm(); }, []);
        return null;
      }
    `),
    ["review-effect"],
  );
});

test("keeps conditional useUnmount advice as a candidate", () => {
  const [finding] = analyzeSource(
    `
    import { useEffect } from "react";
    import { release } from "./resource";
    export function App() {
      useEffect(() => () => release(), []);
      return null;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-unmount");
  assert.equal(requireValue(finding).disposition, "candidate");
});

test("does not call returned setup work a teardown-only effect", () => {
  for (const cleanup of [
    `subscribe()`,
    `source.listen()`,
    `cleanupRef.current`,
    `ready ? cleanupA : cleanupB`,
  ]) {
    assert.deepEqual(
      actions(`
        import { useEffect } from "react";
        export function Screen() {
          useEffect(() => { return ${cleanup}; }, []);
          return null;
        }
      `),
      ["keep-effect"],
      cleanup,
    );
  }
});

test("recognizes direct returned cleanup function values", () => {
  for (const cleanup of [`() => release()`, `function cleanup() { release(); }`, `cleanup`]) {
    assert.deepEqual(
      actions(`
        import { useEffect } from "react";
        export function Screen() {
          useEffect(() => { return ${cleanup}; }, []);
          return null;
        }
      `),
      ["use-unmount"],
      cleanup,
    );
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
