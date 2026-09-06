import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("keeps filtered array selection as review without a general cross-value proof", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function SelectionScreen({ rows, visibleIds }: { rows: Array<{ id: string }>; visibleIds: Set<string> }) {
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      const activeSelection = selectedIds.filter(id => visibleIds.has(id));
      const activeSelectionSet = new Set(activeSelection);
      return <Screen><Header /><Toolbar /><Summary count={activeSelection.length} /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        {rows.map(row => <Row key={row.id} selected={activeSelectionSet.has(row.id)} onPress={() => setSelectedIds([row.id])} />)}
      </Screen>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("isolates filtered keyed selection with one controlled summary leaf", () => {
  const source = `
    import { useState } from "react";
    export function SelectionScreen({ rows, visibleIds }: {
      rows: Array<{ id: string }>;
      visibleIds: string[];
    }) {
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      const visibleIdSet = new Set(visibleIds);
      const activeSelection = selectedIds.filter(id => visibleIdSet.has(id));
      const activeSelectionSet = new Set(activeSelection);
      const toggle = (id: string) => setSelectedIds(previous =>
        previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]
      );
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        <SelectionBar selectedIds={activeSelection} visibleIds={visibleIds} onChange={setSelectedIds} />
        {rows.map(row => <Row key={row.id} selected={activeSelectionSet.has(row.id)} onPress={() => toggle(row.id)} />)}
      </Screen>;
    }
  `;
  const finding = analyzeSource(source, "fixture.tsx").find(
    (candidate) => candidate.name === "selectedIds",
  );
  assert.equal(requireValue(finding).action, "use-observable");
});

test("requires a filtered keyed selection to have one exact controlled summary leaf", () => {
  for (const use of [
    `<SelectionBar selectedIds={activeSelection} visibleIds={visibleIds} onChange={setSelectedIds} />
     <SelectionCount selectedIds={activeSelection} />`,
    `<SelectionBar selectedIds={activeSelection} visibleIds={visibleIds} />`,
    `<SelectionBar selectedIds={activeSelection.map(normalize)} visibleIds={visibleIds} onChange={setSelectedIds} />`,
    `<SelectionBar selectedIds={activeSelection} visibleIds={visibleIds} onChange={setSelectedIds} />
     <button onClick={() => save(activeSelection)}>Save</button>`,
  ]) {
    const source = `
      import { useState } from "react";
      export function SelectionScreen({ rows, visibleIds }: {
        rows: Array<{ id: string }>;
        visibleIds: string[];
      }) {
        const [selectedIds, setSelectedIds] = useState<string[]>([]);
        const visibleIdSet = new Set(visibleIds);
        const activeSelection = selectedIds.filter(id => visibleIdSet.has(id));
        const activeSelectionSet = new Set(activeSelection);
        ${"\n".repeat(20)}
        return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
          ${use}
          {rows.map(row => <Row key={row.id} selected={activeSelectionSet.has(row.id)} onPress={() => setSelectedIds([row.id])} />)}
        </Screen>;
      }
    `;
    const finding = analyzeSource(source, "fixture.tsx").find(
      (candidate) => candidate.name === "selectedIds",
    );
    assert.notEqual(requireValue(finding).action, "use-observable", use);
  }
});

test("requires the filtered selection membership source to remain read-only", () => {
  for (const [declaration, mutation] of [
    [`const visibleIdSet = new Set(visibleIds);`, `visibleIdSet.add("extra");`],
    [`const visibleIdSet = new Set(visibleIds);`, `inspect(visibleIdSet);`],
    [`let visibleIdSet = new Set(visibleIds);`, `visibleIdSet = new Set();`],
  ]) {
    const source = `
      import { useState } from "react";
      export function SelectionScreen({ rows, visibleIds }: {
        rows: Array<{ id: string }>;
        visibleIds: string[];
      }) {
        const [selectedIds, setSelectedIds] = useState<string[]>([]);
        ${declaration}
        const activeSelection = selectedIds.filter(id => visibleIdSet.has(id));
        const activeSelectionSet = new Set(activeSelection);
        ${mutation}
        return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
          <SelectionBar selectedIds={activeSelection} visibleIds={visibleIds} onChange={setSelectedIds} />
          {rows.map(row => <Row key={row.id} selected={activeSelectionSet.has(row.id)} onPress={() => setSelectedIds([row.id])} />)}
        </Screen>;
      }
    `;
    const finding = analyzeSource(source, "fixture.tsx").find(
      (candidate) => candidate.name === "selectedIds",
    );
    assert.notEqual(requireValue(finding).action, "use-observable", mutation);
  }
});

test("does not infer filtered selection from a shadowed Set constructor", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function SelectionScreen({ rows, visibleIds, FakeSet }: {
      rows: Array<{ id: string }>;
      visibleIds: string[];
      FakeSet: new (values: string[]) => Set<string>;
    }) {
      const Set = FakeSet;
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      const visibleIdSet = new Set(visibleIds);
      const activeSelection = selectedIds.filter(id => visibleIdSet.has(id));
      const activeSelectionSet = new Set(activeSelection);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        <SelectionBar selectedIds={activeSelection} visibleIds={visibleIds} onChange={setSelectedIds} />
        {rows.map(row => <Row key={row.id} selected={activeSelectionSet.has(row.id)} onPress={() => setSelectedIds([row.id])} />)}
      </Screen>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("isolates keyed array membership with one filtered selection summary leaf", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Labels({ rows }: { rows: Array<{ id: string; name: string }> }) {
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      const selectedIdSet = new Set(selectedIds);
      const selectedRows = rows.filter(row => selectedIdSet.has(row.id));
      const toggle = (id: string) => setSelectedIds(previous =>
        previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]
      );
      return <Screen><Header /><Toolbar /><Summary count={selectedIds.length} /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        {selectedRows.length > 0 && <aside>{selectedRows.map(row => <Badge key={row.id} onClick={() => toggle(row.id)}>{row.name}</Badge>)}</aside>}
        {rows.map(row => <Row key={row.id} selected={selectedIdSet.has(row.id)} onPress={() => toggle(row.id)} />)}
      </Screen>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
});

test("keeps filtered selection summaries with split, unstable, or command consumers conservative", () => {
  for (const summary of [
    `{selectedRows.length > 0 && <aside>{selectedRows.map(row => <Badge key={row.id}>{row.name}</Badge>)}</aside>}
     {selectedRows.length > 1 && <Footer />}`,
    `{selectedRows.length > 0 && <aside>{selectedRows.map((row, index) => <Badge key={index}>{row.name}</Badge>)}</aside>}`,
    `{selectedRows.length > 0 && <aside>{selectedRows.map(row => <Badge key={row.id}>{row.name}</Badge>)}</aside>}
     <button onClick={() => save(selectedRows)}>Save</button>`,
  ]) {
    const [finding] = analyzeSource(
      `
      import { useState } from "react";
      export function Labels({ rows }: { rows: Array<{ id: string; name: string }> }) {
        const [selectedIds, setSelectedIds] = useState<string[]>([]);
        const selectedIdSet = new Set(selectedIds);
        const selectedRows = rows.filter(row => selectedIdSet.has(row.id));
        const toggle = (id: string) => setSelectedIds(previous =>
          previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]
        );
        return <Screen><Header /><Toolbar /><Summary count={selectedIds.length} /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
          ${summary}
          {rows.map(row => <Row key={row.id} selected={selectedIdSet.has(row.id)} onPress={() => toggle(row.id)} />)}
        </Screen>;
      }
    `,
      "fixture.tsx",
    );
    assert.notEqual(requireValue(finding).action, "use-observable", summary);
  }
});

test("does not call array filtering that changes row membership a keyed leaf selection", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function FilteredRows({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      const visibleRows = rows.filter(row => selectedIds.includes(row.id));
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        {visibleRows.map(row => <Row key={row.id} onPress={() => setSelectedIds([row.id])} />)}
      </Screen>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("does not trace an arbitrary filtered array into keyed membership", () => {
  const source = `
    import { useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string; enabled: boolean }> }) {
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      const active = selectedIds.filter(id => normalize(id));
      const activeSet = new Set(active);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
        <Actions /><Preview />{rows.map(row => <Row key={row.id} selected={activeSet.has(row.id)} />)}</main>;
    }
  `;
  const finding = analyzeSource(source, "screen.tsx").find(
    (candidate) => candidate.name === "selectedIds",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});
