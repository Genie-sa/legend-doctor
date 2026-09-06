import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("proves an effect-owned custom-hook cursor has only stable keyed row consumers", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-hook-cursor-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "keyboard.ts"),
    `
      class Keyboard {
        private listeners: Array<(event: { next?: boolean; submit?: boolean }) => void> = [];
        subscribe(listener: (event: { next?: boolean; submit?: boolean }) => void) {
          this.listeners.push(listener);
          return () => { this.listeners = this.listeners.filter(candidate => candidate !== listener); };
        }
      }
      export default new Keyboard();
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "immediate.ts"),
    `
      class Immediate {
        subscribe(listener: () => void) {
          listener();
          return () => {};
        }
      }
      export default new Immediate();
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "use-cursors.ts"),
    `
      import { useEffect, useState } from "react";
      import immediate from "./immediate";
      import keyboard from "./keyboard";
      export function useCursor(size: number) {
        const [cursor, setCursor] = useState(-1);
        useEffect(() => { setCursor(previous => previous < size ? previous : 0); }, [size]);
        useEffect(() => {
          const remove = keyboard.subscribe(event => {
            if (event.next) setCursor(previous => (previous + 1) % size);
            if (event.submit) submit(cursor);
          });
          return remove;
        }, [cursor, size]);
        return { cursor, setCursor };
      }
      export function useMountCursor(size: number) {
        const [mountCursor, setMountCursor] = useState(-1);
        useEffect(() => { setMountCursor(0); }, [size]);
        return { mountCursor, setMountCursor };
      }
      export function useIndexKeyCursor(size: number) {
        const [indexKeyCursor, setIndexKeyCursor] = useState(-1);
        useEffect(() => { setIndexKeyCursor(0); }, [size]);
        return { indexKeyCursor, setIndexKeyCursor };
      }
      export function useShadowCursor(size: number) {
        const [shadowCursor, setShadowCursor] = useState(-1);
        useEffect(() => { setShadowCursor(0); }, [size]);
        useEffect(() => {
          const remove = keyboard.subscribe(() => submit(shadowCursor));
          return remove;
        }, [shadowCursor]);
        return { shadowCursor, setShadowCursor };
      }
      export function useSetterCursor(size: number) {
        const [setterCursor, setSetterCursor] = useState(-1);
        useEffect(() => { setSetterCursor(0); }, [size]);
        useEffect(() => {
          const remove = keyboard.subscribe(() => submit(setterCursor));
          return remove;
        }, [setterCursor]);
        return { setterCursor, setSetterCursor };
      }
      export function useSyncCursor(size: number) {
        const [syncCursor, setSyncCursor] = useState(-1);
        useEffect(() => { setSyncCursor(0); }, [size]);
        useEffect(() => {
          const unsubscribe = immediate.subscribe(() => submit(syncCursor));
          return unsubscribe;
        }, [syncCursor]);
        return { syncCursor, setSyncCursor };
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Lists.tsx"),
    `
      import { useCallback } from "react";
      import { useCursor, useIndexKeyCursor, useMountCursor, useSetterCursor, useShadowCursor, useSyncCursor } from "./use-cursors";
      export function StableRows({ rows }: { rows: Array<{ id: string }> }) {
        const { cursor } = useCursor(rows.length);
        const renderItem = useCallback(({ item, index }) => {
          const active = cursor === index;
          return <Row item={item} active={active} className={active ? "active" : ""} />;
        }, [cursor]);
        const keyExtractor = useCallback(item => item.id, []);
        return <List data={rows} renderItem={renderItem} keyExtractor={keyExtractor} extraData={{ cursor }} />;
      }
      export function MountRows({ rows }: { rows: Array<{ id: string }> }) {
        const { mountCursor } = useMountCursor(rows.length);
        const renderItem = useCallback(({ item, index }) => {
          if (mountCursor !== index) return null;
          return <Row item={item} />;
        }, [mountCursor]);
        return <List data={rows} renderItem={renderItem} keyExtractor={item => item.id} extraData={{ mountCursor }} />;
      }
      export function IndexKeyRows({ rows }: { rows: Array<{ id: string }> }) {
        const { indexKeyCursor } = useIndexKeyCursor(rows.length);
        const renderItem = useCallback(({ item, index }) => <Row item={item} active={indexKeyCursor === index} />, [indexKeyCursor]);
        return <List data={rows} renderItem={renderItem} keyExtractor={(_item, index) => index} extraData={{ indexKeyCursor }} />;
      }
      export function SyncRows({ rows }: { rows: Array<{ id: string }> }) {
        const { syncCursor } = useSyncCursor(rows.length);
        const renderItem = useCallback(({ item, index }) => <Row item={item} active={syncCursor === index} />, [syncCursor]);
        return <List data={rows} renderItem={renderItem} keyExtractor={item => item.id} extraData={{ syncCursor }} />;
      }
      export function ShadowRows({ rows }: { rows: Array<{ id: string }> }) {
        const { shadowCursor } = useShadowCursor(rows.length);
        const useCallback = <T,>(callback: T, _dependencies: unknown[]) => callback;
        const renderItem = useCallback(({ item, index }) => <Row item={item} active={shadowCursor === index} />, [shadowCursor]);
        return <List data={rows} renderItem={renderItem} keyExtractor={item => item.id} extraData={{ shadowCursor }} />;
      }
      export function SetterRows({ rows }: { rows: Array<{ id: string }> }) {
        const { setterCursor, setSetterCursor } = useSetterCursor(rows.length);
        const renderItem = useCallback(({ item, index }) => <Row item={item} active={setterCursor === index} />, [setterCursor]);
        return <List data={rows} renderItem={renderItem} keyExtractor={item => item.id} extraData={{ setterCursor }} onReset={() => setSetterCursor(-1)} />;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "cursor")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "mountCursor")).action,
    "review-state",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "indexKeyCursor")).action,
    "review-state",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "syncCursor")).action,
    "review-state",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "shadowCursor")).action,
    "review-state",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "setterCursor")).action,
    "review-state",
  );
});

