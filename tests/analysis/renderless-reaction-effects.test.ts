import type { HookFinding } from "../../src/core/types.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

const CHROME = "<h1>Title</h1><p>Intro</p><p>Body</p><p>More</p><hr />";

function effectVerdicts(source: string): string[] {
  return analyzeSource(source, "src/screen.tsx")
    .filter((finding: HookFinding) => finding.hook === "useEffect")
    .map((finding) => `${finding.action}:${finding.abstentionReason ?? ""}`);
}

test("keeps effects that write only shared values or ref handles for values the owner renders", () => {
  assert.deepEqual(
    effectVerdicts(`
      import { useEffect, useRef, useState } from "react";
      import { useValue } from "@legendapp/state/react";
      import { useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
      import { goal$ } from "./store";
      export function Goal({ editing }: { editing: boolean }) {
        const goal = useValue(goal$.days);
        const selection = useSharedValue(0);
        useEffect(() => {
          if (editing && typeof goal === "number") selection.value = goal;
        }, [editing, goal]);
        return <main>${CHROME}<p>{goal}</p></main>;
      }
      export function Compass() {
        const [accuracy, setAccuracy] = useState<number | null>(null);
        const sheet = useRef<{ snap: () => void } | null>(null);
        const offset = useSharedValue(0);
        const calibrating = accuracy !== null && accuracy < 2;
        useEffect(() => {
          if (!calibrating) return;
          offset.value = withRepeat(withTiming(30), -1, false);
          sheet.current?.snap();
        }, [calibrating, offset]);
        return <main>${CHROME}<p>{accuracy}</p><button onClick={() => setAccuracy(1)} /></main>;
      }
    `),
    ["keep-effect:", "keep-effect:"],
  );
});

test("reviews renderless effects whose writes or schedule the owner cannot see", () => {
  assert.deepEqual(
    effectVerdicts(`
      import { useCallback, useEffect, useState } from "react";
      import { useObservable, useValue } from "@legendapp/state/react";
      import { syncPage } from "./split-view";
      import { session$ } from "./store";
      export function Imported() {
        const mode = useValue(session$.mode);
        useEffect(() => { syncPage(); }, [mode]);
        return <main>${CHROME}<p>{mode}</p></main>;
      }
      export function Handed() {
        const mode = useValue(session$.mode);
        const scrolling$ = useObservable(false);
        const scroll = useCallback(() => { scrolling$.set(true); }, [scrolling$]);
        useEffect(() => { requestAnimationFrame(scroll); }, [mode, scroll]);
        return <main>${CHROME}<p>{mode}</p></main>;
      }
      export function SnapshotMethod({ visible }: { visible: boolean }) {
        const unread = useValue(session$.unread);
        const actions = useValue(session$.actions);
        useEffect(() => { if (visible && unread) actions.markRead(); }, [actions, unread, visible]);
        return <main>${CHROME}<p>{unread}</p></main>;
      }
      export function EffectOnly() {
        const [count, setCount] = useState(0);
        useEffect(() => { document.title = String(count); }, [count]);
        return <main>${CHROME}<button onClick={() => setCount(count + 1)} /></main>;
      }
    `),
    Array.from({ length: 4 }, () => "review-effect:effect-causal-owner-unresolved"),
  );
});

test("still reviews effects that write rendered React state or a rendered observable", () => {
  assert.deepEqual(
    effectVerdicts(`
      import { useEffect, useState } from "react";
      import { useValue } from "@legendapp/state/react";
      import { session$ } from "./store";
      export function ResetQuery({ rows, tab }: { rows: string[]; tab: string }) {
        const [query, setQuery] = useState("");
        const mode = useValue(session$.mode);
        useEffect(() => { if (mode === "list") setQuery(""); }, [mode, tab]);
        return <main>${CHROME}<p>{mode}</p>
          <input value={query} onChange={(event) => setQuery(event.target.value)} />
          {rows.filter((row) => row.includes(query)).map((row) => <p key={row}>{row}</p>)}
        </main>;
      }
      export function MirrorMode({ requested }: { requested: string }) {
        const mode = useValue(session$.mode);
        const [tab, setTab] = useState("a");
        useEffect(() => { if (tab !== mode) session$.mode.set(tab); }, [mode, tab]);
        return <main>${CHROME}<p>{mode}</p><p>{requested}</p><button onClick={() => setTab("b")}>{tab}</button></main>;
      }
    `),
    [
      "review-effect:effect-write-ownership-unresolved",
      "review-effect:effect-causal-owner-unresolved",
    ],
  );
});
