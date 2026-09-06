import type { HookFinding } from "../../src/core/types.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

function findings(source: string): HookFinding[] {
  return analyzeSource(source, "fixture.tsx");
}

test("keeps effects whose every local state dependency is kept as React state", () => {
  const results = findings(`
    import { useEffect, useState } from "react";
    import { flush, track } from "./telemetry";
    export function Flash({ nonce }: { nonce: number }) {
      const [isAnimating, setIsAnimating] = useState(false);
      useEffect(() => {
        setIsAnimating(true);
      }, [nonce]);
      return <div className={isAnimating ? "shake" : ""}>{nonce}</div>;
    }
    export function Toggle() {
      const [open, setOpen] = useState(false);
      useEffect(() => {
        track(open);
        flush();
      }, [open]);
      return <button onClick={() => setOpen(!open)}>{open ? "close" : "open"}</button>;
    }
  `);
  assert.deepEqual(
    results.map((finding) => `${finding.hook}:${finding.action}`),
    [
      "useState:keep-state",
      "useEffect:keep-effect",
      "useState:keep-state",
      "useEffect:keep-effect",
    ],
  );
  for (const finding of results.filter((candidate) => candidate.hook === "useEffect")) {
    assert.equal(finding.confidence, "certain");
    assert.match(finding.message, /stays React state in this owner/u);
  }
});

test("leaves effects under review while their state is under review or partly opaque", () => {
  const results = findings(`
    import { useEffect, useState } from "react";
    import { flush, track } from "./telemetry";
    export function Broad({ nonce }: { nonce: number }) {
      const [isAnimating, setIsAnimating] = useState(false);
      useEffect(() => {
        setIsAnimating(true);
      }, [nonce]);
      return (
        <section className={isAnimating ? "shake" : ""}>
          <header><h1>Title</h1><p>Intro</p></header>
          <main><p>Body</p><p>More</p></main>
          <footer><button>Ok</button></footer>
        </section>
      );
    }
    export function Opaque({ nonce }: { nonce: number }) {
      const [isAnimating, setIsAnimating] = useState(false);
      let label = String(nonce);
      useEffect(() => {
        setIsAnimating(true);
        track(label);
      }, [nonce]);
      return <div className={isAnimating ? "shake" : ""}>{label}</div>;
    }
  `);
  assert.deepEqual(
    results.map((finding) => `${finding.hook}:${finding.action}`),
    [
      "useState:review-state",
      "useEffect:review-effect",
      "useState:keep-state",
      "useEffect:review-effect",
    ],
  );
  assert.equal(results[1]?.abstentionReason, "effect-write-ownership-unresolved");
  assert.equal(results[3]?.abstentionReason, "effect-write-ownership-unresolved");
});
