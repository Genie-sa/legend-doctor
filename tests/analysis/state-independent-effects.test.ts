import type { HookFinding } from "../../src/core/types.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

function effects(source: string): HookFinding[] {
  return analyzeSource(source, "fixture.tsx").filter((finding) => finding.hook === "useEffect");
}

test("keeps dependency effects whose inputs are props, refs, module bindings, and hook results", () => {
  const findings = effects(`
    import React, { useCallback, useEffect, useMemo, useRef } from "react";
    import { useTranslation } from "react-i18next";
    import { renderScene, CACHE } from "./scene";
    export function Canvas(props: { scale: number; elements: string[]; onReady?: () => void }) {
      const canvasRef = useRef<HTMLCanvasElement>(null);
      const mounted = useRef(false);
      const { elements } = props;
      const visible = useMemo(() => elements.filter((element) => element !== ""), [elements]);
      const { t } = useTranslation();
      const label = t("scene");
      function describe(count: number) {
        return label + count;
      }
      useEffect(() => {
        if (!canvasRef.current) return;
        if (!mounted.current) {
          mounted.current = true;
          return;
        }
        for (const element of visible) {
          if (!CACHE.has(element)) CACHE.set(element, describe(visible.length));
        }
        renderScene({ canvas: canvasRef.current, scale: props.scale, elements: visible });
        props.onReady?.();
      }, [props.scale, visible, props.onReady, label]);
      return <canvas ref={canvasRef} />;
    }
    export function Dialog({ open, setDialogState }: { open: boolean; setDialogState: (next: { isOpen: boolean }) => void }) {
      useEffect(() => {
        if (open) setDialogState({ isOpen: false });
        window.dispatchEvent(new CustomEvent("dialog", { detail: open }));
      }, [open, setDialogState]);
      return null;
    }
    export function Loader({ id, client }: { id: string; client: { load: (id: string) => Promise<void> } }) {
      const load = useCallback(async () => {
        await client.load(id);
      }, [client, id]);
      useEffect(() => {
        void load();
        void load();
      }, [load]);
      return null;
    }
    export function Hook({ query }: { query: string }) {
      const results = useSearch(query);
      React.useEffect(() => {
        window.analytics?.track("search", { total: results.length });
        window.analytics?.flush();
      }, [results]);
      return null;
    }
  `);
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["keep-effect", "keep-effect", "keep-effect", "keep-effect"],
  );
  for (const finding of findings) {
    assert.equal(finding.confidence, "certain");
    assert.match(
      finding.message,
      /reads only props, refs, module bindings, and external hook results/u,
    );
  }
});

test("reviews dependency effects scheduled by local React state directly or through owner bindings", () => {
  const findings = effects(`
    import { useCallback, useEffect, useMemo, useState } from "react";
    import { flush, report } from "./telemetry";
    export function Direct({ onChange }: { onChange: (value: string) => void }) {
      const [value, setValue] = useState("");
      useEffect(() => { onChange(value); flush(); }, [onChange, value]);
      return <section><h1>Title</h1><p>Intro</p><p>Body</p><p>More</p><input value={value} onChange={(event) => setValue(event.target.value)} /></section>;
    }
    export function ThroughMemo({ items }: { items: string[] }) {
      const [query, setQuery] = useState("");
      const filtered = useMemo(() => items.filter((item) => item.includes(query)), [items, query]);
      useEffect(() => { report(filtered); flush(); }, [filtered]);
      return <section><h1>Title</h1><p>Intro</p><p>Body</p><p>More</p><input value={query} onChange={(event) => setQuery(event.target.value)} /></section>;
    }
    export function ThroughConst({ items }: { items: string[] }) {
      const [query, setQuery] = useState("");
      const filtered = items.filter((item) => item.includes(query));
      useEffect(() => { report(filtered); flush(); }, [filtered]);
      return <section><h1>Title</h1><p>Intro</p><p>Body</p><p>More</p><input value={query} onChange={(event) => setQuery(event.target.value)} /></section>;
    }
    export function ThroughCallback({ items }: { items: string[] }) {
      const [query, setQuery] = useState("");
      const send = useCallback(() => report(query), [query]);
      useEffect(() => { send(); flush(); }, [items, send]);
      return <section><h1>Title</h1><p>Intro</p><p>Body</p><p>More</p><input value={query} onChange={(event) => setQuery(event.target.value)} /></section>;
    }
  `);
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["review-effect", "review-effect", "review-effect", "review-effect"],
  );
  for (const finding of findings) {
    assert.equal(finding.abstentionReason, "effect-causal-owner-unresolved");
    assert.match(finding.message, /reacts to React state `(?:value|query)`/u);
  }
});

