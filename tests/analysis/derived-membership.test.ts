import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("does not move a derived keyed alias read by an effect", () => {
  const source = `
    import { useEffect, useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      useEffect(() => report(selected.size), [selected]);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview />{rows.map(row => <Row key={row.id} selected={selected.has(row.id)} />)}</main>;
    }
  `;
  const finding = analyzeSource(source, "screen.tsx").find(
    (candidate) => candidate.name === "selected",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("requires derived membership to use the repeated row key", () => {
  const source = `
    import { useState } from "react";
    export function Screen({ rows, activeId }: { rows: Array<{ id: string }>; activeId: string }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview />{rows.map(row => <Row key={row.id} selected={selected.has(activeId)} />)}</main>;
    }
  `;
  const finding = analyzeSource(source, "screen.tsx").find(
    (candidate) => candidate.name === "selected",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("requires a stable item-derived key for mapped membership", () => {
  const source = `
    import { useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview />{rows.map((row, index) => <Row key={index} selected={selected.has(row.id)} />)}</main>;
    }
  `;
  const finding = analyzeSource(source, "screen.tsx").find(
    (candidate) => candidate.name === "selected",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("does not treat render-prop reads as selection commands", () => {
  const source = `
    import { useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview /><Panel renderLabel={() => Array.from(selected).join(",")} />
        {rows.map(row => <Row key={row.id} selected={selected.has(row.id)} />)}</main>;
    }
  `;
  const finding = analyzeSource(source, "screen.tsx").find(
    (candidate) => candidate.name === "selected",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("requires immutable aliases and a stable filter membership source", () => {
  const mutable = `
    import { useState } from "react";
    export function Screen({ rows, visible }: { rows: Array<{ id: string }>; visible: Set<string> }) {
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      let active = selectedIds.filter(id => visible.has(id));
      let selected = new Set(active);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview />{rows.map(row => <Row key={row.id} selected={selected.has(row.id)} />)}</main>;
    }
  `;
  const opaque = mutable
    .replace("let active", "const active")
    .replace("let selected", "const selected")
    .replace("visible.has(id)", "registry().has(id)");
  for (const source of [mutable, opaque]) {
    const finding = analyzeSource(source, "screen.tsx").find(
      (candidate) => candidate.name === "selectedIds",
    );
    assert.notEqual(requireValue(finding).action, "use-observable");
  }
});

test("does not place a collection summary subscription inside every row", () => {
  const source = `
    import { useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview />{rows.map(row => <section key={row.id}>
          <Row selected={selected.has(row.id)} /><span>{selected.size}</span>
        </section>)}</main>;
    }
  `;
  const finding = analyzeSource(source, "screen.tsx").find(
    (candidate) => candidate.name === "selected",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("does not move lifecycle membership that controls whether a row exists", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function PremountedSteps({ steps }: { steps: string[] }) {
      const [mounted, setMounted] = useState<Set<number>>(() => new Set([0]));
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        {steps.map((step, index) => {
          if (!mounted.has(index)) return null;
          return <Step key={step} onReady={() => setMounted(previous => new Set(previous).add(index))} />;
        })}
      </Screen>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("does not bypass keyed mount-control checks through a local boolean alias", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function FilteredRows({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        {rows.map(row => {
          const shown = selected.has(row.id);
          if (!shown) return null;
          return <Row key={row.id} onPress={() => setSelected(new Set([row.id]))} />;
        })}
      </Screen>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("converts a custom-hook selection cluster into one observable model", () => {
  const findings = analyzeSource(
    `
    import { useCallback, useState } from "react";
    export function useSelection<T>() {
      const [selecting, setSelecting] = useState(false);
      const [selected, setSelected] = useState<Set<T>>(() => new Set<T>());
      const toggle = useCallback((id: T) => {
        setSelecting(true);
        setSelected(previous => new Set(previous).add(id));
      }, []);
      return { selecting, selected, toggle };
    }
  `,
    "fixture.ts",
  );
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["use-observable", "use-observable"],
  );
  assert.ok(
    findings.every((finding) => requireValue(finding.stateModel).ownership === "local-observable"),
  );
});

test("does not call an ordinary custom-hook Set resource a selection model without a setter", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function useCache() {
      const [cache] = useState<Set<string>>(() => new Set());
      return cache;
    }
  `,
    "fixture.ts",
  );
  assert.equal(requireValue(finding).action, "keep-state");
});

test("does not call custom-hook lifecycle bookkeeping a selection model", () => {
  const [finding] = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function usePremountedSteps(step: number) {
      const [mounted, setMounted] = useState<ReadonlySet<number>>(() => new Set([step]));
      useEffect(() => { setMounted(previous => new Set(previous).add(step)); }, [step]);
      return mounted;
    }
  `,
    "fixture.ts",
  );
  assert.equal(requireValue(finding).action, "review-state");
});
