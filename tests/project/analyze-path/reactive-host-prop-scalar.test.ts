import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("isolates one event-owned scalar in a reactive host prop", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-reactive-host-prop-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Screens.tsx"),
    `
      import { useEffect, useState } from "react";
      import { View } from "react-native";

      const baseStyle = { flex: 1 };
      const project = (value: number) => ({ opacity: value });

      export function SafeScreen() {
        const [scale, setScale] = useState(1);
        const onLayout = (event: { nativeEvent: { width: number } }) => {
          setScale(event.nativeEvent.width / 320);
        };
        return <View onLayout={onLayout}>
          <View style={[baseStyle, { transform: [{ scale }] }]}>
            <Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/>
          </View>
        </View>;
      }

      export function WebScreen() {
        const [scrollLeft, setScrollLeft] = useState(0);
        const onScroll = (event: { currentTarget: { scrollLeft: number } }) => {
          setScrollLeft(event.currentTarget.scrollLeft);
        };
        return <section onScroll={onScroll}>
          <div style={{ transform: \`translateX(\${scrollLeft}px)\` }}>
            <Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/>
          </div>
        </section>;
      }

      export function BooleanScreen() {
        const [hovered, setHovered] = useState(false);
        const enter = () => setHovered(true);
        const leave = () => setHovered(false);
        return <View
          onMouseEnter={enter}
          onMouseLeave={leave}
          data-hovered={hovered ? "true" : undefined}
        >
          <Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/>
        </View>;
      }

      export function BooleanBranchScreen({ linked }: { linked: boolean }) {
        const [focused, setFocused] = useState(false);
        const focus = () => setFocused(true);
        const blur = () => setFocused(false);
        if (linked) return <View><Linked/><Label/></View>;
        return <View style={styles.container(focused)}>
          <View onFocus={focus} onBlur={blur}/>
          <Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/>
        </View>;
      }

      export function BooleanCompanionScreen() {
        const [hoveredWithCompanion, setHoveredWithCompanion] = useState(false);
        const [, setEntered] = useState(false);
        const enter = () => { setHoveredWithCompanion(true); setEntered(true); };
        const leave = () => setHoveredWithCompanion(false);
        return <View
          onMouseEnter={enter}
          onMouseLeave={leave}
          data-hovered={hoveredWithCompanion ? "true" : undefined}
        >
          <Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/>
        </View>;
      }

      export function BooleanMultiPropScreen() {
        const [active, setActive] = useState(false);
        const enter = () => setActive(true);
        const leave = () => setActive(false);
        return <View
          onMouseEnter={enter}
          onMouseLeave={leave}
          data-active={active ? "true" : undefined}
          aria-selected={active}
        >
          <Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/>
        </View>;
      }

      export function BooleanUpdaterScreen() {
        const [toggled, setToggled] = useState(false);
        const toggle = () => setToggled(value => !value);
        return <View
          onPress={toggle}
          data-active={toggled ? "true" : undefined}
        >
          <Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/>
        </View>;
      }

      export function CompanionScreen() {
        const [companionWidth, setCompanionWidth] = useState(0);
        const [, setMeasured] = useState(false);
        const onLayout = (event: { nativeEvent: { width: number } }) => {
          setCompanionWidth(event.nativeEvent.width);
          setMeasured(true);
        };
        return <View onLayout={onLayout}>
          <View style={{ width: companionWidth }}><Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/></View>
        </View>;
      }

      export function RepeatedScreen({ rows }: { rows: string[] }) {
        const [repeatedWidth, setRepeatedWidth] = useState(0);
        const onLayout = (event: { nativeEvent: { width: number } }) => setRepeatedWidth(event.nativeEvent.width);
        return <View onLayout={onLayout}>
          {rows.map(row => <View key={row} style={{ width: repeatedWidth }}>{row}</View>)}
          <Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/>
        </View>;
      }

      export function ImpureScreen() {
        const [impureOpacity, setImpureOpacity] = useState(0);
        const onLayout = (event: { nativeEvent: { width: number } }) => setImpureOpacity(event.nativeEvent.width);
        return <View onLayout={onLayout}>
          <View style={project(impureOpacity)}><Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/></View>
        </View>;
      }

      export function EffectScreen({ next }: { next: number }) {
        const [effectOpacity, setEffectOpacity] = useState(0);
        useEffect(() => setEffectOpacity(next), [next]);
        return <View style={{ opacity: effectOpacity }}><Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/></View>;
      }

      function CustomSurface({ width }: { width: number }) {
        return <View style={{ width }} />;
      }
      export function CustomSurfaceScreen() {
        const [customWidth, setCustomWidth] = useState(0);
        const onLayout = (event: { nativeEvent: { width: number } }) => setCustomWidth(event.nativeEvent.width);
        return <View onLayout={onLayout}>
          <CustomSurface width={customWidth}/><Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/>
        </View>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  const states = new Map(
    report.findings
      .filter((finding) => finding.hook === "useState" && finding.name)
      .map((finding) => [requireValue(finding.name), finding]),
  );
  assert.equal(requireValue(states.get("scale")).action, "use-observable");
  assert.match(requireValue(states.get("scale")).message ?? "", /single host prop reactive/u);
  assert.equal(requireValue(states.get("scrollLeft")).action, "use-observable");
  assert.match(requireValue(states.get("scrollLeft")).message ?? "", /single host prop reactive/u);
  assert.equal(requireValue(states.get("hovered")).action, "use-observable");
  assert.match(requireValue(states.get("hovered")).message ?? "", /single host prop reactive/u);
  assert.equal(requireValue(states.get("focused")).action, "use-observable");
  assert.match(requireValue(states.get("focused")).message ?? "", /single host prop reactive/u);
  for (const name of ["companionWidth", "repeatedWidth", "impureOpacity"]) {
    assert.equal(requireValue(states.get(name)).action, "review-state", name);
  }
  for (const name of ["hoveredWithCompanion", "active", "toggled"]) {
    assert.equal(requireValue(states.get(name)).action, "review-state", name);
  }
  assert.doesNotMatch(
    requireValue(states.get("customWidth")).message ?? "",
    /single host prop reactive/u,
  );
  assert.equal(requireValue(states.get("effectOpacity")).action, "delete-derived-state");
});
