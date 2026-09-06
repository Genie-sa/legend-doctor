import { actions, requireValue } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

test("moves a one-shot deferred reveal sink to an observable leaf without replacing its effect", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Screen() {
      const [ready, setReady] = useState(false);
      useEffect(() => {
        const handle = requestIdleCallback(() => setReady(true));
        return () => cancelIdleCallback(handle);
      }, []);
      return ready ? <HeavyLeaf /> : <Placeholder />;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "ready")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.hook === "useEffect")).action,
    "keep-effect",
  );
});

test("recognizes a one-shot render gate that returns a unique const JSX alias", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Screen() {
      const [ready, setReady] = useState(false);
      useEffect(() => {
        const handle = requestIdleCallback(() => setReady(true));
        return () => cancelIdleCallback(handle);
      }, []);
      const placeholder = <Placeholder />;
      if (!ready) return placeholder;
      return <HeavyLeaf />;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "ready")).action,
    "use-observable",
  );
});

test("does not treat a nested function JSX return as the owner's render gate", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Screen() {
        const [ready, setReady] = useState(false);
        useEffect(() => {
          const handle = requestIdleCallback(() => setReady(true));
          return () => cancelIdleCallback(handle);
        }, []);
        if (ready) {
          const renderLater = () => <HeavyLeaf />;
          report(renderLater);
        }
        return <Placeholder />;
      }
    `),
    ["keep-state", "keep-effect"],
  );
});

test("does not promote a multi-phase or dependency-rearmed reveal sink", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Screen({ enabled }: { enabled: boolean }) {
        const [phase, setPhase] = useState(0);
        useEffect(() => {
          const handle = requestAnimationFrame(() => { setPhase(1); setPhase(2); });
          return () => cancelAnimationFrame(handle);
        }, [enabled]);
        return phase > 0 ? <HeavyLeaf /> : <Placeholder />;
      }
    `),
    ["keep-state", "keep-effect"],
  );
});

test("does not promote deferred booleans used outside a render-selecting gate", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Screen({ label }: { label: string }) {
        const [ready, setReady] = useState(false);
        useEffect(() => {
          const handle = requestIdleCallback(() => setReady(true));
          return () => cancelIdleCallback(handle);
        }, []);
        if (ready) reportReady();
        return <div>{label && ready}</div>;
      }
    `),
    ["keep-state", "keep-effect"],
  );
});

test("does not promote an unreachable nested deferred setter or shadowed cleanup handle", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Screen() {
        const [ready, setReady] = useState(false);
        useEffect(() => {
          const handle = requestIdleCallback(() => {
            const never = () => setReady(true);
          });
          return (handle = 1) => cancelIdleCallback(handle);
        }, []);
        return ready ? <HeavyLeaf /> : <Placeholder />;
      }
    `),
    ["keep-state", "keep-effect"],
  );
});

test("matches deferred reveal setters independently in different owners", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function First() {
      const [ready, setReady] = useState(false);
      useEffect(() => { const h = requestIdleCallback(() => setReady(true)); return () => cancelIdleCallback(h); }, []);
      return ready ? <FirstLeaf /> : null;
    }
    export function Second() {
      const [ready, setReady] = useState(false);
      useEffect(() => { const h = requestAnimationFrame(() => setReady(true)); return () => cancelAnimationFrame(h); }, []);
      return ready ? <SecondLeaf /> : null;
    }
  `,
    "fixture.tsx",
  );
  assert.deepEqual(
    findings.filter((finding) => finding.hook === "useState").map((finding) => finding.action),
    ["use-observable", "use-observable"],
  );
});
