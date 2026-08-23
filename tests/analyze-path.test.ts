import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  analyzeLegendPractices,
  analyzeLegendPracticesFile,
} from "../src/analyze-legend-practices.js";
import {
  analyzePath,
  analyzePathDetailed,
  createAnalysisContext,
} from "../src/analyze-path.js";
import { analyzeSource, analyzeSourceFile } from "../src/analyze-source.js";
import { AnalysisProject } from "../src/analysis-project.js";

test("scans source files deterministically and ignores generated directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-test-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(
    path.join(root, "src", "component.tsx"),
    'import { useState } from "react"; export function C() { const [x] = useState(1); return <>{x}</>; }'
  );
  await writeFile(
    path.join(root, "node_modules", "ignored.tsx"),
    'import { useState } from "react"; export function C() { const [x] = useState(1); return <>{x}</>; }'
  );

  const report = await analyzePath(root);

  assert.equal(report.files, 1);
  assert.equal(report.hooks.states, 1);
  assert.equal(report.findings[0]?.location.file, path.join("src", "component.tsx"));
});

test("reports parser diagnostics and complete coverage without changing the default report", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-coverage-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "broken.ts"),
    'import { useState } from "react"; const [value] = useState(;',
    "utf8"
  );
  await writeFile(path.join(root, "valid.ts"), "export const value = 1;", "utf8");

  const detailed = await analyzePathDetailed(root);
  const ordinary = await analyzePath(root);

  assert.deepEqual(detailed.report, ordinary);
  assert.equal(detailed.diagnostics.parser.length, 1);
  assert.equal(detailed.diagnostics.parser[0]?.file, "broken.ts");
  assert.deepEqual(detailed.diagnostics.semantic, []);
  assert.equal(detailed.coverage.entries.length, 2);
  assert.deepEqual(
    detailed.coverage.entries.map(entry => [
      entry.target.file,
      entry.stages.parser.reason.code,
      entry.stages.detector.status,
    ]),
    [
      ["broken.ts", "parser-recovered", "unknown"],
      ["valid.ts", "parser-complete", "analyzed"],
    ]
  );
});

test("inventories named and anonymous runtime functions in coverage", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-functions-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "screen.ts"),
    `
      export function Screen() {
        return [1].map(value => value + 1);
      }
    `,
    "utf8"
  );

  const detailed = await analyzePathDetailed(root);
  const functions = detailed.coverage.entries.filter(entry => entry.target.kind === "function");

  assert.deepEqual(
    functions.map(entry => entry.target.kind === "function" ? entry.target.name : null),
    ["Screen", null]
  );
  assert.ok(functions.every(entry => entry.stages.detector.status === "analyzed"));
  assert.ok(functions.every(entry => entry.stages.lowering.reason.code === "bounded-flow-not-requested"));
});

test("reports complete, uncertain, and unrequested bounded state-flow coverage", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-flow-coverage-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const source = `
    import { useState } from "react";
    export function Screen({ items }: { items: string[] }) {
      const [first, setFirst] = useState("");
      const [second, setSecond] = useState("");
      const complete = () => { setFirst("a"); setSecond("b"); };
      const uncertain = () => { for (const item of items) setFirst(item); setSecond("b"); };
      return <button onClick={complete}>{first}{second}{String(uncertain)}</button>;
    }
    export function Unrelated() { return null; }
  `;
  await writeFile(path.join(root, "screen.tsx"), source, "utf8");

  const detailed = await analyzePathDetailed(root);
  const functions = detailed.coverage.entries.filter(entry => entry.target.kind === "function");
  const byName = new Map(functions.map(entry => [entry.target.kind === "function" ? entry.target.name : null, entry]));

  assert.equal(byName.get("complete")?.stages.lowering.reason.code, "bounded-flow-complete");
  assert.equal(byName.get("uncertain")?.stages.lowering.reason.code, "bounded-flow-uncertain");
  assert.equal(byName.get("Unrelated")?.stages.lowering.reason.code, "bounded-flow-not-requested");
  assert.equal(detailed.coverage.entries[0]?.stages.lowering.reason.code, "bounded-flow-uncertain");
  assert.deepEqual(detailed.report.findings, analyzeSource(source, "screen.tsx"));
});

test("excludes ambient declarations, overload signatures, and abstract methods from runtime coverage", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-runtime-only-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "contracts.ts"),
    `
      declare function ambient(): void;
      function overloaded(value: string): string;
      function overloaded(value: string) { return value; }
      abstract class Base { abstract method(): void; }
    `,
    "utf8"
  );

  const detailed = await analyzePathDetailed(root);
  const names = detailed.coverage.entries.flatMap(entry =>
    entry.target.kind === "function" ? [entry.target.name] : []
  );

  assert.deepEqual(names, ["overloaded"]);
});

test("localizes parser recovery to the overlapping function", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-recovery-range-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "screen.ts"),
    `
      function broken() { const value = ; return value; }
      function healthy() { return 1; }
    `,
    "utf8"
  );

  const detailed = await analyzePathDetailed(root);
  const functions = detailed.coverage.entries.filter(entry => entry.target.kind === "function");

  assert.deepEqual(
    functions.map(entry => [
      entry.target.kind === "function" ? entry.target.name : null,
      entry.stages.parser.reason.code,
      entry.stages.detector.status,
    ]),
    [
      ["broken", "parser-recovered-in-function", "unknown"],
      ["healthy", "parser-complete", "unknown"],
    ]
  );
});

test("attributes an end-of-file recovery diagnostic to the unfinished function", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-recovery-eof-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "screen.ts"),
    "function broken() { const value = 1;",
    "utf8"
  );

  const detailed = await analyzePathDetailed(root);
  const functionEntry = detailed.coverage.entries.find(
    entry => entry.target.kind === "function"
  );

  assert.equal(functionEntry?.stages.parser.reason.code, "parser-recovered-in-function");
  assert.equal(functionEntry?.stages.lowering.reason.code, "bounded-flow-uncertain");
  assert.equal(functionEntry?.stages.detector.status, "unknown");
});

test("scopes directory coverage to supported sources and reports direct unsupported targets", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-coverage-universe-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "valid.ts"), "export const value = 1;", "utf8");
  const unsupportedPath = path.join(root, "component.vue");
  await writeFile(unsupportedPath, "<template />", "utf8");

  const directory = await analyzePathDetailed(root);
  const direct = await analyzePathDetailed(unsupportedPath);

  assert.deepEqual(directory.coverage.entries.map(entry => entry.target.file), ["valid.ts"]);
  assert.equal(direct.coverage.entries.length, 1);
  assert.equal(direct.coverage.entries[0]?.stages.parser.reason.code, "unsupported-extension");
  assert.equal(direct.coverage.entries[0]?.stages.detector.status, "unsupported");
});

test("surfaces legacy hook practices in read-only files through the path prefilter", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-practice-eligibility-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "legacy.ts"),
    `
      import { useSelector } from "@legendapp/state/react";
      export function read(value: string) { return useSelector(() => value); }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "use-t.ts"),
    `
      import { use$ } from "@legendapp/state/react";
      import { i18n$ } from "./legacy.js";
      export function useT() { return use$(i18n$.strings); }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "plain.ts"),
    "export function useT(value: string) { return value.trim(); }",
    "utf8"
  );

  const report = await analyzePath(root);

  assert.deepEqual(
    report.practices.map(practice => [practice.location.file, practice.action]),
    [
      ["legacy.ts", "replace-legacy-use-value"],
      ["use-t.ts", "replace-legacy-use-value"],
    ]
  );
});

test("downgrades replace-legacy-use-value to style when the installed useValue is an alias", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-installed-alias-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const packageDirectory = path.join(root, "node_modules", "@legendapp", "state");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ name: "@legendapp/state", version: "3.0.0-beta.48" }),
    "utf8"
  );
  await writeFile(
    path.join(packageDirectory, "react.d.ts"),
    "export { useSelector as use$, useSelector, useSelector as useValue };",
    "utf8"
  );
  await writeFile(
    path.join(root, "legacy.ts"),
    `
      import { use$ } from "@legendapp/state/react";
      export function read(value: string) { return use$(() => value); }
    `,
    "utf8"
  );

  const report = await analyzePath(root);

  assert.equal(report.practices[0]?.action, "replace-legacy-use-value");
  assert.equal(report.practices[0]?.disposition, "style");
  assert.match(
    report.practices[0]?.evidence.join("\n") ?? "",
    /alias of useSelector in the installed @legendapp\/state@3\.0\.0-beta\.48/
  );
});

