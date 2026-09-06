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
