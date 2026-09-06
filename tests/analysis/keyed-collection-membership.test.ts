import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("moves keyed collection membership into repeated row subscriptions", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function SelectionScreen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      const toggle = (id: string) => setSelected(previous => {
        const next = new Set(previous);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
      return <Screen><Header /><Toolbar /><Summary count={selected.size} /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        {rows.map(row => <Row key={row.id} selected={selected.has(row.id)} onPress={() => toggle(row.id)} />)}
      </Screen>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /per-row/u);
});

test("isolates keyed selection with select-all and partial-selection summaries", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    export function SelectionScreen({ rows }: { rows: Array<{ id: string }> }) {
      const [page, setPage] = useState(1);
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      const allSelected = rows.length > 0 && rows.every(row => selected.has(row.id));
      const someSelected = rows.some(row => selected.has(row.id));
      const toggleOne = (id: string) => setSelected(previous => {
        const next = new Set(previous);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
      const reset = () => { setPage(1); setSelected(new Set()); };
      return <Screen><Header checked={allSelected ? true : someSelected ? "indeterminate" : false} />
        <Toolbar /><Summary count={selected.size} /><Filters /><Actions onReset={reset} /><Status />
        <Help /><Footer page={page} /><Sidebar /><Banner /><Search />
        {rows.map(row => <Row key={row.id} selected={selected.has(row.id)} onPress={() => toggleOne(row.id)} />)}
      </Screen>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "selected");
  assert.equal(requireValue(finding).action, "use-observable");
});

test("uses keyed collection behavior rather than state names", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    export function Gallery({ rows }: { rows: Array<{ id: string; src: string }> }) {
      const [failures, setFailures] = useState<Set<string>>(() => new Set());
      const markFailed = (id: string) => setFailures(previous => new Set(previous).add(id));
      return <Screen><Header /><Toolbar /><Summary count={failures.size} /><Filters /><Actions />
        <Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        {rows.map(row => <ImageRow key={row.id} fallback={failures.has(row.id)} onError={() => markFailed(row.id)} />)}
      </Screen>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "failures");
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /per-row/u);
});

test("rejects lifecycle and mount-control collections without name heuristics", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function LifecycleRows({ rows }: { rows: Array<{ id: string }> }) {
      const [mounted, setMounted] = useState<Set<string>>(() => new Set());
      useEffect(() => setMounted(new Set(rows.map(row => row.id))), [rows]);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer />
        <Sidebar /><Banner /><Search />
        {rows.map(row => mounted.has(row.id) && <Row key={row.id} />)}
      </Screen>;
    }
    export function FailedRows({ rows }: { rows: Array<{ id: string }> }) {
      const [failed, setFailed] = useState<Set<string>>(() => new Set());
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer />
        <Sidebar /><Banner /><Search />
        {rows.map(row => !failed.has(row.id) && <Row key={row.id} onError={() => setFailed(new Set([row.id]))} />)}
      </Screen>;
    }
  `,
    "fixture.tsx",
  );
  for (const name of ["mounted", "failed"]) {
    assert.notEqual(
      requireValue(findings.find((candidate) => candidate.name === name)).action,
      "use-observable",
    );
  }
});

test("keeps keyed selection when summary membership controls row mounting", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    export function SelectionScreen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      const anySelected = rows.some(row => selected.has(row.id));
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer />
        <Sidebar /><Banner /><Search />
        {anySelected && rows.map(row => <Row key={row.id} selected={selected.has(row.id)} onPress={() => setSelected(new Set([row.id]))} />)}
      </Screen>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "selected");
  assert.equal(requireValue(finding).action, "review-state");
});

test("requires a synchronous event-rooted collection update without hidden React work", () => {
  for (const update of [
    `const markDirty = () => setDirty(true);
     const toggle = (id: string) => { setSelected(new Set([id])); markDirty(); };`,
    `const toggle = (id: string) => { setTimeout(() => setSelected(new Set([id])), 10); };`,
    `const markDirty = () => setDirty(true);
     const toggle = (id: string) => setSelected(previous => {
       markDirty();
       return new Set(previous).add(id);
     });`,
  ]) {
    const finding = analyzeSource(
      `
      import { useState } from "react";
      export function SelectionScreen({ rows }: { rows: Array<{ id: string }> }) {
        const [dirty, setDirty] = useState(false);
        const [selected, setSelected] = useState<Set<string>>(() => new Set());
        ${update}
        return <Screen><Header dirty={dirty} /><Toolbar /><Summary count={selected.size} /><Filters /><Actions />
          <Status /><Help /><Footer /><Sidebar /><Banner /><Search />
          {rows.map(row => <Row key={row.id} selected={selected.has(row.id)} onPress={() => toggle(row.id)} />)}
        </Screen>;
      }
    `,
      "fixture.tsx",
    ).find((candidate) => candidate.name === "selected");
    assert.equal(requireValue(finding).action, "review-state");
  }
});

test("recognizes an array selection normalized by one immutable local Set", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function SelectionScreen({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      const selectedIdSet = new Set(selectedIds);
      const selectedCount = selectedIds.length;
      const toggle = (id: string) => setSelectedIds(previous =>
        previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]
      );
      const submit = () => save(selectedIds);
      return <Screen><Header /><Toolbar count={selectedCount} /><Summary /><Filters /><Actions onSubmit={submit} />
        <Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        {rows.map(row => <Row key={row.id} selected={selectedIdSet.has(row.id)} onPress={() => toggle(row.id)} />)}
      </Screen>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /per-row/u);
});

test("requires an immutable non-escaping Set normalization for array selection", () => {
  const mutable = `
    import { useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      let selectedIdSet = new Set(selectedIds);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview />{rows.map(row => <Row key={row.id} selected={selectedIdSet.has(row.id)} />)}</main>;
    }
  `;
  const escaped = mutable
    .replace("let selectedIdSet", "const selectedIdSet")
    .replace("return <main>", "inspect(selectedIdSet); return <main>");
  for (const source of [mutable, escaped]) {
    const finding = analyzeSource(source, "screen.tsx").find(
      (candidate) => candidate.name === "selectedIds",
    );
    assert.notEqual(requireValue(finding).action, "use-observable");
  }
});

test("does not move array selection when a summary alias controls repeated mounting", () => {
  const source = `
    import { useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      const selectedIdSet = new Set(selectedIds);
      const hasSelection = selectedIds.length > 0;
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview />{rows.map(row => hasSelection &&
          <Row key={row.id} selected={selectedIdSet.has(row.id)} />)}</main>;
    }
  `;
  const finding = analyzeSource(source, "screen.tsx").find(
    (candidate) => candidate.name === "selectedIds",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});
