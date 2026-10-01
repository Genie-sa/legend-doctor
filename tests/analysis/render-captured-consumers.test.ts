import type { HookFinding } from "../../src/core/types.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview /><Nav />";

const IMPORTS = `import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import Animated, { useAnimatedStyle, useDerivedValue, withTiming } from "react-native-reanimated";
`;

function firstState(owner: string): HookFinding {
  return requireValue(
    analyzeSource(`${IMPORTS}${owner}`, "src/panel.tsx").find(
      (finding) => finding.hook === "useState",
    ),
  );
}

test("no leaf question is asked when an effect or a hook argument captures the value in render", () => {
  const owners = {
    effect: `export function Citations({ items, progress }: { items: string[]; progress: { value: number } }) {
      const [open, setOpen] = useState(false);
      useEffect(() => { progress.value = withTiming(open ? 1 : 0); }, [open]);
      return <main>${CHROME}<button onClick={() => setOpen((value) => !value)}><Chevron name={open ? "up" : "down"} /></button>
        <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></main>;
    }`,
    derivedEffectDependency: `export function Call({ count, height }: { count: number; height: number }) {
      const [captions, setCaptions] = useState(false);
      const [centered, setCentered] = useState(false);
      const small = count > 4 || captions;
      const size = small ? 40 : 80;
      useLayoutEffect(() => { setCentered(count * size <= height); }, [count, height, size]);
      return <main className={centered ? "center" : ""}>${CHROME}
        <button onClick={() => setCaptions((value) => !value)}>{captions ? "on" : "off"}</button>
        <Card size={size} /></main>;
    }`,
    worklet: `export function Editor() {
      const [active, setActive] = useState<string | null>(null);
      const badge = useAnimatedStyle(() => ({ opacity: active ? 1 : 0 }));
      return <main>${CHROME}<button onClick={() => setActive("a")}>{active ?? "none"}</button>
        <Animated.View style={badge} /></main>;
    }`,
    derivedValue: `export function Editor() {
      const [active, setActive] = useState<string | null>(null);
      const matrix = useDerivedValue(() => (active ? 1 : 0));
      return <main>${CHROME}<button onClick={() => setActive("a")}>{active ?? "none"}</button>
        <Canvas matrix={matrix} /></main>;
    }`,
    gestureCallback: `export function Editor({ gesture }: { gesture: Gesture }) {
      const [layers, setLayers] = useState<string[]>([]);
      const select = useCallback((id: string) => setLayers(layers.filter((layer) => layer !== id)), [layers]);
      const tap = gesture.onEnd(() => select("a"));
      return <main>${CHROME}<Detector gesture={tap} />
        <ul>{layers.map((layer) => <li key={layer}>{layer}</li>)}</ul></main>;
    }`,
    customHook: `export function Tree() {
      const [inline, setInline] = useState(false);
      useHotkeys("mod+p", () => {}, { enabled: !inline });
      return <main>${CHROME}<button onClick={() => setInline(true)}>{inline ? "inline" : "panel"}</button></main>;
    }`,
    transportEffect: `export function Panel() {
      const [open, setOpen] = useState(false);
      useEffect(() => { if (open) track("open"); }, [open]);
      return <main>${CHROME}<button onClick={() => setOpen(true)}>Open</button>
        <Popover open={open} onOpenChange={setOpen} anchor="top" /></main>;
    }`,
  };
  for (const [consumer, owner] of Object.entries(owners)) {
    const state = firstState(owner);
    assert.equal(state.action, "review-state", consumer);
    assert.equal(state.assumption, undefined, consumer);
  }
});

test("reads that no effect or hook argument captures keep their leaf question", () => {
  const owners = {
    eventHandlers: `export function Panel({ rows }: { rows: string[] }) {
      const [filter, setFilter] = useState("");
      const submit = () => console.log(filter);
      return <main>${CHROME}<input value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button onClick={submit} /><button onClick={() => alert(filter)} />
        <p>{rows.filter((row) => row.includes(filter)).length}</p></main>;
    }`,
    eventCallback: `export function Editor() {
      const [layers, setLayers] = useState<string[]>([]);
      const select = useCallback((id: string) => setLayers(layers.filter((layer) => layer !== id)), [layers]);
      return <main>${CHROME}<Canvas onTap={select} />
        <ul>{layers.map((layer) => <li key={layer}>{layer}</li>)}</ul></main>;
    }`,
    unrelatedCallback: `export function Panel({ rows, onSave }: { rows: string[]; onSave: () => void }) {
      const [filter, setFilter] = useState("");
      const save = useCallback(() => onSave(), [onSave]);
      return <main>${CHROME}<input value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button onClick={save} /><p>{rows.filter((row) => row.includes(filter)).length}</p></main>;
    }`,
    unrelatedEffect: `export function Panel({ rows }: { rows: string[] }) {
      const [filter, setFilter] = useState("");
      const [count, setCount] = useState(0);
      useEffect(() => { document.title = String(count); }, [count]);
      return <main>${CHROME}<input value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button onClick={() => setCount(count + 1)} /><p>{rows.filter((row) => row.includes(filter)).length}</p></main>;
    }`,
  };
  for (const [reads, owner] of Object.entries(owners)) {
    const { assumption } = firstState(owner);
    assert.deepEqual(assumption?.facts, ["render-cut-unproven"], reads);
    assert.equal(assumption?.ifConfirmed, "use-observable", reads);
  }
});

test("effect reads the effect-write question already asks about keep the chained leaf question", () => {
  const { assumption } = firstState(`export function Catalog({ count }: { count: number }) {
    const [open, setOpen] = useState(false);
    useEffect(() => { if (count === 0 && open) setOpen(false); }, [count, open]);
    return <main>${CHROME}<button onClick={() => setOpen(true)}>Cart</button>
      <CartSheet visible={open} onClose={() => setOpen(false)} /></main>;
  }`);
  assert.deepEqual(assumption?.facts, [
    "effect-write-ownership-unresolved",
    "child-contract-unresolved",
  ]);
  assert.equal(assumption?.ifConfirmed, "use-observable");
});