test("replaces an exact React mirror of a one-hop Legend value hook", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-value-bridge-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "state.ts"),
    `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const name$ = observable("");
      const other$ = observable("");
      export function useName() { return useValue(name$) ?? ""; }
      export function setName(next: string) { name$.set(next); }
      export function setOther(next: string) { other$.set(next); }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { setName as writeName, setOther as writeOther, useName as useSavedName } from "./state";
      export function Screen() {
        const saved = useSavedName();
        const otherSaved = useSavedName();
        const wrongSaved = useSavedName();
        const [name, setDraftName] = useState(saved);
        const [mismatch, setMismatch] = useState(otherSaved);
        const [wrongSource, setWrongSource] = useState(wrongSaved);
        const onName = (next: string) => { setDraftName(next); writeName(next); };
        const onMismatch = (next: string) => { setMismatch(next); writeName(next.trim()); };
        const onWrongSource = (next: string) => { setWrongSource(next); writeOther(next); };
        return <><input value={name} onChange={event => onName(event.target.value)} />
          <input value={mismatch} onChange={event => onMismatch(event.target.value)} />
          <input value={wrongSource} onChange={event => onWrongSource(event.target.value)} /></>;
      }
    `,
    "utf8"
  );

  const report = await analyzePath(root);
  assert.equal(report.findings.find(finding => finding.name === "name")?.action, "use-value");
  assert.notEqual(report.findings.find(finding => finding.name === "mismatch")?.action, "use-value");
  assert.notEqual(report.findings.find(finding => finding.name === "wrongSource")?.action, "use-value");
});

test("preserves the pre-update snapshot for state read by a source-proven deferred callback", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-deferred-counter-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "use-deferred.ts"),
    `
      import { useEffect, useRef } from "react";
      export default function useDeferred(callback: () => void) {
        const latest = useRef<(() => void) | undefined>();
        useEffect(() => { latest.current = callback; }, [callback]);
        useEffect(() => {
          const id = setInterval(() => latest.current(), 1000);
          return () => clearInterval(id);
        }, []);
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "use-immediate.ts"),
    `
      import { useEffect } from "react";
      export function useMixed(callback: () => void) {
        callback();
        useEffect(() => { callback(); }, [callback]);
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "use-counter.ts"),
    `
      import { useState } from "react";
      import useDeferred from "./use-deferred";
      import { useMixed } from "./use-immediate";
      export function useCounter(limit: number) {
        const [ticks, setTicks] = useState(0);
        const [unsafeTicks, setUnsafeTicks] = useState(0);
        const [asyncTicks, setAsyncTicks] = useState(0);
        useDeferred(() => {
          setTicks(previous => previous + 1);
          if (ticks >= limit) report();
        });
        useMixed(() => {
          setUnsafeTicks(previous => previous + 1);
          if (unsafeTicks >= limit) report();
        });
        useDeferred(async () => {
          setAsyncTicks(previous => previous + 1);
          await load();
          if (asyncTicks >= limit) report();
        });
      }
    `,
    "utf8"
  );

  const report = await analyzePath(root);
  const ticks = report.findings.find(finding => finding.name === "ticks");
  assert.equal(ticks?.action, "use-ref");
  assert.match(ticks?.message ?? "", /pre-update snapshot/);
  assert.notEqual(report.findings.find(finding => finding.name === "unsafeTicks")?.action, "use-ref");
  assert.notEqual(report.findings.find(finding => finding.name === "asyncTicks")?.action, "use-ref");
});

