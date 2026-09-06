import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("recognizes keyed collection membership in a JSX renderItem callback", () => {
  const [finding] = analyzeSource(
    `
    import { useCallback, useState } from "react";
    export function SelectionScreen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      const renderItem = useCallback(({ item }: { item: { id: string } }) =>
        <Row selected={selected.has(item.id)} onPress={() => setSelected(new Set([item.id]))} />,
        [selected]
      );
      return <Screen><Header /><Toolbar /><Summary count={selected.size} /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search />
        <List data={rows} renderItem={renderItem} extraData={selected} />
      </Screen>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
});

test("isolates an imperative nullable collection inside a keyed renderItem leaf", () => {
  const positive = analyzeSource(
    `
    import { useCallback, useImperativeHandle, useState } from "react";
    export function SelectionList({ rows, ref }: { rows: Array<{ id: string }>; ref: unknown }) {
      const [highlighted, setHighlighted] = useState<Set<string> | null>(null);
      const renderItem = ({ item }: { item: { id: string } }) =>
        <Row highlighted={!!highlighted?.has(item.id)} />;
      const highlight = useCallback((ids: string[]) => {
        const next = new Set(ids);
        if (equal(highlighted, next)) return;
        setHighlighted(next);
        setTimeout(() => setHighlighted(null), 100);
      }, [highlighted]);
      useImperativeHandle(ref, () => ({ highlight }), [highlight]);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status />
        <List data={rows} renderItem={renderItem} keyExtractor={item => item.id} />
      </Screen>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "highlighted");
  assert.equal(requireValue(positive).action, "use-observable");

  for (const [renderItem, keyExtractor, expose, extra = ""] of [
    [
      `<Row highlighted={!!highlighted?.has(item.id)} />`,
      `(_, index) => String(index)`,
      `useImperativeHandle(ref, () => ({ highlight }), [highlight]);`,
    ],
    [
      `highlighted?.has(item.id) ? <Row /> : null`,
      `item => item.id`,
      `useImperativeHandle(ref, () => ({ highlight }), [highlight]);`,
    ],
    [
      `<Row highlighted={!!highlighted?.has(item.id)} />`,
      `item => item.id`,
      `useLibraryHandle(ref, () => ({ highlight }), [highlight]);`,
    ],
    [
      `<Row highlighted={!!highlighted?.has(item.id)} />`,
      `item => item.id`,
      `useImperativeHandle(ref, () => ({ highlight }), [highlight]);`,
      `const listener = useCallback(() => notify(), [highlighted]); useLifecycle(listener);`,
    ],
    [
      `<Row highlighted={!!highlighted?.has(item.id)} />`,
      `item => item.id`,
      `useImperativeHandle(ref, () => ({ highlight }), [highlight]);`,
      `registerRenderer(renderItem);`,
    ],
  ]) {
    const finding = analyzeSource(
      `
      import { useCallback, useEffect, useImperativeHandle, useState } from "react";
      export function SelectionList({ rows, ref }: { rows: Array<{ id: string }>; ref: unknown }) {
        const [highlighted, setHighlighted] = useState<Set<string> | null>(null);
        const renderItem = ({ item, index }: { item: { id: string }; index: number }) => ${renderItem};
        const highlight = useCallback((ids: string[]) => setHighlighted(new Set(ids)), []);
        ${extra}
        ${expose}
        return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status />
          <List data={rows} renderItem={renderItem} keyExtractor={${keyExtractor}} />
        </Screen>;
      }
    `,
      "fixture.tsx",
    ).find((candidate) => candidate.name === "highlighted");
    assert.notEqual(requireValue(finding).action, "use-observable");
  }

  const shadowedHandle = analyzeSource(
    `
    import { useCallback, useImperativeHandle, useState } from "react";
    export function SelectionList({ rows, ref, useImperativeHandle }: {
      rows: Array<{ id: string }>;
      ref: unknown;
      useImperativeHandle: (...args: unknown[]) => void;
    }) {
      const [highlighted, setHighlighted] = useState<Set<string> | null>(null);
      const renderItem = ({ item }: { item: { id: string } }) =>
        <Row highlighted={!!highlighted?.has(item.id)} />;
      const highlight = useCallback((ids: string[]) => setHighlighted(new Set(ids)), []);
      useImperativeHandle(ref, () => ({ highlight }), [highlight]);
      return <List data={rows} renderItem={renderItem} keyExtractor={item => item.id} />;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "highlighted");
  assert.notEqual(requireValue(shadowedHandle).action, "use-observable");
});

test("ignores callback dependency references when proving a keyed event command", () => {
  const [finding] = analyzeSource(
    `
    import { useCallback, useState } from "react";
    export function SelectionScreen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<Set<string>>(() => new Set());
      const toggle = useCallback((id: string) => {
        vibrate();
        setSelected(previous => {
          const next = new Set(previous);
          next.has(id) ? next.delete(id) : next.add(id);
          return next;
        });
      }, []);
      const renderItem = useCallback(({ item }: { item: { id: string } }) =>
        <Row selected={selected.has(item.id)} onPress={() => toggle(item.id)} />,
        [selected, toggle]
      );
      return <Screen><Header /><Toolbar /><Summary count={selected.size} /><Filters /><Actions /><Status />
        <Help /><Footer /><Sidebar /><Banner /><Search /><List data={rows} renderItem={renderItem} />
      </Screen>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
});
