import { actions, requireValue } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

test("keeps effects that operate on committed refs", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useRef, useState } from "react";
      export function Screen({ open }: { open: boolean }) {
        const inputRef = useRef<HTMLInputElement>(null);
        const containerRef = useRef<HTMLDivElement>(null);
        const [container, setContainer] = useState<HTMLDivElement | null>(null);
        useEffect(() => { inputRef.current?.focus(); }, [open]);
        useEffect(() => { setContainer(containerRef.current); }, [containerRef]);
        useEffect(() => { setTimeout(() => inputRef.current?.focus(), 0); }, []);
        return <><input ref={inputRef} /><div ref={containerRef}>{container?.id}</div></>;
      }
    `),
    ["keep-state", "keep-effect", "keep-effect", "keep-effect"],
  );
});

test("keeps committed-ref integrations through immutable receiver aliases", () => {
  const effects = analyzeSource(
    `
    import { useEffect, useRef } from "react";
    export function Safe({ index }: { index: number }) {
      const listRef = useRef<HTMLDivElement>(null);
      useEffect(() => {
        if (!listRef.current) return;
        const items = listRef.current.querySelectorAll("[role=option]");
        items[index]?.scrollIntoView({ block: "nearest" });
      }, [index]);
      return <div ref={listRef} />;
    }
    export function Escaped({ index }: { index: number }) {
      const listRef = useRef<HTMLDivElement>(null);
      useEffect(() => {
        if (!listRef.current) return;
        const items = listRef.current.querySelectorAll("[role=option]");
        publish(items);
        items[index]?.scrollIntoView();
      }, [index]);
      return <div ref={listRef} />;
    }
    export function ImpureIndex({ index }: { index: number }) {
      const listRef = useRef<HTMLDivElement>(null);
      useEffect(() => {
        if (!listRef.current) return;
        const items = listRef.current.querySelectorAll("[role=option]");
        items[normalize(index)]?.scrollIntoView();
      }, [index]);
      return <div ref={listRef} />;
    }
    export function Noop({ index }: { index: number }) {
      const listRef = useRef<HTMLDivElement>(null);
      useEffect(() => { if (index < 0) return; }, [index]);
      return <div ref={listRef} />;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.hook === "useEffect");
  assert.deepEqual(
    effects.map((finding) => finding.action),
    ["keep-effect", "keep-effect", "keep-effect", "keep-effect"],
  );
  assert.match(requireValue(effects[0]).message, /committed ref/iu);
  for (const finding of effects.slice(1)) {
    assert.doesNotMatch(finding.message, /committed ref/iu);
    assert.match(finding.message, /reads only props/u);
  }
});

test("keeps exact latest-value ref mirrors in React post-commit timing", () => {
  const findings = analyzeSource(
    `
    import React, { useEffect, useRef as useLatestRef } from "react";
    export function Named({ value }: { value: string }) {
      const latest = useLatestRef(value);
      useEffect(() => { latest.current = value; }, [value]);
      return null;
    }
    export function Namespace({ items }: { items: string[] }) {
      const count = React.useRef(items.length);
      React.useEffect(() => { count.current = items.length; }, [items.length]);
      return null;
    }
    export function EveryCommit({ value }: { value: string }) {
      const previous = React.useRef(value);
      React.useEffect(() => { previous.current = value; });
      return null;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.hook === "useEffect");
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["keep-effect", "keep-effect", "keep-effect"],
  );
  for (const finding of findings) {
    assert.match(finding.message, /committed ref/iu);
  }
});

test("keeps exact committed previous-value guards in React post-commit timing", () => {
  const effects = analyzeSource(
    `
    import React, { useEffect, useRef } from "react";
    export function Exact({ value }: { value: string }) {
      const previous = useRef(value);
      useEffect(() => {
        if (previous.current === value) return;
        previous.current = value;
        synchronize(value);
      }, [value]);
      return null;
    }
    export function BlockReturn({ value }: { value: string }) {
      const previous = React.useRef(value);
      React.useEffect(() => {
        if (previous.current === value) { return; }
        previous.current = value;
        synchronize(value);
      }, [value]);
      return null;
    }
    export function WrongInitializer({ value, other }: { value: string; other: string }) {
      const previous = useRef(other);
      useEffect(() => {
        if (previous.current === value) return;
        previous.current = value;
        synchronize(value);
      }, [value]);
      return null;
    }
    export function WrongDependency({ value, other }: { value: string; other: string }) {
      const previous = useRef(value);
      useEffect(() => {
        if (previous.current === value) return;
        previous.current = value;
        synchronize(value);
      }, [other]);
      return null;
    }
    export function MutableRef({ value }: { value: string }) {
      let previous = useRef(value);
      useEffect(() => {
        if (previous.current === value) return;
        previous.current = value;
        synchronize(value);
      }, [value]);
      return null;
    }
    export function WorkBeforeGuard({ value }: { value: string }) {
      const previous = useRef(value);
      useEffect(() => {
        report(value);
        if (previous.current === value) return;
        previous.current = value;
        synchronize(value);
      }, [value]);
      return null;
    }
    export function DelayedCommit({ value }: { value: string }) {
      const previous = useRef(value);
      useEffect(() => {
        if (previous.current === value) return;
        synchronize(value);
        previous.current = value;
      }, [value]);
      return null;
    }
    export function Async({ value }: { value: string }) {
      const previous = useRef(value);
      useEffect(async () => {
        if (previous.current === value) return;
        previous.current = value;
        await synchronize(value);
      }, [value]);
      return null;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.hook === "useEffect");
  assert.deepEqual(
    effects.map((finding) => finding.action),
    [
      "keep-effect",
      "keep-effect",
      "keep-effect",
      "keep-effect",
      "review-effect",
      "keep-effect",
      "keep-effect",
      "keep-effect",
    ],
  );
  for (const finding of effects.slice(0, 2)) {
    assert.match(finding.message, /committed ref/iu);
  }
  for (const finding of effects.slice(2)) {
    assert.doesNotMatch(finding.message, /committed ref/iu);
  }
});