test("proves transitive object callback deferral across source hooks", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-transitive-hook-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "use-guard.ts"),
    `
      import { useStoredGuard } from "./use-stored-guard";
      export function useGuard({ getSnapshot }: { getSnapshot: () => string }) {
        const hasSnapshot = () => getSnapshot().length > 0;
        useStoredGuard(hasSnapshot);
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "use-stored-guard.ts"),
    `
      import { useEffect, useRef } from "react";
      export function useStoredGuard(callback: () => boolean) {
        const callbacksRef = useRef({ callback });
        useEffect(() => { callbacksRef.current = { callback }; });
        useEffect(() => subscribe({ run: () => callbacksRef.current.callback() }), []);
      }
      export function useUnsafeStoredGuard(callback: () => string) {
        const callbacksRef = useRef({ callback });
        callbacksRef.current.callback();
        useEffect(() => subscribe(() => callbacksRef.current.callback()), []);
      }
      export function useStaleStoredGuard(callback: () => string) {
        const callbacksRef = useRef({ callback });
        useEffect(() => subscribe(() => callbacksRef.current.callback()), []);
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "use-unsafe-guard.ts"),
    `
      import { useUnsafeStoredGuard } from "./use-stored-guard";
      export function useUnsafeGuard({ getSnapshot }: { getSnapshot: () => string }) {
        useUnsafeStoredGuard(getSnapshot);
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "use-stale-guard.ts"),
    `
      import { useStaleStoredGuard } from "./use-stored-guard";
      export function useStaleGuard({ getSnapshot }: { getSnapshot: () => string }) {
        useStaleStoredGuard(getSnapshot);
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { useGuard } from "./use-guard";
      import { useStaleGuard } from "./use-stale-guard";
      import { useUnsafeGuard } from "./use-unsafe-guard";
      export function SafeScreen() {
        const [draft, setDraft] = useState("");
        useGuard({ getSnapshot: () => draft });
        return <input onChange={event => setDraft(event.target.value)} />;
      }
      export function UnsafeScreen() {
        const [unsafeDraft, setUnsafeDraft] = useState("");
        useUnsafeGuard({ getSnapshot: () => unsafeDraft });
        return <input onChange={event => setUnsafeDraft(event.target.value)} />;
      }
      export function MethodScreen() {
        const [methodDraft, setMethodDraft] = useState("");
        useGuard({ getSnapshot() { return methodDraft; } });
        return <input onChange={event => setMethodDraft(event.target.value)} />;
      }
      export function StaleScreen() {
        const [staleDraft, setStaleDraft] = useState("");
        useStaleGuard({ getSnapshot: () => staleDraft });
        return <input onChange={event => setStaleDraft(event.target.value)} />;
      }
    `,
    "utf8"
  );

  const report = await analyzePath(root);
  assert.equal(report.findings.find(finding => finding.name === "draft")?.action, "use-ref");
  assert.equal(report.findings.find(finding => finding.name === "methodDraft")?.action, "use-ref");
  assert.equal(report.findings.find(finding => finding.name === "unsafeDraft")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "staleDraft")?.action, "review-state");
});

test("proves an effect-owned custom-hook cursor has only stable keyed row consumers", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-hook-cursor-"));
  t.after(() => rm(root, { force: true, recursive: true }));
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
    "utf8"
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
    "utf8"
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
    "utf8"
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
    "utf8"
  );

  const report = await analyzePath(root);
  assert.equal(report.findings.find(finding => finding.name === "cursor")?.action, "use-observable");
  assert.equal(report.findings.find(finding => finding.name === "mountCursor")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "indexKeyCursor")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "syncCursor")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "shadowCursor")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "setterCursor")?.action, "review-state");
});

test("isolates an event-owned boolean across small presentation leaves and reactive props", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-multi-leaf-boolean-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "cx.ts"),
    `
      import { clsx } from "clsx";
      export function cx(...values: unknown[]) { return clsx(values); }
      export function noisy(...values: unknown[]) { console.log(values); return clsx(values); }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "Screens.tsx"),
    `
      import { useCallback, useEffect, useRef, useState } from "react";
      import { cx, noisy } from "./cx";
      export function SafeScreen() {
        const [active, setActive] = useState(false);
        const enter = useCallback(() => setActive(true), []);
        const leave = useCallback(() => setActive(false), []);
        const surfaceClass = cx(active && "active");
        return <Surface className={cx("base", surfaceClass)} onEnter={enter} onLeave={leave}>
          {active && <View><Text>Active</Text></View>}
          <View>{active ? <Text>Drop</Text> : null}</View>
          <View/><View/><View/><View/><View/><View/><View/><View/><View/><View/>
        </Surface>;
      }
      export function ImpureScreen() {
        const [noisyActive, setNoisyActive] = useState(false);
        const enter = useCallback(() => setNoisyActive(true), []);
        const leave = useCallback(() => setNoisyActive(false), []);
        return <Surface className={noisy(noisyActive && "active")} onEnter={enter} onLeave={leave}>
          {noisyActive && <View><Text>Active</Text></View>}
          <View/><View/><View/><View/><View/><View/><View/><View/><View/><View/>
        </Surface>;
      }
      export function BroadSurfaceScreen() {
        const [broadActive, setBroadActive] = useState(false);
        const enter = useCallback(() => setBroadActive(true), []);
        const leave = useCallback(() => setBroadActive(false), []);
        return <Surface className={cx(broadActive && "active")} onEnter={enter} onLeave={leave}>
          {broadActive && <View><Text>One</Text><Text>Two</Text><Text>Three</Text><Text>Four</Text><Text>Five</Text></View>}
          <View/><View/><View/><View/><View/><View/><View/><View/><View/><View/>
        </Surface>;
      }
      export function BranchScreen({ editable }: { editable: boolean }) {
        const [branchActive, setBranchActive] = useState(false);
        const enter = useCallback(() => setBranchActive(true), []);
        const leave = useCallback(() => setBranchActive(false), []);
        if (editable) {
          return <Surface className={cx(branchActive && "active")} onEnter={enter} onLeave={leave}>
            {branchActive && <Text>Active</Text>}<View/><View/><View/><View/><View/>
          </Surface>;
        }
        return <Surface className={cx(branchActive && "active")} onEnter={enter} onLeave={leave}>
          {branchActive && <Text>Active</Text>}<View/><View/><View/><View/><View/>
        </Surface>;
      }
      export function ComputedEventScreen() {
        const [scrolled, setScrolled] = useState(false);
        const handleScroll = (event: { currentTarget: { scrollTop: number; clientHeight: number; scrollHeight: number } }) => {
          const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
          setScrolled(scrollTop + clientHeight >= scrollHeight);
        };
        return <Surface>
          <div onScroll={handleScroll}><Content/></div>
          {!scrolled && <Fade/>}
          {!scrolled && <Hint/>}
          <View/><View/><View/><View/><View/><View/><View/><View/><View/><View/>
        </Surface>;
      }
      export function CustomComputedScreen() {
        const [customComputed, setCustomComputed] = useState(false);
        const handleScroll = (event: { currentTarget: { scrollTop: number } }) => setCustomComputed(event.currentTarget.scrollTop > 0);
        return <Surface>
          <Scroller onScroll={handleScroll}/>
          {!customComputed && <Fade/>}
          {!customComputed && <Hint/>}
          <View/><View/><View/><View/><View/><View/><View/><View/><View/><View/>
        </Surface>;
      }
      export function InlineComputedScreen() {
        const [inlineComputed, setInlineComputed] = useState(false);
        return <Surface>
          <div onScroll={event => setInlineComputed(event.currentTarget.scrollTop > 0)}/>
          {!inlineComputed && <Fade/>}
          {!inlineComputed && <Hint/>}
          <View/><View/><View/><View/><View/><View/><View/><View/><View/><View/>
        </Surface>;
      }
      export function OpaqueComputedScreen() {
        const [opaque, setOpaque] = useState(false);
        const handleScroll = (event: unknown) => setOpaque(calculateOverflow(event));
        return <Surface>
          <div onScroll={handleScroll}/>
          {!opaque && <Fade/>}
          {!opaque && <Hint/>}
          <View/><View/><View/><View/><View/><View/><View/><View/><View/><View/>
        </Surface>;
      }
      export function CompanionComputedScreen() {
        const [companion, setCompanion] = useState(false);
        const [measurement, setMeasurement] = useState(0);
        const handleScroll = (event: { currentTarget: { scrollTop: number } }) => {
          setCompanion(event.currentTarget.scrollTop > 0);
          setMeasurement(event.currentTarget.scrollTop);
        };
        return <Surface>
          <div onScroll={handleScroll}/>
          {!companion && <Fade/>}
          {!companion && <Hint/>}
          <Text>{measurement}</Text><View/><View/><View/><View/><View/><View/><View/><View/><View/>
        </Surface>;
      }
      export function EffectComputedScreen({ height }: { height: number }) {
        const [effectOwned, setEffectOwned] = useState(false);
        useEffect(() => setEffectOwned(height > 0), [height]);
        return <Surface>
          {!effectOwned && <Fade/>}
          {!effectOwned && <Hint/>}
          <View/><View/><View/><View/><View/><View/><View/><View/><View/><View/>
        </Surface>;
      }
      export function MeasuredEffectScreen() {
        const contentRef = useRef<HTMLDivElement>(null);
        const [measuredOverflow, setMeasuredOverflow] = useState(false);
        useEffect(() => {
          const content = contentRef.current;
          if (!content) return;
          setMeasuredOverflow(content.scrollHeight > content.clientHeight);
        }, []);
        return <Surface>
          <div ref={contentRef}><Content/></div>
          {measuredOverflow && <Fade/>}
          {measuredOverflow && <Hint/>}
          <View/><View/><View/><View/><View/><View/><View/><View/><View/><View/>
        </Surface>;
      }
      export function OpaqueMeasuredEffectScreen() {
        const contentRef = useRef<HTMLDivElement>(null);
        const [opaqueMeasured, setOpaqueMeasured] = useState(false);
        useEffect(() => setOpaqueMeasured(measureOverflow(contentRef.current)), []);
        return <Surface>
          <div ref={contentRef}><Content/></div>
          {opaqueMeasured && <Fade/>}
          {opaqueMeasured && <Hint/>}
          <View/><View/><View/><View/><View/><View/><View/><View/><View/><View/>
        </Surface>;
      }
      export function MixedMeasuredEffectScreen() {
        const contentRef = useRef<HTMLDivElement>(null);
        const [mixedMeasured, setMixedMeasured] = useState(false);
        useEffect(() => {
          const content = contentRef.current;
          if (content) setMixedMeasured(content.scrollHeight > content.clientHeight);
        }, []);
        return <Surface onClick={() => setMixedMeasured(false)}>
          <div ref={contentRef}><Content/></div>
          {mixedMeasured && <Fade/>}
          {mixedMeasured && <Hint/>}
          <View/><View/><View/><View/><View/><View/><View/><View/><View/><View/>
        </Surface>;
      }
      export function SeparatedMeasuredEffectScreen() {
        const contentRef = useRef<HTMLDivElement>(null);
        const [separatedMeasured, setSeparatedMeasured] = useState(false);
        useEffect(() => {
          const content = contentRef.current;
          if (content) setSeparatedMeasured(content.scrollHeight > content.clientHeight);
        }, []);
        return <Surface>
          <div ref={contentRef}><Content/></div>
          {separatedMeasured && <Fade/>}
          <Content/>
          {separatedMeasured && <Hint/>}
          <View/><View/><View/><View/><View/><View/><View/><View/><View/><View/>
        </Surface>;
      }
      export function RepeatedComputedScreen({ rows }: { rows: Array<{ id: string; hidden: boolean }> }) {
        const [repeated, setRepeated] = useState(false);
        const handleScroll = (event: { currentTarget: { scrollTop: number } }) => setRepeated(event.currentTarget.scrollTop > 0);
        return <section onScroll={handleScroll}>
          {rows.map(row => <View key={row.id}>{!repeated && <Fade/>}{!repeated && <Hint/>}</View>)}
          <View/><View/><View/><View/><View/><View/><View/><View/><View/><View/>
        </section>;
      }
      export function SeparatedComputedScreen() {
        const [separated, setSeparated] = useState(false);
        const handleScroll = (event: { currentTarget: { scrollTop: number } }) => setSeparated(event.currentTarget.scrollTop > 0);
        return <section onScroll={handleScroll}>
          {!separated && <Fade/>}
          <Content/>
          {!separated && <Hint/>}
          <View/><View/><View/><View/><View/><View/><View/><View/><View/><View/>
        </section>;
      }
    `,
    "utf8"
  );

  const report = await analyzePath(root);
  assert.equal(report.findings.find(finding => finding.name === "active")?.action, "use-observable");
  assert.equal(report.findings.find(finding => finding.name === "noisyActive")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "broadActive")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "branchActive")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "scrolled")?.action, "use-observable");
  assert.equal(report.findings.find(finding => finding.name === "customComputed")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "inlineComputed")?.action, "use-observable");
  assert.equal(report.findings.find(finding => finding.name === "opaque")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "companion")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "effectOwned")?.action, "delete-derived-state");
  assert.equal(report.findings.find(finding => finding.name === "measuredOverflow")?.action, "use-observable");
  assert.equal(report.findings.find(finding => finding.name === "opaqueMeasured")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "mixedMeasured")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "separatedMeasured")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "repeated")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "separated")?.action, "review-state");
});

