import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("isolates an event-owned boolean across small presentation leaves and reactive props", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-multi-leaf-boolean-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "cx.ts"),
    `
      import { clsx } from "clsx";
      export function cx(...values: unknown[]) { return clsx(values); }
      export function noisy(...values: unknown[]) { console.log(values); return clsx(values); }
    `,
    "utf8",
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
    "utf8",
  );

  const report = await analyzePath(root);
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "active")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "noisyActive")).action,
    "review-state",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "broadActive")).action,
    "review-state",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "branchActive")).action,
    "review-state",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "scrolled")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "customComputed")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "inlineComputed")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "opaque")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "companion")).action,
    "review-state",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "effectOwned")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "measuredOverflow")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "opaqueMeasured")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "mixedMeasured")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "separatedMeasured")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "repeated")).action,
    "review-state",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "separated")).action,
    "use-observable",
  );
});