test("keeps prop-scheduled effects that only snapshot local React state or Legend values", () => {
  const findings = effects(`
    import { useEffect, useState } from "react";
    import { useValue } from "@legendapp/state/react";
    import { flush, report } from "./telemetry";
    export function BodyOnly({ tick }: { tick: number }) {
      const [value, setValue] = useState("");
      useEffect(() => { report(value); flush(); }, [tick]);
      return <section><h1>Title</h1><p>Intro</p><p>Body</p><p>More</p><input value={value} onChange={(event) => setValue(event.target.value)} /></section>;
    }
    export function ThroughFunction({ items }: { items: string[] }) {
      const [query, setQuery] = useState("");
      function current() { return query; }
      useEffect(() => { report(current()); flush(); }, [items]);
      return <section><h1>Title</h1><p>Intro</p><p>Body</p><p>More</p><input value={query} onChange={(event) => setQuery(event.target.value)} /></section>;
    }
    export function LegendHandle({ value, count$ }: { value: string; count$: { get: () => number } }) {
      const count = useValue(count$);
      useEffect(() => { report(count + value.length); flush(); }, [value]);
      return <span>{count}</span>;
    }
  `);
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["keep-effect", "keep-effect", "keep-effect"],
  );
  for (const finding of findings) {
    assert.equal(finding.confidence, "probable");
    assert.match(finding.message, /read of `(?:value|query|count)` is a snapshot/u);
  }
});

test("reviews dependency effects that write local React state directly or through owner functions", () => {
  const findings = effects(`
    import { useCallback, useEffect, useState } from "react";
    import { load } from "./resource";
    export function Sync({ color }: { color: string }) {
      const [inner, setInner] = useState(color);
      useEffect(() => { setInner(color); }, [color]);
      return <section><h1>Title</h1><p>Intro</p><p>Body</p><p>More</p><input value={inner} onChange={(event) => setInner(event.target.value)} /></section>;
    }
    export function Nested({ id }: { id: string }) {
      const [data, setData] = useState<string | null>(null);
      useEffect(() => {
        let cancelled = false;
        load(id).then((next) => { if (!cancelled) setData(next); });
        return () => { cancelled = true; };
      }, [id]);
      const [other, setOther] = useState("");
      useEffect(() => {
        void load(id).then((next) => setOther(next));
      }, [id]);
      return <section><h1>Title</h1><p>Intro</p><p>Body</p><p>More</p><output>{data}{other}</output></section>;
    }
    export function Helper({ id }: { id: string }) {
      const [data, setData] = useState<string | null>(null);
      const refresh = useCallback(async () => setData(await load(id)), [id]);
      useEffect(() => { void refresh(); }, [refresh]);
      return <section><h1>Title</h1><p>Intro</p><p>Body</p><p>More</p><output>{data}</output></section>;
    }
  `);
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["review-effect", "keep-effect", "keep-effect", "review-effect"],
  );
  assert.equal(requireValue(findings[0]).abstentionReason, "paired-draft-effect-preserved");
  assert.match(requireValue(findings[2]).message, /`other`.*rewrite the setter calls/u);
  assert.equal(requireValue(findings[3]).abstentionReason, "effect-write-ownership-unresolved");
  assert.match(requireValue(findings[3]).message, /writes React state `data`/u);
});

test("does not prove independence across shadowed, mutable, enclosing, or non-tuple state bindings", () => {
  const findings = effects(`
    import { useEffect, useReducer, useState } from "react";
    import { flush, report } from "./telemetry";
    export function Shadowed({ value }: { value: string }) {
      const [count, setCount] = useState(0);
      useEffect(() => {
        const count = value.length;
        report(count);
        flush();
      }, [value]);
      return <button onClick={() => setCount(count + 1)}>{count}</button>;
    }
    export function Mutable({ value }: { value: string }) {
      let label = value;
      useEffect(() => { report(label); flush(); }, [value]);
      return null;
    }
    export function Outer() {
      const [count, setCount] = useState(0);
      function Inner({ value }: { value: string }) {
        useEffect(() => { report(count + value.length); flush(); }, [value]);
        return null;
      }
      return <button onClick={() => setCount(count + 1)}><Inner value="x" /></button>;
    }
    export function Reducer({ value }: { value: string }) {
      const [state, dispatch] = useReducer((current: number) => current + 1, 0);
      useEffect(() => { report(state + value.length); flush(); }, [value]);
      return <button onClick={dispatch}>{state}</button>;
    }
    export function NonTuple({ value }: { value: string }) {
      const pair = useState(0);
      useEffect(() => { report(pair[0] + value.length); flush(); }, [value]);
      return null;
    }
  `);
  assert.deepEqual(
    findings.map((finding) => finding.action),
    Array.from({ length: 5 }, () => "review-effect"),
  );
  for (const finding of findings) {
    assert.equal(finding.abstentionReason, "effect-causal-owner-unresolved");
    assert.match(finding.message, /before choosing React lifecycle/u);
  }
});