test("traces a command payload through memoized options and source component wrappers", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-option-command-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "useShortcut.ts"),
    `
      import { useEffect } from "react";
      export function useShortcut(callback: () => void) {
        useEffect(() => subscribe(callback), [callback]);
      }
      export function useOptionShortcut({ options }: { options: { onConfirm: () => void } }) {
        useShortcut(() => options.onConfirm());
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "Button.tsx"),
    `
      function ButtonBase({ onPress = () => {} }: { onPress?: () => void }) {
        return <button onClick={onPress}>Confirm</button>;
      }
      const Button = Object.assign(ButtonBase, { Text: () => null });
      export default Button;
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "Footer.tsx"),
    `
      import React from "react";
      import Button from "./Button";
      import { useShortcut } from "./useShortcut";
      type Options = { onConfirm: () => void };
      function Footer({ options }: { options?: Options }) {
        const { onConfirm } = options ?? {};
        useShortcut(onConfirm!);
        return <Button onPress={onConfirm}>Confirm</Button>;
      }
      export default React.memo(Footer) as typeof Footer;
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "Selection.tsx"),
    `
      import Footer from "./Footer";
      import { useOptionShortcut } from "./useShortcut";
      type Options = { onConfirm: () => void };
      export function Selection({ ref, ...props }: { ref?: unknown; options: Options }) {
        return <BaseSelection {...props} />;
      }
      function BaseSelection(props: { options: Options }) {
        return <SelectionImpl {...props} />;
      }
      function SelectionImpl({ options }: { options: Options }) {
        useOptionShortcut({ options });
        return <Footer options={options} />;
      }
      export function EagerSelection({ options }: { options: Options }) {
        options.onConfirm();
        return <button>Unsafe</button>;
      }
      function EagerButton({ onConfirm }: { onConfirm: () => void }) {
        onConfirm();
        return <button>Unsafe wrapper</button>;
      }
      export function EagerPropSelection({ options }: { options: Options }) {
        return <EagerButton onConfirm={options.onConfirm} />;
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "Screens.tsx"),
    `
      import { useCallback, useEffect, useMemo, useState } from "react";
      import { EagerPropSelection, EagerSelection, Selection } from "./Selection";
      export function SafeScreen() {
        const [payload, setPayload] = useState<string>();
        useEffect(() => load((value: string) => setPayload(value)), []);
        const confirm = useCallback(() => send(payload), [payload]);
        const onConfirm = useCallback(() => prompt().then(() => confirm()), [confirm]);
        const options = useMemo(() => ({ onConfirm }), [onConfirm]);
        return <Selection options={options} />;
      }
      export function UnsafeScreen() {
        const [unsafePayload, setUnsafePayload] = useState<string>();
        useEffect(() => load((value: string) => setUnsafePayload(value)), []);
        const confirm = useCallback(() => send(unsafePayload), [unsafePayload]);
        const onConfirm = useCallback(() => prompt().then(() => confirm()), [confirm]);
        const options = useMemo(() => ({ onConfirm }), [onConfirm]);
        return <EagerSelection options={options} />;
      }
      export function UnsafePropScreen() {
        const [unsafePropPayload, setUnsafePropPayload] = useState<string>();
        useEffect(() => load((value: string) => setUnsafePropPayload(value)), []);
        const confirm = useCallback(() => send(unsafePropPayload), [unsafePropPayload]);
        const onConfirm = useCallback(() => prompt().then(() => confirm()), [confirm]);
        const options = useMemo(() => ({ onConfirm }), [onConfirm]);
        return <EagerPropSelection options={options} />;
      }
    `,
    "utf8"
  );

  const report = await analyzePath(root);
  assert.equal(report.findings.find(finding => finding.name === "payload")?.action, "use-ref");
  assert.equal(report.findings.find(finding => finding.name === "unsafePayload")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "unsafePropPayload")?.action, "review-state");
});

test("proves deferred context and higher-order callback paths and rejects eager readers", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-context-command-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "useLater.ts"),
    `
      import { useEffect } from "react";
      export function useLater(callback: () => void) {
        useEffect(() => subscribe(callback), [callback]);
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "Selections.tsx"),
    `
      import { createContext, useCallback, useContext, useMemo } from "react";
      import { useLater } from "./useLater";
      type Options = { onConfirm: () => void };
      const SafeContext = createContext({ onPress: () => {} });
      function useSafeContext() { return useContext(SafeContext); }
      function useGuard() {
        const guard = useCallback((action: () => void) => () => action(), []);
        return { guard };
      }
      function DeferredReader() {
        const { onPress } = useSafeContext();
        useLater(onPress);
        return null;
      }
      function SafeButton({ onPress }: { onPress: () => void }) {
        const value = useMemo(() => ({ onPress }), [onPress]);
        return <SafeContext.Provider value={value}><button onClick={onPress} /><DeferredReader /></SafeContext.Provider>;
      }
      export function SafeSelection({ options }: { options: Options }) {
        return <SafeButton onPress={options.onConfirm} />;
      }
      export function GuardSelection({ options }: { options: Options }) {
        const { guard } = useGuard();
        const confirm = useCallback(() => options.onConfirm(), [options]);
        return <button onClick={guard(confirm)} />;
      }
      const EagerContext = createContext({ onPress: () => {} });
      function useEagerContext() { return useContext(EagerContext); }
      function EagerReader() {
        const { onPress } = useEagerContext();
        onPress();
        return null;
      }
      function EagerButton({ onPress }: { onPress: () => void }) {
        const value = useMemo(() => ({ onPress }), [onPress]);
        return <EagerContext.Provider value={value}><EagerReader /></EagerContext.Provider>;
      }
      export function EagerSelection({ options }: { options: Options }) {
        return <EagerButton onPress={options.onConfirm} />;
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "Screens.tsx"),
    `
      import { useCallback, useEffect, useMemo, useState } from "react";
      import { EagerSelection, GuardSelection, SafeSelection } from "./Selections";
      export function SafeScreen() {
        const [payload, setPayload] = useState<string>();
        useEffect(() => load((value: string) => setPayload(value)), []);
        const onConfirm = useCallback(() => send(payload), [payload]);
        const options = useMemo(() => ({ onConfirm }), [onConfirm]);
        return <SafeSelection options={options} />;
      }
      export function EagerScreen() {
        const [eagerPayload, setEagerPayload] = useState<string>();
        useEffect(() => load((value: string) => setEagerPayload(value)), []);
        const onConfirm = useCallback(() => send(eagerPayload), [eagerPayload]);
        const options = useMemo(() => ({ onConfirm }), [onConfirm]);
        return <EagerSelection options={options} />;
      }
      export function GuardScreen() {
        const [guardPayload, setGuardPayload] = useState<string>();
        useEffect(() => load((value: string) => setGuardPayload(value)), []);
        const onConfirm = useCallback(() => send(guardPayload), [guardPayload]);
        const options = useMemo(() => ({ onConfirm }), [onConfirm]);
        return <GuardSelection options={options} />;
      }
    `,
    "utf8"
  );

  const report = await analyzePath(root);
  assert.equal(report.findings.find(finding => finding.name === "payload")?.action, "use-ref");
  assert.equal(report.findings.find(finding => finding.name === "guardPayload")?.action, "use-ref");
  assert.equal(report.findings.find(finding => finding.name === "eagerPayload")?.action, "review-state");
});

test("proves keyed record commands through source-resolved event wrappers", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-keyed-record-"));
  t.after(() => rm(root, { force: true, recursive: true }));
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
    "utf8"
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
    "utf8"
  );

  const report = await analyzePath(root);
  const safe = report.findings.find(finding => finding.name === "safeFeedback");
  const eager = report.findings.find(finding => finding.name === "eagerFeedback");
  assert.equal(safe?.action, "use-observable");
  assert.match(safe?.message ?? "", /dynamic entry/);
  assert.doesNotMatch(eager?.message ?? "", /dynamic entry/);
});

test("shares one cached AST across source indexing and both detector families", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-cached-ast-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const statePath = path.join(root, "state.ts");
  const leafPath = path.join(root, "Leaf.tsx");
  const screenPath = path.join(root, "Screen.tsx");
  await writeFile(
    statePath,
    'import { observable } from "@legendapp/state"; export const profile$ = observable({ name: "Ada", email: "ada@example.com" });',
    "utf8"
  );
  await writeFile(
    leafPath,
    "export function Leaf({ busy }: { busy: boolean }) { return <span>{String(busy)}</span>; }",
    "utf8"
  );
  const screenSource = `
    import { useState } from "react";
    import { useValue } from "@legendapp/state/react";
    import { Leaf } from "./Leaf";
    import { profile$ } from "./state";
    export function Screen() {
      const [busy, setBusy] = useState(false);
      const profile = useValue(profile$);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <button onClick={() => setBusy(true)}>Run</button><Leaf busy={busy} /><span>{profile.name}</span>
      </main>;
    }
  `;
  await writeFile(screenPath, screenSource, "utf8");

  const context = await createAnalysisContext(root);
  const file = context.project.getFile(screenPath);
  assert.ok(file);
  assert.strictEqual(context.project.getFile(screenPath)?.sourceFile, file.sourceFile);
  const reportName = "Screen.tsx";
  const components = context.sourceIndex.componentsFor(screenPath);
  const observables = context.sourceIndex.observablesFor(screenPath);
  const factories = context.sourceIndex.observableFactoriesFor(screenPath);

  assert.deepEqual(
    analyzeSourceFile(file, reportName, components),
    analyzeSource(screenSource, reportName, components)
  );
  assert.deepEqual(
    analyzeLegendPracticesFile(file, reportName, observables, factories),
    analyzeLegendPractices(screenSource, reportName, observables, factories)
  );

  const report = await analyzePath(root, context);
  assert.equal(report.findings.find(finding => finding.name === "busy")?.action, "use-observable");
  assert.equal(report.practices[0]?.action, "narrow-use-value-subscription");
});

test("keeps display-path harness semantics separate from cached absolute identity", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-display-path-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const harnessDirectory = path.join(root, "src", "__tests__");
  await mkdir(harnessDirectory, { recursive: true });
  const harnessPath = path.join(harnessDirectory, "Screen.tsx");
  await writeFile(
    harnessPath,
    `
      import { useState } from "react";
      export function Screen() {
        const [busy, setBusy] = useState(false);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
          <button onClick={() => setBusy(true)} /><Leaf busy={busy} />
        </main>;
      }
    `,
    "utf8"
  );

  const directoryFinding = (await analyzePath(root)).findings[0];
  const focusedFinding = (await analyzePath(harnessPath)).findings[0];
  assert.equal(directoryFinding?.action, "keep-state");
  assert.equal(directoryFinding?.location.file, path.join("src", "__tests__", "Screen.tsx"));
  assert.equal(focusedFinding?.action, "use-observable");
  assert.equal(focusedFinding?.location.file, "Screen.tsx");
});

