import type { HookFinding } from "../../src/core/types.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

function states(source: string): HookFinding[] {
  return analyzeSource(source, "fixture.tsx").filter((finding) => finding.hook === "useState");
}

test("keeps effect-written state whose reads render an already-small owner", () => {
  const findings = states(`
    import { useEffect, useRef, useState } from "react";
    import { clsx } from "clsx";
    export function Flash({ nonce, message }: { nonce: number; message: string }) {
      const [isAnimating, setIsAnimating] = useState(false);
      const timer = useRef(0);
      useEffect(() => {
        setIsAnimating(true);
        timer.current = window.setTimeout(() => setIsAnimating(false), 1000);
        return () => window.clearTimeout(timer.current);
      }, [nonce]);
      return <div className={clsx("flash", { shake: isAnimating })}>{message}</div>;
    }
    export function Status({ id }: { id: string }) {
      const [label, setLabel] = useState("");
      useEffect(() => {
        let cancelled = false;
        void loadLabel(id).then((next) => {
          if (!cancelled) setLabel(next);
        });
        return () => {
          cancelled = true;
        };
      }, [id]);
      if (!label) {
        return null;
      }
      return <output title={label}>{label.toUpperCase()}</output>;
    }
    export function Counter({ value }: { value: number }) {
      const [display, setDisplay] = useState(value);
      useEffect(() => {
        let frame = 0;
        const tick = () => {
          setDisplay((current) => Math.min(value, current + 1));
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
      }, [value]);
      return <span className="count">{display}</span>;
    }
  `);
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["keep-state", "keep-state", "keep-state"],
  );
  for (const finding of findings) {
    assert.equal(finding.confidence, "certain");
    assert.match(finding.message, /already a small render boundary/u);
  }
});

test("settles effect-written state that leaves the small owner's own render by its render proof", () => {
  const findings = states(`
    import { createContext, useEffect, useMemo, useState } from "react";
    const KeyboardContext = createContext({ height: 0 });
    export function KeyboardProvider({ children }: { children: React.ReactNode }) {
      const [height, setHeight] = useState(0);
      useEffect(() => {
        const listener = Keyboard.addListener("show", (event) => setHeight(event.height));
        return () => listener.remove();
      }, []);
      const value = useMemo(() => ({ height }), [height]);
      return <KeyboardContext.Provider value={value}>{children}</KeyboardContext.Provider>;
    }
    export function useReady() {
      const [ready, setReady] = useState(false);
      useEffect(() => {
        const handle = scheduleAfterTransition(() => setReady(true));
        return () => handle.cancel();
      }, []);
      return ready;
    }
    export function Derived({ id }: { id: string }) {
      const [record, setRecord] = useState<{ name: string } | null>(null);
      useEffect(() => {
        void load(id).then((next) => setRecord(next));
      }, [id]);
      const label = format(record);
      return <span>{label}</span>;
    }
    export function Transported({ id }: { id: string }) {
      const [record, setRecord] = useState<{ name: string } | null>(null);
      useEffect(() => {
        void load(id).then((next) => setRecord(next));
      }, [id]);
      return <Card record={record} />;
    }
    export function Broad({ id }: { id: string }) {
      const [record, setRecord] = useState<{ name: string } | null>(null);
      useEffect(() => {
        void load(id).then((next) => setRecord(next));
      }, [id]);
      return (
        <section>
          <header><h1>Title</h1><p>Intro</p></header>
          <p>{record?.name}</p>
          <footer><button>Ok</button></footer>
        </section>
      );
    }
  `);
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["keep-state", "review-state", "review-state", "review-state", "use-observable"],
  );
  assert.deepEqual(
    findings.slice(1, 4).map((finding) => finding.abstentionReason),
    ["render-cut-unproven", "effect-write-ownership-unresolved", "child-contract-unresolved"],
  );
});
