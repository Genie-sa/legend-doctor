import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("isolates row selection and a selected-item footer into separate subscribers", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    export function Results({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      const selected = rows.find(row => row.id === selectedId) ?? null;
      const accept = () => selected && save(selected);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Status /><Help />
        <Sidebar /><Banner /><Search /><Preview />
        {rows.map(row => <Row key={row.id} selected={selectedId === row.id}
          onPress={() => setSelectedId(row.id)} />)}
        <Footer disabled={!selected} onAccept={accept} />
      </Screen>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "selectedId");
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /footer or detail/u);
});

test("isolates a row-selected id and its non-null footer summary", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    export function Results({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      const hasSelection = selectedId !== null;
      const accept = () => selectedId && save(selectedId);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Status /><Help />
        <Sidebar /><Banner /><Search /><Preview />
        {rows.map(row => <Row key={row.id} selected={selectedId === row.id}
          onPress={() => setSelectedId(row.id)} />)}
        <Footer enabled={hasSelection} onAccept={accept} />
      </Screen>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "selectedId");
  assert.equal(requireValue(finding).action, "use-observable");
});

test("isolates a repeated row command and one selected-item detail leaf", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    export function Results({ rows, loading }: { rows: Array<{ id: string }>; loading: boolean }) {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      const selected = rows.find(row => row.id === selectedId) ?? null;
      if (loading) return <Loading />;
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Status /><Help />
        <Sidebar /><Banner /><Search /><Preview />
        {rows.map(row => <Row key={row.id} onPress={() => setSelectedId(row.id)} />)}
        <Detail item={selected} open={selected !== null} onClose={() => setSelectedId(null)} />
      </Screen>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "selectedId");
  assert.equal(requireValue(finding).action, "use-observable");
});

test("isolates an object selection payload across keyed rows and one footer", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    type Item = { id: string; disabled: boolean };
    export function Results({ rows }: { rows: Item[] }) {
      const [selected, setSelected] = useState<Item | null>(null);
      const accept = () => selected && save(selected.id);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Status /><Help />
        <Sidebar /><Banner /><Search /><Preview />
        {rows.map(row => <Row key={row.id} selected={selected?.id === row.id}
          onPress={() => setSelected(row)} />)}
        <Footer disabled={!selected || selected.disabled} onAccept={accept} />
      </Screen>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "selected");
  assert.equal(requireValue(finding).action, "use-observable");
});

test("keeps keyed selection whose secondary reads span the owner", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    export function Results({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      const selected = rows.find(row => row.id === selectedId) ?? null;
      return <Screen>
        <Header selected={selected} /><Toolbar /><Summary /><Filters /><Status /><Help />
        {rows.map(row => <Row key={row.id} selected={selectedId === row.id}
          onPress={() => setSelectedId(row.id)} />)}
        <Sidebar /><Banner /><Search /><Preview /><Footer selected={selected} />
      </Screen>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "selectedId");
  assert.equal(requireValue(finding).action, "review-state");
});

test("keeps scalar selection that changes list shape or lacks an item-keyed producer", () => {
  for (const body of [
    `const visible = rows.filter(row => row.id === selectedId);
     return <Screen><Header /><Toolbar /><Summary /><Filters /><Status /><Help /><Sidebar /><Banner /><Search /><Preview />
       {rows.map(row => <Row key={row.id} selected={selectedId === row.id} onPress={() => setSelectedId(row.id)} />)}
       <List rows={visible} />
     </Screen>;`,
    `const selected = rows.find(row => { audit(row); return row.id === selectedId; }) ?? null;
     return <Screen><Header /><Toolbar /><Summary /><Filters /><Status /><Help /><Sidebar /><Banner /><Search /><Preview />
       {rows.map(row => <Row key={row.id} onPress={() => setSelectedId("fixed")} />)}
       <Detail item={selected} />
     </Screen>;`,
    `const selected = rows.find(row => row.id === selectedId) ?? null;
     return <Screen><Header /><Toolbar /><Summary /><Filters /><Status /><Help /><Sidebar /><Banner /><Search /><Preview />
       {rows.map(row => <Row key={row.id} onPress={() => setSelectedId(row.id)} />)}
       <Panel renderFooter={() => <Footer selected={selected} />} />
     </Screen>;`,
  ]) {
    const finding = analyzeSource(
      `
      import { useState } from "react";
      export function Results({ rows }: { rows: Array<{ id: string }> }) {
        const [selectedId, setSelectedId] = useState<string | null>(null);
        ${body}
      }
    `,
      "fixture.tsx",
    ).find((candidate) => candidate.name === "selectedId");
    assert.equal(requireValue(finding).action, "review-state");
  }
});

test("accepts a memoized event command whose binding matches its JSX prop name", () => {
  const finding = analyzeSource(
    `
    import { useCallback, useState } from "react";
    export function Results({ rows }: { rows: Array<{ id: string; run: () => void }> }) {
      const [selectedIndex, setSelectedIndex] = useState(0);
      const onKeyDown = useCallback(() => rows[selectedIndex]?.run(), [rows, selectedIndex]);
      return <Screen onKeyDown={onKeyDown}><Header /><Toolbar /><Summary /><Filters /><Status /><Help />
        <Sidebar /><Banner /><Search /><Preview /><Actions /><Footer />
        {rows.map((row, index) => <Row key={row.id} selected={selectedIndex === index}
          onPointerMove={() => setSelectedIndex(index)} />)}
      </Screen>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "selectedIndex");
  assert.equal(requireValue(finding).action, "use-observable");
});

test("keeps a row cursor whose callback is stale or also owns external lifecycle", () => {
  for (const callback of [
    `const onKeyDown = useCallback(() => rows[selectedIndex]?.run(), []);`,
    `const onKeyDown = useCallback(() => rows[selectedIndex]?.run(), [rows, selectedIndex]);
     useEffect(() => subscribe(onKeyDown), [onKeyDown]);`,
  ]) {
    const finding = analyzeSource(
      `
      import { useCallback, useEffect, useState } from "react";
      export function Results({ rows }: { rows: Array<{ id: string; run: () => void }> }) {
        const [selectedIndex, setSelectedIndex] = useState(0);
        ${callback}
        return <Screen onKeyDown={onKeyDown}><Header /><Toolbar /><Summary /><Filters /><Status /><Help />
          <Sidebar /><Banner /><Search /><Preview /><Actions /><Footer />
          {rows.map((row, index) => <Row key={row.id} selected={selectedIndex === index}
            onPointerMove={() => setSelectedIndex(index)} />)}
        </Screen>;
      }
    `,
      "fixture.tsx",
    ).find((candidate) => candidate.name === "selectedIndex");
    assert.equal(requireValue(finding).action, "review-state");
  }
});