test("keeps JavaScript and JSX practice results stable through the cached parser", () => {
  for (const extension of ["js", "jsx", "mjs", "cjs"] as const) {
    const fileName = `screen.${extension}`;
    const source = `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const profile$ = observable({ name: "Ada" });
      /** @returns {string} */
      export function read() {
        const profile = useValue(profile$);
        return profile.name;
      }
    `;
    const file = new AnalysisProject(new Map([[fileName, source]])).files[0];
    assert.ok(file);
    assert.deepEqual(
      analyzeLegendPracticesFile(file, fileName),
      analyzeLegendPractices(source, fileName),
      extension
    );
  }
});

test("reports optional semantic coverage only for an explicit tsconfig shard", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-semantic-context-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const sourcePath = path.join(root, "screen.ts");
  const configFilePath = path.join(root, "tsconfig.json");
  await writeFile(sourcePath, "export const value: string = 'ready';", "utf8");
  await writeFile(
    configFilePath,
    JSON.stringify({ compilerOptions: { strict: true }, files: ["screen.ts"] }),
    "utf8"
  );

  const context = await createAnalysisContext(root, { configFilePath });
  const detailed = await analyzePathDetailed(root, context);

  assert.ok(context.semanticContext);
  assert.deepEqual(detailed.diagnostics.semantic, []);
  assert.equal(detailed.coverage.entries[0]?.stages.semantic.status, "analyzed");
});

test("does not require application component provenance for a focused call-site wrapper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-context-"));
  const components = path.join(root, "components");
  const screens = path.join(root, "screens");
  await mkdir(components);
  await mkdir(screens);
  await writeFile(
    path.join(components, "Leaf.tsx"),
    'export function Leaf({ value }: { value: string }) { return <output>{value}</output>; }'
  );
  const screen = path.join(screens, "Screen.tsx");
  await writeFile(
    screen,
    `
      import { useState } from "react";
      import { Leaf } from "../components/Leaf";
      export function Screen() {
        const [value, setValue] = useState("idle");
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
          <button onClick={() => setValue("done")}>Done</button><Leaf value={value} /></main>;
      }
    `
  );

  const focused = await analyzePath(screen);
  assert.equal(focused.findings[0]?.action, "use-observable");

  const context = await createAnalysisContext(root);
  const contextual = await analyzePath(screen, context);
  assert.equal(contextual.files, 1);
  assert.equal(contextual.findings[0]?.location.file, "Screen.tsx");
  assert.equal(contextual.findings[0]?.action, "use-observable");
});

test("rejects targets outside a shared analysis project", async t => {
  const contextRoot = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-context-root-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-target-root-"));
  t.after(() => rm(contextRoot, { force: true, recursive: true }));
  t.after(() => rm(targetRoot, { force: true, recursive: true }));
  await writeFile(path.join(contextRoot, "owned.ts"), "export const owned = true;", "utf8");
  const targetPath = path.join(targetRoot, "foreign.ts");
  await writeFile(targetPath, "export const foreign = true;", "utf8");

  const context = await createAnalysisContext(contextRoot);

  await assert.rejects(
    analyzePath(targetPath, context),
    /analysis context does not own target file/
  );
});

test("uses cross-file observable provenance for batching findings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-import-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(
      path.join(root, "state", "player.ts"),
      `
        import { observable } from "@legendapp/state";
        export const player$ = observable({ loading: false, error: null as string | null });
      `,
      "utf8"
    );
    await writeFile(
      path.join(root, "screen.ts"),
      `
        import { player$ } from "./state/player";
        export function fail(message: string) {
          player$.error.set(message);
          player$.loading.set(false);
        }
      `,
      "utf8"
    );

    const report = await analyzePath(root);
    assert.equal(report.practices.length, 1);
    assert.equal(report.practices[0]?.action, "assign-observable-fields");
    assert.equal(report.practices[0]?.location.file, "screen.ts");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("uses typed project factory provenance for narrow leaf subscriptions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-factory-"));
  try {
    await writeFile(
      path.join(root, "create-store.ts"),
      `
        import { observable, type Observable } from "@legendapp/state";
        export function createStore<T>(value: T): Observable<T> {
          return observable(value);
        }
      `,
      "utf8"
    );
    await writeFile(
      path.join(root, "screen.tsx"),
      `
        import { useValue } from "@legendapp/state/react";
        import { createStore } from "./create-store";
        const state$ = createStore({ profile: { name: "Ada", email: "ada@example.com" } });
        function Name(profile$: typeof state$.profile) {
          const profile = useValue(profile$);
          return <span>{profile.name}</span>;
        }
        export function Screen() { return <span>{Name(state$.profile)}</span>; }
      `,
      "utf8"
    );

    const report = await analyzePath(root);
    assert.deepEqual(report.practices.map(finding => finding.action), [
      "narrow-use-value-subscription",
    ]);
    assert.match(report.practices[0]?.message ?? "", /useValue\(profile\$\.name\)/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("uses cross-file observable provenance for direct useValue findings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-read-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(
      path.join(root, "state", "theme.ts"),
      `
        import { observable } from "@legendapp/state";
        export const theme$ = observable({ accent: "blue" });
      `,
      "utf8"
    );
    await writeFile(
      path.join(root, "screen.tsx"),
      `
        import { useValue as observe } from "@legendapp/state/react";
        import { theme$ } from "./state/theme";
        export function Screen() {
          return <span>{observe(() => theme$.accent.get())}</span>;
        }
      `,
      "utf8"
    );

    const report = await analyzePath(root);
    assert.equal(report.practices.length, 1);
    assert.equal(report.practices[0]?.action, "pass-observable-to-use-value");
    assert.equal(report.practices[0]?.location.file, "screen.tsx");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("uses peek only for a source-proven effect callback prop", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-effect-callback-read-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "state.ts"),
    `
      import { observable } from "@legendapp/state";
      export const state$ = observable({ ready: false, mixed: false, forwarded: false });
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "consumers.tsx"),
    `
      import { memo, useLayoutEffect } from "react";
      const typedMemo = memo as typeof memo;
      export const EffectConsumer = typedMemo(function EffectConsumer({ project }: { project: () => unknown }) {
        useLayoutEffect(() => { project(); }, [project]);
        return null;
      });
      export function MixedConsumer({ project }: { project: () => unknown }) {
        project();
        useLayoutEffect(() => { project(); }, [project]);
        return null;
      }
      export function ForwardedEffectConsumer({ project }: { project: () => unknown }) {
        useLayoutEffect(() => { subscribe(project); }, [project]);
        return null;
      }
      declare function subscribe(callback: () => unknown): void;
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "screen.tsx"),
    `
      import { EffectConsumer, ForwardedEffectConsumer, MixedConsumer } from "./consumers";
      import { state$ } from "./state";
      export function Screen() {
        return <>
          <EffectConsumer project={() => state$.ready.get()} />
          <MixedConsumer project={() => state$.mixed.get()} />
          <ForwardedEffectConsumer project={() => state$.forwarded.get()} />
        </>;
      }
    `,
    "utf8"
  );

  const report = await analyzePath(root);
  const findings = report.practices.filter(finding => finding.action === "use-peek-for-snapshot");
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? "", /state\$\.ready\.peek\(\)/);
  assert.match(findings[0]?.evidence.join(" ") ?? "", /source-proven React effect callback/);
});

