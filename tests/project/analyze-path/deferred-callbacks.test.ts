import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("preserves the pre-update snapshot for state read by a source-proven deferred callback", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-deferred-counter-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
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
    "utf8",
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
    "utf8",
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
    "utf8",
  );

  const report = await analyzePath(root);
  const ticks = report.findings.find((finding) => finding.name === "ticks");
  assert.equal(requireValue(ticks).action, "use-ref");
  assert.match(requireValue(ticks).message ?? "", /pre-update snapshot/u);
  assert.notEqual(
    requireValue(report.findings.find((finding) => finding.name === "unsafeTicks")).action,
    "use-ref",
  );
  assert.notEqual(
    requireValue(report.findings.find((finding) => finding.name === "asyncTicks")).action,
    "use-ref",
  );
});

test("proves transitive object callback deferral across source hooks", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-transitive-hook-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "use-guard.ts"),
    `
      import { useStoredGuard } from "./use-stored-guard";
      export function useGuard({ getSnapshot }: { getSnapshot: () => string }) {
        const hasSnapshot = () => getSnapshot().length > 0;
        useStoredGuard(hasSnapshot);
      }
    `,
    "utf8",
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
    "utf8",
  );
  await writeFile(
    path.join(root, "use-unsafe-guard.ts"),
    `
      import { useUnsafeStoredGuard } from "./use-stored-guard";
      export function useUnsafeGuard({ getSnapshot }: { getSnapshot: () => string }) {
        useUnsafeStoredGuard(getSnapshot);
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "use-stale-guard.ts"),
    `
      import { useStaleStoredGuard } from "./use-stored-guard";
      export function useStaleGuard({ getSnapshot }: { getSnapshot: () => string }) {
        useStaleStoredGuard(getSnapshot);
      }
    `,
    "utf8",
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
    "utf8",
  );

  const report = await analyzePath(root);
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "draft")).action,
    "use-ref",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "methodDraft")).action,
    "use-ref",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "unsafeDraft")).action,
    "review-state",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "staleDraft")).action,
    "review-state",
  );
});

test("proves deferred context and higher-order callback paths and rejects eager readers", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-context-command-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "useLater.ts"),
    `
      import { useEffect } from "react";
      export function useLater(callback: () => void) {
        useEffect(() => subscribe(callback), [callback]);
      }
    `,
    "utf8",
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
    "utf8",
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
    "utf8",
  );

  const report = await analyzePath(root);
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "payload")).action,
    "use-ref",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "guardPayload")).action,
    "use-ref",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "eagerPayload")).action,
    "review-state",
  );
});