test("proves keyed record commands through source-resolved event wrappers", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-keyed-record-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Buttons.tsx"),
    `
      export function DeferredButton({ active, onPress }: { active: boolean; onPress: () => void }) {
        return <button aria-pressed={active} onClick={onPress}>Vote</button>;
      }
      export function EagerButton({ active, onPress }: { active: boolean; onPress: () => void }) {
        onPress();
        return <button aria-pressed={active}>Vote</button>;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screens.tsx"),
    `
      import { useState } from "react";
      import { DeferredButton, EagerButton } from "./Buttons";
      type Verdict = "up" | "down";
      type Row = { id: string };
      export function SafeScreen({ rows }: { rows: Row[] }) {
        const { mutateAsync: submitFeedback } = useSubmitFeedback();
        const [safeFeedback, setSafeFeedback] = useState<Record<string, Verdict>>({});
        async function vote(row: Row, verdict: Verdict) {
          setSafeFeedback(previous => ({ ...previous, [row.id]: verdict }));
          await submitFeedback(row.id, verdict);
        }
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
          {rows.map(row => <div key={row.id}>
          <DeferredButton active={safeFeedback[row.id] === "up"} onPress={() => vote(row, "up")} />
        </div>)}</main>;
      }
      export function EagerScreen({ rows }: { rows: Row[] }) {
        const { mutateAsync: submitFeedback } = useSubmitFeedback();
        const [eagerFeedback, setEagerFeedback] = useState<Record<string, Verdict>>({});
        async function vote(row: Row, verdict: Verdict) {
          setEagerFeedback(previous => ({ ...previous, [row.id]: verdict }));
          await submitFeedback(row.id, verdict);
        }
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
          {rows.map(row => <div key={row.id}>
          <EagerButton active={eagerFeedback[row.id] === "up"} onPress={() => vote(row, "up")} />
        </div>)}</main>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  const safe = report.findings.find((finding) => finding.name === "safeFeedback");
  const eager = report.findings.find((finding) => finding.name === "eagerFeedback");
  assert.equal(requireValue(safe).action, "use-observable");
  assert.match(requireValue(safe).message ?? "", /dynamic entry/u);
  assert.doesNotMatch(requireValue(eager).message ?? "", /dynamic entry/u);
});

test("allows repeated row commands when the value has one stable leaf consumer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-repeated-command-"));
  await writeFile(
    path.join(root, "Leaves.tsx"),
    `
      export function Row({ onSelect }: { onSelect: (id: string) => void }) { return <button onClick={() => onSelect("x")} />; }
      export function Dialog({ selected }: { selected: string | null }) { return selected ? <aside /> : null; }
    `,
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Dialog, Row } from "./Leaves";
      export function Screen({ rows }: { rows: string[] }) {
        const [selected, setSelected] = useState<string | null>(null);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview />{rows.map(row => <Row key={row} onSelect={setSelected} />)}
          <Dialog selected={selected} /></main>;
      }
    `,
  );

  const report = await analyzePath(root);
  const finding = report.findings.find((candidate) => candidate.name === "selected");
  assert.equal(requireValue(finding).action, "use-observable");
});