test("uses source-proven wrapper member provenance without treating the wrapper as observable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-member-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(
      path.join(root, "state", "controller.ts"),
      `
        import { observable } from "@legendapp/state";
        function createController() {
          return {
            value$: observable({ profile: { name: "Ada", email: "ada@example.com" } }),
            set: (value: unknown) => value,
          };
        }
        export const controller = createController();
      `,
      "utf8"
    );
    await writeFile(
      path.join(root, "state", "index.ts"),
      'export { controller as dialog } from "./controller";',
      "utf8"
    );
    await writeFile(
      path.join(root, "screen.tsx"),
      `
        import { useValue } from "@legendapp/state/react";
        import { dialog } from "./state";
        export function Screen() {
          const value = useValue(dialog.value$);
          dialog.set({ state: false });
          return <span>{value.profile.name}</span>;
        }
      `,
      "utf8"
    );

    const context = await createAnalysisContext(root);
    assert.deepEqual(
      [...context.sourceIndex.observablePathsFor(path.join(root, "screen.tsx"))],
      ["dialog.value$"]
    );
    const report = await analyzePath(root, context);
    assert.deepEqual(report.practices.map(finding => finding.action), [
      "narrow-use-value-subscription",
    ]);
    assert.match(report.practices[0]?.message ?? "", /useValue\(dialog\.value\$\.profile\.name\)/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("analyzes useValue-only files for the narrowest observable child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-observable-child-read-"));
  try {
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(
      path.join(root, "state", "profile.ts"),
      `
        import { observable } from "@legendapp/state";
        export const profile$ = observable({ name: "Ada", email: "ada@example.com" });
      `,
      "utf8"
    );
    await writeFile(
      path.join(root, "screen.tsx"),
      `
        import { useValue } from "@legendapp/state/react";
        import { profile$ } from "./state/profile";
        export function Screen() {
          const profile = useValue(profile$);
          return <span>{profile.name}</span>;
        }
      `,
      "utf8"
    );

    const report = await analyzePath(root);
    assert.equal(report.practices.length, 1);
    assert.equal(report.practices[0]?.action, "narrow-use-value-subscription");
    assert.equal(report.practices[0]?.location.file, "screen.tsx");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("places an observable subscription at one resolved child call site", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-contract-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{busy ? "Busy" : "Ready"}</span>; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const [busy, setBusy] = useState(false);
        const run = async () => { setBusy(true); await work(); setBusy(false); };
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><StatusLeaf busy={busy} onRun={run} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "busy");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /stable `StatusLeaf` call site/);
});

test("verifies a leaf child contract before promoting the transport", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-child-leaf-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    `
      export function StatusLeaf({ busy }: { busy: boolean }) {
        const label = busy ? "Busy" : "Ready";
        return <section data-busy={busy}><span>{label}</span></section>;
      }
    `
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const [busy, setBusy] = useState(true);
        const run = async () => { setBusy(false); await work(); };
        ${"\n".repeat(150)}
        const content = (
          <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
            <Actions /><Preview /><button onClick={run} /><StatusLeaf busy={busy} /></main>
        );
        return <Shell>{content}</Shell>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "busy");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /child contract is verified/);
  assert.match(finding?.message ?? "", /renders the `busy` value directly/);
});

test("proves memoized option commands through a resolved deferred child", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-option-command-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "useDeferredHandler.ts"),
    `
      import { useEffect } from "react";
      export function useDeferredHandler(callback: () => void) {
        useEffect(() => {
          window.addEventListener("click", callback);
          return () => window.removeEventListener("click", callback);
        }, [callback]);
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "ActionMenu.tsx"),
    `
      import { useDeferredHandler } from "./useDeferredHandler";
      export function ActionMenu({ ref, ...props }: { ref?: unknown; options: Array<{ onSelected?: () => void }> }) {
        const { options } = props;
        const first = options.at(0);
        const runFirst = () => first?.onSelected?.();
        useDeferredHandler(() => runFirst());
        return <section>
          <button onClick={runFirst}>Run</button>
          <Menu items={options.map(item => ({ ...item, onSelected: () => item.onSelected?.() }))} />
        </section>;
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "ImmediateMenu.tsx"),
    `
      import { useEffect } from "react";
      export function ImmediateMenu({ options }: { options: Array<{ onSelected?: () => void }> }) {
        const first = options.at(0);
        first?.onSelected?.();
        useEffect(() => first?.onSelected?.(), [first]);
        return <section />;
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "SynchronousMenu.tsx"),
    `
      export function SynchronousMenu({ options }: { options: Array<{ onSelected?: () => void }> }) {
        options.map(item => runImmediately(() => item.onSelected?.()));
        return <section />;
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "UnknownHookMenu.tsx"),
    `
      export function UnknownHookMenu({ options }: { options: Array<{ onSelected?: () => void }> }) {
        const first = options.at(0);
        const runFirst = () => first?.onSelected?.();
        useLibraryLifecycle(() => runFirst());
        return <section />;
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useMemo, useState } from "react";
      import { ActionMenu } from "./ActionMenu";
      import { ImmediateMenu } from "./ImmediateMenu";
      import { SynchronousMenu } from "./SynchronousMenu";
      import { UnknownHookMenu } from "./UnknownHookMenu";
      function DecisionModal(_props: unknown) { return null; }
      export function SafeScreen() {
        const [visible, setVisible] = useState(false);
        const options = useMemo(() => [{ onSelected: () => download(() => setVisible(true)) }], []);
        ${"\n".repeat(100)}
        return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
          {options.length > 0 && <ActionMenu options={options} />}
          <DecisionModal isVisible={visible} onClose={() => setVisible(false)} />
        </main>;
      }
      export function UnsafeScreen() {
        const [unsafeVisible, setUnsafeVisible] = useState(false);
        const options = useMemo(() => [{ onSelected: () => download(() => setUnsafeVisible(true)) }], []);
        ${"\n".repeat(100)}
        return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
          <ImmediateMenu options={options} />
          <DecisionModal isVisible={unsafeVisible} onClose={() => setUnsafeVisible(false)} />
        </main>;
      }
      export function SynchronousScreen() {
        const [syncVisible, setSyncVisible] = useState(false);
        const options = useMemo(() => [{ onSelected: () => download(() => setSyncVisible(true)) }], []);
        ${"\n".repeat(100)}
        return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
          <SynchronousMenu options={options} />
          <DecisionModal isVisible={syncVisible} onClose={() => setSyncVisible(false)} />
        </main>;
      }
      export function UnknownHookScreen() {
        const [hookVisible, setHookVisible] = useState(false);
        const options = useMemo(() => [{ onSelected: () => download(() => setHookVisible(true)) }], []);
        ${"\n".repeat(100)}
        return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
          <UnknownHookMenu options={options} />
          <DecisionModal isVisible={hookVisible} onClose={() => setHookVisible(false)} />
        </main>;
      }
    `,
    "utf8"
  );

  const report = await analyzePath(root);
  assert.equal(report.findings.find(finding => finding.name === "visible")?.action, "use-observable");
  assert.equal(report.findings.find(finding => finding.name === "unsafeVisible")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "syncVisible")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "hookVisible")?.action, "review-state");
});

test("isolates a resolved leaf updated outside a named React transition", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-named-transition-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "AvatarLeaf.tsx"),
    `
      export function AvatarLeaf({ url, onChange }: { url: string; onChange: (url: string) => void }) {
        return <input value={url} onChange={event => onChange(event.target.value)} />;
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState, useTransition } from "react";
      import { AvatarLeaf } from "./AvatarLeaf";
      export function Screen() {
        const [url, setUrl] = useState("");
        const [busy, setBusy] = useState(false);
        const [, startSaving] = useTransition();
        const performSave = async () => {
          setBusy(true);
          const steps = [{ run: async () => saveAvatar(url) }];
          await Promise.all(steps.map(step => step.run()));
          setBusy(false);
        };
        const submit = () => startSaving(performSave);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><AvatarLeaf url={url} onChange={setUrl} />
          <button onClick={submit} disabled={busy}>Save</button></main>;
      }
      export function Published() {
        const [publishedUrl, setPublishedUrl] = useState("");
        const [, startSaving] = useTransition();
        const performSave = async () => saveAvatar(publishedUrl);
        const task = { run: performSave };
        const submit = () => startSaving(performSave);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><AvatarLeaf url={publishedUrl} onChange={setPublishedUrl} />
          <Registry task={task} /><button onClick={submit}>Save</button></main>;
      }
    `,
    "utf8"
  );

  const report = await analyzePath(root);
  assert.equal(report.findings.find(finding => finding.name === "url")?.action, "use-observable");
  assert.equal(report.findings.find(finding => finding.name === "busy")?.action, "review-state");
  assert.equal(report.findings.find(finding => finding.name === "publishedUrl")?.action, "review-state");
});

test("keeps nested transition reads when the transition is not event-rooted", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-effect-transition-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "AvatarLeaf.tsx"),
    `
      export function AvatarLeaf({ url, onChange }: { url: string; onChange: (url: string) => void }) {
        return <input value={url} onChange={event => onChange(event.target.value)} />;
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useEffect, useState, useTransition } from "react";
      import { AvatarLeaf } from "./AvatarLeaf";
      export function Screen({ save }: { save: boolean }) {
        const [url, setUrl] = useState("");
        const [, startSaving] = useTransition();
        const performSave = async () => {
          const steps = [{ run: async () => saveAvatar(url) }];
          await Promise.all(steps.map(step => step.run()));
        };
        useEffect(() => {
          if (save) startSaving(performSave);
        }, [save]);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><AvatarLeaf url={url} onChange={setUrl} /></main>;
      }
    `,
    "utf8"
  );

  const report = await analyzePath(root);
  assert.equal(report.findings.find(finding => finding.name === "url")?.action, "review-state");
});

