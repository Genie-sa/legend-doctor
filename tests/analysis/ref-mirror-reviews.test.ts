import { actions } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

test("reviews unproven or behaviorally different ref mirror effects", () => {
  const effects = analyzeSource(
    `
    import { useEffect, useRef } from "react";
    export function WrongDependency({ value, other }: { value: string; other: string }) {
      const latest = useRef(value);
      useEffect(() => { latest.current = value; }, [other]);
      return null;
    }
    export function EmptyDependency({ value }: { value: string }) {
      const firstCommit = useRef(value);
      useEffect(() => { firstCommit.current = value; }, []);
      return null;
    }
    export function ExtraWork({ value }: { value: string }) {
      const latest = useRef(value);
      useEffect(() => { latest.current = value; report(value); }, [value]);
      return null;
    }
    export function Compound({ value }: { value: number }) {
      const total = useRef(value);
      useEffect(() => { total.current += value; }, [value]);
      return null;
    }
    export function Shadowed({ value, useRef }: { value: string; useRef: (value: string) => { current: string } }) {
      const latest = useRef(value);
      useEffect(() => { latest.current = value; }, [value]);
      return null;
    }
    export function SelfRead() {
      const latest = useRef(0);
      useEffect(() => { latest.current = latest.current; }, [latest.current]);
      return null;
    }
    export function RepeatedCall() {
      const latest = useRef(0);
      useEffect(() => { latest.current = read(); }, [read()]);
      return null;
    }
    export function EveryCommitCall() {
      const latest = useRef(0);
      useEffect(() => { latest.current = read(); });
      return null;
    }
    export function EveryCommitSelfRead() {
      const latest = useRef(0);
      useEffect(() => { latest.current = latest.current; });
      return null;
    }
    export function EveryCommitGuard({ enabled, value }: { enabled: boolean; value: string }) {
      const latest = useRef(value);
      useEffect(() => {
        if (enabled) latest.current = value;
      });
      return null;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.hook === "useEffect");
  assert.deepEqual(
    effects.map((finding) => finding.action),
    [
      "keep-effect",
      "review-effect",
      "keep-effect",
      "keep-effect",
      "keep-effect",
      "keep-effect",
      "keep-effect",
      "review-effect",
      "review-effect",
      "review-effect",
    ],
  );
  for (const finding of effects) {
    assert.doesNotMatch(finding.message, /committed ref/iu);
  }
});

test("keeps a forwarded ref snapshot in React post-commit timing", () => {
  assert.deepEqual(
    actions(`
      import { type RefObject, useEffect, useState } from "react";
      export function Grid({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
        const [container, setContainer] = useState<HTMLElement | null>(null);
        useEffect(() => {
          setContainer(containerRef.current);
        }, [containerRef]);
        return <VirtualGrid container={container} />;
      }
    `),
    ["review-state", "keep-effect"],
  );
});

test("reviews empty ref effects that intentionally capture a render snapshot", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useRef } from "react";
      export function Screen({ scrollPosition }: { scrollPosition: number }) {
        const containerRef = useRef<HTMLDivElement>(null);
        useEffect(() => {
          if (scrollPosition > 0) containerRef.current?.scrollTo(0, scrollPosition);
        }, []);
        return <div ref={containerRef} />;
      }
    `),
    ["review-effect"],
  );
});

test("keeps a direct latest-value ref mirror in post-commit timing", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useRef } from "react";
      export function Screen({ value }: { value: string }) {
        const latest = useRef(value);
        useEffect(() => { latest.current = value; }, [value]);
        return null;
      }
    `),
    ["keep-effect"],
  );
});
