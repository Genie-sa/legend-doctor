import { actions, requireValue } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

test("does not replace state exposed through a returned getter callback", () => {
  const finding = analyzeSource(
    `
    import { useCallback, useState } from "react";
    export function useAttachmentErrors() {
      const [errors, setErrors] = useState<Record<string, boolean>>({});
      const setError = useCallback((key: string) => {
        setErrors(previous => ({ ...previous, [key]: true }));
      }, []);
      const hasError = useCallback((key: string) => errors[key] === true, [errors]);
      return { setError, hasError };
    }
  `,
    "fixture.ts",
  ).find((candidate) => candidate.hook === "useState");
  assert.notEqual(requireValue(finding).action, "use-ref");
});

test("does not replace state that refreshes a context getter", () => {
  const finding = analyzeSource(
    `
    import { createContext, useCallback, useMemo, useState } from "react";
    const StateContext = createContext(null);
    export function StateProvider({ children }) {
      const [loaded, setLoaded] = useState<Record<string, boolean>>({});
      const markLoaded = useCallback((key: string) => {
        setLoaded(previous => ({ ...previous, [key]: true }));
      }, []);
      const isLoaded = useCallback((key: string) => loaded[key] === true, [loaded]);
      const value = useMemo(() => ({ markLoaded, isLoaded }), [markLoaded, isLoaded]);
      return <StateContext.Provider value={value}>{children}</StateContext.Provider>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.hook === "useState");
  assert.notEqual(requireValue(finding).action, "use-ref");
});

test("does not replace state snapshots exposed through a React imperative handle", () => {
  const finding = analyzeSource(
    `
    import { forwardRef, useImperativeHandle, useState } from "react";
    export const Menu = forwardRef(function Menu(_props, ref) {
      const [opening, setOpening] = useState(false);
      useImperativeHandle(ref, () => ({
        open() { setOpening(true); },
        isOpening() { return opening; },
      }), [opening]);
      return <Button onPress={() => setOpening(false)} />;
    });
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.hook === "useState");
  assert.notEqual(requireValue(finding).action, "use-ref");
});

test("does not replace state that invalidates a React effect through a callback", () => {
  const finding = analyzeSource(
    `
    import { useCallback, useEffect, useState } from "react";
    export function Map() {
      const [interacted, setInteracted] = useState(false);
      const shouldPan = useCallback(() => !interacted, [interacted]);
      useEffect(() => {
        if (shouldPan()) panToCurrentLocation();
      }, [shouldPan]);
      return <MapView onTouchStart={() => setInteracted(true)} />;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.hook === "useState");
  assert.notEqual(requireValue(finding).action, "use-ref");
  assert.match(requireValue(finding).evidence[1] ?? "", /effects [1-9]/u);
});

test("does not replace state captured by an unresolved lifecycle hook", () => {
  const finding = analyzeSource(
    `
    import { useCallback, useState } from "react";
    import { useFocusEffect } from "@react-navigation/native";
    export function ImportFlow() {
      const [pending, setPending] = useState(false);
      useFocusEffect(useCallback(() => {
        if (pending) startImport();
      }, [pending]));
      return <Button onPress={() => setPending(true)} />;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.hook === "useState");
  assert.notEqual(requireValue(finding).action, "use-ref");
});

test("does not call a value shared by an event and an effect-owned callback command-only", () => {
  const finding = analyzeSource(
    `
    import { useCallback, useEffect, useState } from "react";
    export function Editor() {
      const [edited, setEdited] = useState(false);
      const confirm = useCallback(() => { if (edited) save(); }, [edited]);
      useEffect(() => {
        window.addEventListener("keydown", confirm);
        return () => window.removeEventListener("keydown", confirm);
      }, [confirm]);
      return <Input onChange={() => { if (!edited) setEdited(true); }} />;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.hook === "useState");
  assert.notEqual(requireValue(finding).action, "use-ref");
});

test("counts state read by a transported render callback as rendered", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    export function List({ rows }: { rows: Array<{ id: string }> }) {
      const [highlighted, setHighlighted] = useState<Set<string> | null>(null);
      const renderItem = ({ item }: { item: { id: string } }) => {
        const active = highlighted?.has(item.id);
        return <Row active={active} />;
      };
      return <VirtualList data={rows} renderItem={renderItem} onClear={() => setHighlighted(null)} />;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.hook === "useState");
  assert.notEqual(requireValue(finding).action, "use-ref");
  assert.match(requireValue(finding).evidence[1] ?? "", /reads: render 1/u);
});

test("does not replace functional-updater state when commands observe its render snapshot", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    export function useReload() {
      const [minutes, setMinutes] = useState(0);
      useInterval(() => {
        setMinutes(previous => previous + 1);
        if (minutes >= 60) reload();
      }, 1000);
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.hook === "useState");
  assert.notEqual(requireValue(finding).action, "use-ref");
});

test("does not replace a command snapshot written before a later read", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    export function ValidationActions() {
      const [selection, setSelection] = useState<string>();
      const [draft, setDraft] = useState("");
      return <><Button onPress={() => { setSelection(undefined); open(selection); }} />
        <Button onPress={() => setDraft("next")} />
        <Button onPress={() => save(draft)} /></>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(
    requireValue(findings.find((finding) => finding.name === "selection")).action,
    "use-ref",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "draft")).action,
    "use-ref",
  );
});

test("keeps the ref recommendation when a functional updater has no later snapshot read", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    export function Actions() {
      const [count, setCount] = useState(0);
      const increment = () => setCount(previous => previous + 1);
      const saveCount = () => save(count);
      return <><Button onPress={increment} /><Button onPress={saveCount} /></>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.hook === "useState");
  assert.equal(requireValue(finding).action, "use-ref");
  assert.match(
    requireValue(finding).message ?? "",
    /functional updaters against the current handle value/iu,
  );
});

test("treats useCallback dependencies as deferred command reads", () => {
  assert.deepEqual(
    actions(`
      import { useCallback, useState } from "react";
      export function Slider() {
        const [width, setWidth] = useState(0);
        const update = useCallback((x: number) => save(x / width), [width]);
        return <Track onLayout={event => setWidth(event.width)} onMove={update} />;
      }
    `),
    ["use-ref"],
  );
});