test("abstains when the resolved child stores the prop in its own state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-child-state-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    `
      import { useState } from "react";
      export function StatusLeaf({ busy }: { busy: boolean }) {
        const [seen, setSeen] = useState(busy);
        return <span>{String(seen)}</span>;
      }
    `
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const [busy, setBusy] = useState(true);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setBusy(false)} /><button onClick={() => setBusy(true)} />
          <StatusLeaf busy={busy} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "busy");
  assert.doesNotMatch(finding?.message ?? "", /child contract is verified/);
});

test("abstains when the resolved child forwards the prop to another component", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-child-fwd-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    `
      import { Inner } from "./Inner";
      export function StatusLeaf({ busy }: { busy: boolean }) {
        return <Inner busy={busy} />;
      }
    `
  );
  await writeFile(path.join(root, "Inner.tsx"), 'export const Inner = () => null;');
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const [busy, setBusy] = useState(true);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setBusy(false)} /><button onClick={() => setBusy(true)} />
          <StatusLeaf busy={busy} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "busy");
  assert.doesNotMatch(finding?.message ?? "", /child contract is verified/);
});

test("isolates a compact transported leaf only with an independent sibling render cut", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-compact-leaf-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "NativeMenu.tsx"),
    `
      import { NativeRoot } from "native-menu";
      export function NativeMenu({ expanded, onDismiss }: { expanded: boolean; onDismiss: () => void }) {
        return <NativeRoot expanded={expanded} onDismiss={onDismiss} />;
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { NativeMenu } from "./NativeMenu";
      export function CompactMenu() {
        const [expanded, setExpanded] = useState(false);
        const open = () => setExpanded(true);
        const dismiss = () => setExpanded(false);
        return <main>
          <Toolbar />
          <button onClick={open}>Open</button>
          <Host><NativeMenu expanded={expanded} onDismiss={dismiss} /></Host>
        </main>;
      }
      export function CohesiveMenu() {
        const [cohesiveOpen, setCohesiveOpen] = useState(false);
        return <NativeMenu
          expanded={cohesiveOpen}
          onDismiss={() => setCohesiveOpen(false)}
        />;
      }
      export function CoupledMenu() {
        const [coupledOpen, setCoupledOpen] = useState(false);
        const [mode, setMode] = useState("idle");
        const open = () => { setCoupledOpen(true); setMode("active"); };
        const dismiss = () => { setCoupledOpen(false); setMode("idle"); };
        return <main>
          <Toolbar />
          <button onClick={open}>Open</button>
          <Host data-mode={mode}><NativeMenu expanded={coupledOpen} onDismiss={dismiss} /></Host>
        </main>;
      }
      export function OrderedMenu() {
        const [orderedOpen, setOrderedOpen] = useState(false);
        const open = () => setOrderedOpen(true);
        const dismiss = () => { setOrderedOpen(false); navigateAway(); };
        return <main>
          <Toolbar />
          <button onClick={open}>Open</button>
          <Host><NativeMenu expanded={orderedOpen} onDismiss={dismiss} /></Host>
        </main>;
      }
      export function ForwardedSetterMenu() {
        const [forwardedOpen, setForwardedOpen] = useState(false);
        const open = () => setForwardedOpen(true);
        return <main>
          <Toolbar />
          <button onClick={open}>Open</button>
          <Host><NativeMenu expanded={forwardedOpen} onDismiss={setForwardedOpen} /></Host>
        </main>;
      }
    `,
    "utf8"
  );

  const report = await analyzePath(root);
  const compact = report.findings.find(finding => finding.name === "expanded");
  const cohesive = report.findings.find(finding => finding.name === "cohesiveOpen");
  const coupled = report.findings.find(finding => finding.name === "coupledOpen");
  const ordered = report.findings.find(finding => finding.name === "orderedOpen");
  const forwarded = report.findings.find(finding => finding.name === "forwardedOpen");
  assert.equal(compact?.action, "use-observable");
  assert.match(compact?.message ?? "", /independent sibling render cut/);
  assert.notEqual(cohesive?.action, "use-observable");
  assert.notEqual(coupled?.action, "use-observable");
  assert.notEqual(ordered?.action, "use-observable");
  assert.notEqual(forwarded?.action, "use-observable");
});

test("abstains when the resolved child reads the prop inside effects or callbacks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-child-effect-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    `
      import { useEffect } from "react";
      export function StatusLeaf({ busy }: { busy: boolean }) {
        useEffect(() => report(busy), [busy]);
        return <span>{String(busy)}</span>;
      }
    `
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const [busy, setBusy] = useState(true);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setBusy(false)} /><button onClick={() => setBusy(true)} />
          <StatusLeaf busy={busy} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "busy");
  assert.doesNotMatch(finding?.message ?? "", /child contract is verified/);
});

test("does not require child prop semantics for a call-site subscription wrapper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-call-site-"));
  await writeFile(
    path.join(root, "Leaf.tsx"),
    `
      import { useEffect } from "react";
      export function Leaf({ open }: { open: boolean }) {
        useEffect(() => report(open), [open]);
        return <aside />;
      }
    `
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Leaf } from "./Leaf";
      export function Screen() {
        const [open, setOpen] = useState(false);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setOpen(true)} /><Leaf open={open} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "open");
  assert.equal(finding?.action, "use-observable");
});

test("proves direct source-component callback timing before replacing command-only state", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-source-callback-state-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Forms.tsx"),
    `
      import { useEffect } from "react";
      export function DeferredForm({ validate }: { validate: () => boolean }) {
        return <button onClick={() => validate()}>Validate</button>;
      }
      export function EagerForm({ validate }: { validate: () => boolean }) {
        const valid = validate();
        return <span>{String(valid)}</span>;
      }
      export function EffectForm({ validate }: { validate: () => boolean }) {
        useEffect(() => { validate(); }, [validate]);
        return null;
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useCallback, useEffect, useState } from "react";
      import { DeferredForm, EagerForm, EffectForm } from "./Forms";
      export function SafeScreen() {
        const [enabled, setEnabled] = useState(false);
        useEffect(() => setEnabled(true), []);
        const validate = useCallback(() => enabled, [enabled]);
        return <DeferredForm validate={validate} />;
      }
      export function UnsafeScreen() {
        const [eager, setEager] = useState(false);
        useEffect(() => setEager(true), []);
        const validate = useCallback(() => eager, [eager]);
        return <EagerForm validate={validate} />;
      }
      export function MixedScreen() {
        const [mixed, setMixed] = useState(false);
        useEffect(() => setMixed(true), []);
        const validate = useCallback(() => mixed, [mixed]);
        return <><DeferredForm validate={validate} /><EagerForm validate={validate} /></>;
      }
      export function EffectScreen() {
        const [effect, setEffect] = useState(false);
        useEffect(() => setEffect(true), []);
        const validate = useCallback(() => effect, [effect]);
        return <EffectForm validate={validate} />;
      }
    `,
    "utf8"
  );

  const report = await analyzePath(root);
  const states = new Map(
    report.findings
      .filter(finding => finding.hook === "useState")
      .map(finding => [finding.name, finding.action])
  );
  assert.equal(states.get("enabled"), "use-ref");
  assert.equal(states.get("eager"), "review-state");
  assert.equal(states.get("mixed"), "review-state");
  assert.equal(states.get("effect"), "review-state");
});

test("moves reset effects through source wrappers into Base UI event callbacks", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-base-ui-reset-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Controls.tsx"),
    `
      import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
      import { Select as SelectPrimitive } from "@base-ui/react/select";
      export function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
        return <TabsPrimitive.Root className={className} {...props} />;
      }
      function Select(props: SelectPrimitive.Root.Props<string>) {
        return <SelectPrimitive.Root {...props} />;
      }
      function FilterSelect({ value, onValueChange }: { value: string; onValueChange: (value: string) => void }) {
        return <Select value={value} onValueChange={next => onValueChange(String(next))} />;
      }
      export function Toolbar({ filters = [] }: { filters?: { value: string; onChange: (value: string) => void }[] }) {
        return filters.map(filter => filter.onChange ? (
          <FilterSelect key={filter.value} value={filter.value} onValueChange={filter.onChange} />
        ) : null);
      }
      export function EagerToolbar({ filters }: { filters: { onChange: (value: string) => void }[] }) {
        filters[0]?.onChange("render");
        return null;
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useEffect, useState } from "react";
      import { EagerToolbar, Tabs, Toolbar } from "./Controls";
      export function SafeTabsScreen() {
        const [period, setPeriod] = useState("week");
        const [page, setPage] = useState(1);
        useEffect(() => setPage(1), [period]);
        return <main>
          <Tabs value={period} onValueChange={value => setPeriod(String(value))} />
          <button onClick={() => setPage(value => value + 1)}>{page}</button>
        </main>;
      }
      export function SafeToolbarScreen() {
        const [type, setType] = useState("all");
        const [member, setMember] = useState("all");
        const [page, setPage] = useState(1);
        useEffect(() => setPage(1), [type, member]);
        return <main>
          <Toolbar filters={[{ value: type, onChange: setType }, { value: member, onChange: setMember }]} />
          <button onClick={() => setPage(value => value + 1)}>{page}</button>
        </main>;
      }
      export function UnsafeScreen() {
        const [type, setType] = useState("all");
        const [page, setPage] = useState(1);
        useEffect(() => setPage(1), [type]);
        return <main>
          <EagerToolbar filters={[{ onChange: setType }]} />
          <button onClick={() => setPage(value => value + 1)}>{page}</button>
        </main>;
      }
    `,
    "utf8"
  );

  const report = await analyzePath(root);
  const effects = report.findings.filter(finding => finding.hook === "useEffect");
  assert.equal(effects[0]?.action, "move-to-event");
  assert.equal(effects[1]?.action, "move-to-event");
  assert.equal(effects[2]?.action, "review-effect");
});

test("isolates pure controlled projections owned by one source component call site", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-controlled-callsite-projection-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Details.tsx"),
    `
      export function Dashboard() {
        return <section>Independent content</section>;
      }
      export function DetailDialog({ open, resourceId, onOpenChange }: {
        open: boolean;
        resourceId: string | null;
        onOpenChange: (open: boolean) => void;
      }) {
        return <dialog open={open} data-resource={resourceId} onClose={() => onOpenChange(false)} />;
      }
    `,
    "utf8"
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Dashboard, DetailDialog } from "./Details";
      declare function normalize(open: boolean): string | null;
      export function SafeScreen({ id }: { id: string }) {
        const [open, setOpen] = useState(false);
        return <main>
          <Dashboard />
          <span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span />
          <button onClick={() => setOpen(true)}>Open</button>
          <DetailDialog resourceId={open ? id : null} open={open} onOpenChange={setOpen} />
        </main>;
      }
      export function UnsafeScreen() {
        const [open, setOpen] = useState(false);
        return <main>
          <Dashboard />
          <span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span />
          <button onClick={() => setOpen(true)}>Open</button>
          <DetailDialog resourceId={normalize(open)} open={open} onOpenChange={setOpen} />
        </main>;
      }
    `,
    "utf8"
  );

  const report = await analyzePath(root);
  const states = report.findings.filter(finding => finding.hook === "useState");
  assert.equal(states[0]?.action, "use-observable");
  assert.equal(states[1]?.action, "review-state");
});

