import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

function screen(leaves: string, extra = ""): string {
  return `
    import { useObservable, useValue } from "@legendapp/state/react";
    import * as React from "react";
    import { useEffect, useLayoutEffect as layout, useRef } from "react";
    export function Screen({ label, visible, items }) {
      const state$ = useObservable({ enabled: false });
      const enabled = useValue(state$.enabled);
      ${extra}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions /><Search />
        ${leaves}
      </main>;
    }
  `;
}

function moves(sourceText: string): LegendPracticeFinding[] {
  return analyzeLegendPractices({ sourceText, fileName: "fixture.tsx" }).filter(
    (finding) => finding.action === "move-use-value-down",
  );
}

test("moves every distant read together into separate stable child components", () => {
  const findings = moves(
    screen(`
    <section><button disabled={!enabled}>{label}</button><StaticOne /></section>
    <aside><StaticTwo /><input disabled={!enabled} /></aside>
  `),
  );
  assert.equal(findings.length, 1);
  const finding = requireValue(findings[0]);
  assert.match(finding.message, /2 separate child components/u);
  assert.match(finding.message, /outside/u);
  assert.match(finding.message, /ordinary props/u);
  assert.match(finding.message, /all.*together/u);
  assert.match(finding.message, /2 JSX elements instead of the 18-element owner/u);
});

test("keeps one cohesive extraction when all reads already fit a small leaf", () => {
  const finding = requireValue(
    moves(
      screen(`<section><button disabled={!enabled} /><input disabled={!enabled} /></section>`),
    )[0],
  );
  assert.doesNotMatch(finding.message, /separate child components/u);
});

test("a cohesive child must not hide required parent commit or snapshot work", () => {
  const leaf = `<section><button disabled={!enabled} /><input disabled={!enabled} /></section>`;
  for (const [reason, leaves, extra] of [
    ["render-driven effect", leaf, "useEffect(() => publish());"],
    ["aliased layout effect", leaf, "layout(() => publish());"],
    ["namespace effect", leaf, "React.useInsertionEffect(() => publish());"],
    ["callback ref", `${leaf}<span ref={node => publish(node)} />`, ""],
    ["observable snapshot", `${leaf}<output>{state$.enabled.peek()}</output>`, ""],
    ["ref snapshot", `${leaf}<output>{ref.current}</output>`, "const ref = useRef(0);"],
    ["bracket ref snapshot", `${leaf}<output>{ref['current']}</output>`, "const ref = useRef(0);"],
  ]) {
    assert.equal(moves(screen(leaves!, extra!)).length, 0, reason);
  }
});

test("deferred commands can read refs without tying the parent to subscription renders", () => {
  assert.equal(
    moves(
      screen(
        `<button disabled={!enabled} onClick={() => publish(ref.current, state$.enabled.peek())} />`,
        "const ref = useRef(0);",
      ),
    ).length,
    1,
  );
});

test("does not split a broad subscribed surface into many individually small children", () => {
  const controls = "<input disabled={!enabled} />".repeat(20);
  assert.equal(moves(screen(controls)).length, 0);
});

test("extracts a complete conditional slot alongside an unconditional leaf", () => {
  const finding = requireValue(
    moves(
      screen(`
    <button disabled={!enabled}>{label}</button>
    {visible && enabled ? <output data-enabled={enabled}>{label}</output> : null}
  `),
    )[0],
  );
  assert.match(finding.message, /2 separate child components/u);
  assert.match(finding.message, /complete conditional JSX slot/u);
  assert.match(finding.message, /always-mounted/u);
});

test("abstains when splitting leaves would lose a snapshot, lifetime, or remaining owner work", () => {
  const pair = `<button disabled={!enabled} /><aside><input disabled={!enabled} /></aside>`;
  for (const [reason, leaves, extra] of [
    ["event snapshot", pair, "const click = () => save(enabled);"],
    ["effect snapshot", pair, "useEffect(() => save(enabled), [enabled]);"],
    ["render lifecycle", pair, "useEffect(() => publish());"],
    ["callback ref lifecycle", `${pair}<span ref={node => publish(node)} />`, ""],
    ["untracked prop snapshot", `${pair}<span title={state$.enabled.peek()} />`, ""],
    ["parent ref refresh", `${pair}<output>{ref.current}</output>`, "const ref = useRef(0);"],
    ["ancestor subscription", pair, "const whole = useValue(state$);"],
    [
      "unproven conditional gate",
      `<button disabled={!enabled} />{check(visible) && <input disabled={!enabled} />}`,
      "",
    ],
    ["keyed leaf", `<button disabled={!enabled} /><input key={label} disabled={!enabled} />`, ""],
    [
      "repeated leaf",
      `<button disabled={!enabled} />{items.map(item => <input key={item.id} disabled={!enabled} />)}`,
      "",
    ],
    ["multiple returns", pair, "if (!visible) return null;"],
    ["unrendered JSX", pair, "const detached = <output>{enabled}</output>;"],
    ["shadowed binding", pair, "function nested(enabled) { return enabled; }"],
  ]) {
    assert.equal(moves(screen(leaves!, extra!)).length, 0, reason);
  }
});
