import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("proves source-resolved event measurements have only bounded scalar leaf projections", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-event-measurement-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "NativeHost.tsx"),
    `
      import { requireNativeComponent } from "react-native";
      export const NativeHost = requireNativeComponent<{
        onNativeLayout?: (event: { nativeEvent: { width: number } }) => void;
        children?: React.ReactNode;
      }>("NativeHost");
      export let MutableNativeHost = requireNativeComponent<{
        onNativeLayout?: (event: { nativeEvent: { width: number } }) => void;
        children?: React.ReactNode;
      }>("MutableNativeHost");
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "MeasuredShell.tsx"),
    `
      import { MutableNativeHost, NativeHost } from "./NativeHost";
      export function MeasuredShell({ onLayout, children }: {
        onLayout: (layout: { width: number }) => void;
        children: React.ReactNode;
      }) {
        return <NativeHost onNativeLayout={onLayout ? event => onLayout(event.nativeEvent) : undefined}>{children}</NativeHost>;
      }
      export function EagerShell({ onLayout, children }: {
        onLayout: (layout: { width: number }) => void;
        children: React.ReactNode;
      }) {
        onLayout({ width: 40 });
        return <section>{children}</section>;
      }
      export function MutableShell({ onLayout, children }: {
        onLayout: (layout: { width: number }) => void;
        children: React.ReactNode;
      }) {
        return <MutableNativeHost onNativeLayout={event => onLayout(event.nativeEvent)}>{children}</MutableNativeHost>;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useCallback, useEffect, useState } from "react";
      import { EagerShell, MeasuredShell, MutableShell } from "./MeasuredShell";

      const project = (value: number) => value + 1;

      export function SafeScreen({ native }: { native: boolean }) {
        const [outerWidth, setOuterWidth] = useState(0);
        const width = Math.max(outerWidth - 8, 0);
        const onLayout = useCallback(
          (layout: { width: number }) => setOuterWidth(layout.width),
          [setOuterWidth],
        );
        if (native) {
          return <MeasuredShell onLayout={onLayout}>
            <input style={{ width: width + 2 }}/>
            <div style={{ width }}><span/><span/></div>
            <aside/><footer/><header/><main/><nav/><output/><section/><strong/><em/>
          </MeasuredShell>;
        }
        return <main><span/><span/><span/></main>;
      }

      export function EagerScreen() {
        const [eagerWidth, setEagerWidth] = useState(0);
        const onLayout = useCallback((layout: { width: number }) => setEagerWidth(layout.width), []);
        return <EagerShell onLayout={onLayout}>
          <input style={{ width: eagerWidth }}/><div style={{ width: eagerWidth }}/>
          <aside/><footer/><header/><main/><nav/><output/><section/><strong/><em/><small/>
        </EagerShell>;
      }

      export function CompanionScreen() {
        const [companionWidth, setCompanionWidth] = useState(0);
        const [, setMeasured] = useState(false);
        const onLayout = useCallback((layout: { width: number }) => {
          setCompanionWidth(layout.width);
          setMeasured(true);
        }, []);
        return <MeasuredShell onLayout={onLayout}>
          <input style={{ width: companionWidth }}/><div style={{ width: companionWidth }}/>
          <aside/><footer/><header/><main/><nav/><output/><section/><strong/><em/><small/>
        </MeasuredShell>;
      }

      export function MutableHostScreen() {
        const [mutableWidth, setMutableWidth] = useState(0);
        const onLayout = useCallback((layout: { width: number }) => setMutableWidth(layout.width), []);
        return <MutableShell onLayout={onLayout}>
          <input style={{ width: mutableWidth }}/><div style={{ width: mutableWidth }}/>
          <aside/><footer/><header/><main/><nav/><output/><section/><strong/><em/><small/>
        </MutableShell>;
      }

      export function RepeatedScreen({ items }: { items: string[] }) {
        const [repeatedWidth, setRepeatedWidth] = useState(0);
        const onLayout = useCallback((layout: { width: number }) => setRepeatedWidth(layout.width), []);
        return <MeasuredShell onLayout={onLayout}>
          {items.map(item => <div key={item} style={{ width: repeatedWidth }}>{item}</div>)}
          <aside/><footer/><header/><main/><nav/><output/><section/><strong/><em/><small/><span/>
        </MeasuredShell>;
      }

      export function EffectScreen({ measured }: { measured: number }) {
        const [effectWidth, setEffectWidth] = useState(0);
        useEffect(() => setEffectWidth(measured), [measured]);
        return <main>
          <input style={{ width: effectWidth }}/><div style={{ width: effectWidth }}/>
          <aside/><footer/><header/><nav/><output/><section/><strong/><em/><small/><span/>
        </main>;
      }

      export function ImpureScreen() {
        const [impureWidth, setImpureWidth] = useState(0);
        const onLayout = useCallback((layout: { width: number }) => setImpureWidth(layout.width), []);
        return <MeasuredShell onLayout={onLayout}>
          <input style={{ width: project(impureWidth) }}/><div style={{ width: impureWidth }}/>
          <aside/><footer/><header/><main/><nav/><output/><section/><strong/><em/><small/>
        </MeasuredShell>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  const states = new Map(
    report.findings
      .filter((finding) => finding.hook === "useState" && finding.name)
      .map((finding) => [requireValue(finding.name), finding.action]),
  );
  assert.equal(states.get("outerWidth"), "use-observable");
  assert.equal(states.get("eagerWidth"), "review-state");
  assert.equal(states.get("companionWidth"), "review-state");
  assert.equal(states.get("mutableWidth"), "review-state");
  assert.equal(states.get("repeatedWidth"), "review-state");
  assert.equal(states.get("effectWidth"), "delete-derived-state");
  assert.equal(states.get("impureWidth"), "review-state");
});