test("wraps a shared primitive locally without changing its API", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-shared-primitive-"));
  await mkdir(path.join(root, "components", "ui"), { recursive: true });
  await writeFile(
    path.join(root, "components", "ui", "Dialog.tsx"),
    'export function Dialog({ open }: { open: boolean }) { return open ? <aside /> : null; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Dialog } from "./components/ui/Dialog";
      export function Screen() {
        const [open, setOpen] = useState(false);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setOpen(true)} /><Dialog open={open} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "open");
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /call-site leaf wrapper/);
});

test("moves non-boolean controlled state into a stable local wrapper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-controlled-call-site-"));
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Tabs } from "some-ui-library";
      export function Screen() {
        const [tab, setTab] = useState("summary");
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><Tabs value={tab} onValueChange={setTab} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "tab");
  assert.equal(finding?.action, "move-state-down");
  assert.match(finding?.message ?? "", /stable local wrapper/);
});

test("does not create a second observable for state initialized from a hook result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-hook-initializer-"));
  await writeFile(
    path.join(root, "Input.tsx"),
    'export function Input({ value, onChange }: { value: string; onChange: (value: string) => void }) { return <input value={value} onChange={event => onChange(event.target.value)} />; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Input } from "./Input";
      export function Screen() {
        const saved = useWriterName();
        const [name, setName] = useState(saved);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><Input value={name} onChange={setName} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "name");
  assert.notEqual(finding?.action, "use-observable");
});

test("allows repeated row commands when the value has one stable leaf consumer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-repeated-command-"));
  await writeFile(
    path.join(root, "Leaves.tsx"),
    `
      export function Row({ onSelect }: { onSelect: (id: string) => void }) { return <button onClick={() => onSelect("x")} />; }
      export function Dialog({ selected }: { selected: string | null }) { return selected ? <aside /> : null; }
    `
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
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "selected");
  assert.equal(finding?.action, "use-observable");
});

test("keeps observable ownership stable when its one leaf subscription mounts conditionally", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-contract-conditional-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{busy ? "Busy" : "Ready"}</span>; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen({ visible }: { visible: boolean }) {
        const [busy, setBusy] = useState(false);
        const run = async () => { setBusy(true); await work(); setBusy(false); };
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview />{visible ? <StatusLeaf busy={busy} onRun={run} /> : null}</main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "busy");
  assert.equal(finding?.action, "use-observable");
});

test("does not promote one imported-child state when its writes still invalidate the owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-contract-cluster-"));
  await writeFile(
    path.join(root, "DialogLeaf.tsx"),
    'export function DialogLeaf({ open }: { open: boolean }) { return open ? <aside /> : null; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { DialogLeaf } from "./DialogLeaf";
      export function Screen() {
        const [open, setOpen] = useState(false);
        const [selection, setSelection] = useState<string | null>(null);
        const show = (id: string) => { setSelection(id); setOpen(true); };
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => show("a")} />
          <span>{selection}</span><DialogLeaf open={open} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "open");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not promote imported-child state written by an effect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-contract-effect-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{busy ? "Busy" : "Ready"}</span>; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useEffect, useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen({ running }: { running: boolean }) {
        const [busy, setBusy] = useState(false);
        useEffect(() => setBusy(running), [running]);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><StatusLeaf busy={busy} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "busy");
  assert.doesNotMatch(finding?.message ?? "", /child contract is verified/);
});

test("does not promote a leaf call site when commands share reactive mutation ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-leaf-mutation-"));
  await writeFile(
    path.join(root, "StatusLeaf.tsx"),
    'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{busy ? "Busy" : "Ready"}</span>; }'
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const { mutateAsync: save } = useSave();
        const [busy, setBusy] = useState(false);
        const run = async () => { setBusy(true); try { await save(); } finally { setBusy(false); } };
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={run} /><StatusLeaf busy={busy} /></main>;
      }
    `
  );

  const report = await analyzePath(root);
  const finding = report.findings.find(candidate => candidate.name === "busy");
  assert.doesNotMatch(finding?.message ?? "", /child contract is verified/);
});

test("does not promote a leaf call site inside an opaque render callback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-render-callback-"));
  await writeFile(path.join(root, "StatusLeaf.tsx"), 'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{String(busy)}</span>; }');
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const [busy, setBusy] = useState(false);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setBusy(true)} />
          <VirtualList renderItem={() => <StatusLeaf busy={busy} />} /></main>;
      }
    `
  );
  const finding = (await analyzePath(root)).findings.find(candidate => candidate.name === "busy");
  assert.notEqual(finding?.action, "use-observable");
});

test("resolves event producers before isolating projections inside JSX child callbacks", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-child-callback-projection-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Surfaces.tsx"),
    `
      export function DeferredSurface({ onHover, children }) {
        return <div onMouseEnter={onHover}>{children}</div>;
      }
      export function EagerSurface({ onHover, children }) {
        onHover();
        return <div>{children}</div>;
      }
    `
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { DeferredSurface, EagerSurface } from "./Surfaces";
      export function Screen() {
        const [safe, setSafe] = useState(false);
        const [unsafe, setUnsafe] = useState(false);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <Picker>{() => <DeferredSurface onHover={() => setSafe(true)}><Icon fill={safe ? "green" : "gray"} /></DeferredSurface>}</Picker>
          <Picker>{() => <EagerSurface onHover={() => setUnsafe(true)}><Icon fill={unsafe ? "green" : "gray"} /></EagerSurface>}</Picker>
        </main>;
      }
    `
  );

  const report = await analyzePath(root);
  assert.equal(report.findings.find(finding => finding.name === "safe")?.action, "use-observable");
  assert.equal(report.findings.find(finding => finding.name === "unsafe")?.action, "review-state");
});

test("does not miss reactive mutation ownership through a hook result object", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-object-mutation-"));
  await writeFile(path.join(root, "StatusLeaf.tsx"), 'export function StatusLeaf({ busy }: { busy: boolean }) { return <span>{String(busy)}</span>; }');
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { StatusLeaf } from "./StatusLeaf";
      export function Screen() {
        const save = useSave();
        const [busy, setBusy] = useState(false);
        const run = async () => { setBusy(true); try { await save.mutateAsync(); } finally { setBusy(false); } };
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={run} /><StatusLeaf busy={busy} /></main>;
      }
    `
  );
  const finding = (await analyzePath(root)).findings.find(candidate => candidate.name === "busy");
  assert.notEqual(finding?.action, "use-observable");
});

test("does not put nullable callable state into a leaf observable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-callable-leaf-"));
  await writeFile(path.join(root, "Slot.tsx"), 'export function Slot({ value }: { value: (() => void) | null }) { return <button onClick={value ?? undefined} />; }');
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { Slot } from "./Slot";
      export function Screen() {
        const [callback, setCallback] = useState<(() => void) | null>(null);
        ${"\n".repeat(150)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => setCallback(() => work)} /><Slot value={callback} /></main>;
      }
    `
  );
  const finding = (await analyzePath(root)).findings.find(candidate => candidate.name === "callback");
  assert.notEqual(finding?.action, "use-observable");
});