test("isolates effect-owned scalar ticks across bounded stable leaves", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-effect-scalar-leaves-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Screens.tsx"),
    `
      import { useEffect, useState } from "react";
      const rows = [{ id: "one", start: 0 }, { id: "two", start: 10 }];
      const noisyProjection = (value: number) => { console.log(value); return value; };

      export function SafeTicker() {
        const [elapsed, setElapsed] = useState(0);
        useEffect(() => {
          setElapsed(0);
          const timer = setInterval(() => setElapsed(Date.now()), 200);
          return () => clearInterval(timer);
        }, []);
        const active = Math.floor(elapsed / 10);
        return <main>
          <ol>{rows.map(row => <li key={row.id} data-active={row.start === active}>{row.id}</li>)}</ol>
          <progress value={elapsed / 100}/>
          <Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/>
        </main>;
      }

      export function UnstableRows() {
        const [unkeyedElapsed, setUnkeyedElapsed] = useState(0);
        useEffect(() => {
          const timer = setInterval(() => setUnkeyedElapsed(Date.now()), 200);
          return () => clearInterval(timer);
        }, []);
        const active = Math.floor(unkeyedElapsed / 10);
        return <main>
          <ol>{rows.map(row => <li data-active={row.start === active}>{row.id}</li>)}</ol>
          <progress value={unkeyedElapsed / 100}/>
          <Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/>
        </main>;
      }

      export function CompanionTicker() {
        const [companionElapsed, setCompanionElapsed] = useState(0);
        const [ticked, setTicked] = useState(false);
        useEffect(() => {
          const timer = setInterval(() => { setCompanionElapsed(1); setTicked(true); }, 200);
          return () => clearInterval(timer);
        }, []);
        return <main data-ticked={ticked}><progress value={companionElapsed}/><Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/></main>;
      }

      export function EffectReadTicker() {
        const [effectReadElapsed, setEffectReadElapsed] = useState(0);
        useEffect(() => {
          if (effectReadElapsed > 0) console.log(effectReadElapsed);
          const timer = setInterval(() => setEffectReadElapsed(Date.now()), 200);
          return () => clearInterval(timer);
        }, [effectReadElapsed]);
        return <main><progress value={effectReadElapsed}/><Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/></main>;
      }

      export function FunctionalTicker() {
        const [functionalElapsed, setFunctionalElapsed] = useState(0);
        useEffect(() => {
          const timer = setInterval(() => setFunctionalElapsed(value => value + 1), 200);
          return () => clearInterval(timer);
        }, []);
        return <main><progress value={functionalElapsed}/><Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/></main>;
      }

      export function BroadTicker() {
        const [broadElapsed, setBroadElapsed] = useState(0);
        useEffect(() => {
          const timer = setInterval(() => setBroadElapsed(Date.now()), 200);
          return () => clearInterval(timer);
        }, []);
        return <main>
          {broadElapsed > 0 && <section><One/><Two/><Three/><Four/><Five/><Six/><Seven/><Eight/><Nine/><Ten/></section>}
          <Header/><Footer/>
        </main>;
      }

      export function OpaqueProjectionTicker() {
        const [opaqueElapsed, setOpaqueElapsed] = useState(0);
        useEffect(() => {
          const timer = setInterval(() => setOpaqueElapsed(Date.now()), 200);
          return () => clearInterval(timer);
        }, []);
        return <main>
          <progress value={noisyProjection(opaqueElapsed)}/>
          <output>{opaqueElapsed}</output>
          <Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/>
        </main>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  const states = new Map(
    report.findings
      .filter((finding) => finding.hook === "useState" && finding.name)
      .map((finding) => [requireValue(finding.name), finding.action]),
  );
  assert.equal(states.get("elapsed"), "use-observable");
  for (const name of [
    "unkeyedElapsed",
    "companionElapsed",
    "effectReadElapsed",
    "functionalElapsed",
    "broadElapsed",
    "opaqueElapsed",
  ]) {
    assert.equal(states.get(name), "review-state", name);
  }
});
