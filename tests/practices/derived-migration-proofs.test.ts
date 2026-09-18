import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

function finding(callback: string, setup = "", initial = '"a"'): LegendPracticeFinding | undefined {
  return analyzeLegendPractices({
    fileName: "fixture.tsx",
    sourceText: `
      import { useMemo } from "react";
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const active$ = observable(${initial});
      const hidden$ = observable(1);
      ${setup}
      function Row() {
        const id = useValue(active$);
        const selected = useMemo(${callback}, [id]);
        return <output>{selected ? "yes" : "no"}</output>;
      }
      export function App() { return <Row />; }
    `,
  }).find((result) => result.action === "derive-computed-observable");
}

test("unproven module helpers cannot introduce dependencies through an enforced migration", () => {
  assert.equal(
    finding("() => id === helper()", "function helper() { return hidden$.get(); }", "1")
      ?.disposition,
    "candidate",
  );
});

test("a string suffix is injective and provides no equality render saving", () => {
  assert.equal(finding('() => id + "!"')?.disposition, "candidate");
});

test("strict string and number comparisons retain proven equality savings", () => {
  assert.equal(finding('() => id === "selected"')?.disposition, "change");
  assert.equal(finding("() => id !== 1", "", "0")?.disposition, "change");
});

test("calls, module captures, effects, throws, and shadowed globals require review", () => {
  for (const [callback, setup] of [
    ["() => id === helper()", 'import { helper } from "./helper";'],
    ['() => { helper(); return id === "a"; }', "function helper() { hidden$.set(2); }"],
    ["() => { throw id; return true; }", ""],
    [
      '() => { queueMicrotask(helper); return id === "a"; }',
      "function helper() { hidden$.set(2); }",
    ],
    ["() => String(id)", "const String = () => hidden$.get();"],
    ["() => Number(id)", "const Number = () => hidden$.get();"],
    ["() => Boolean(id)", "const Boolean = () => hidden$.get();"],
    ["() => Math.abs(id)", "const Math = { abs: () => hidden$.get() };"],
    ["() => id === threshold", 'let threshold = "a";'],
    ["() => id == 1", ""],
    ["() => id.value === 1", ""],
  ]) {
    assert.equal(finding(callback!, setup)?.disposition, "candidate", callback);
  }
});

test("boolean inversion, narrow unions, and assertions do not prove an equality benefit", () => {
  assert.equal(finding("() => !id", "", "false")?.disposition, "candidate");
  assert.equal(finding("() => id === true", "", "false")?.disposition, "candidate");
  assert.equal(finding('() => id === "a"', "", '"a" as "a" | "b"')?.disposition, "candidate");
});

test("observable identity must stay stable across renders", () => {
  for (const sourceText of [
    `import { useMemo } from "react";
     import { observable } from "@legendapp/state";
     import { useValue } from "@legendapp/state/react";
     function Row() { const active$ = observable("a"); const id = useValue(active$);
       const selected = useMemo(() => id === "a", [id]); return <output>{selected}</output>; }`,
    `import { useMemo } from "react";
     import type { Observable } from "@legendapp/state";
     import { useValue } from "@legendapp/state/react";
     function Row({ active$ }: { active$: Observable<string> }) { const id = useValue(active$);
       const selected = useMemo(() => id === "a", [id]); return <output>{selected}</output>; }`,
  ]) {
    const result = analyzeLegendPractices({ fileName: "fixture.tsx", sourceText }).find(
      (entry) => entry.action === "derive-computed-observable",
    );
    assert.notEqual(result?.disposition, "change");
    if (result) {
      assert.match(result.evidence.join(" "), /stable observable identity/u);
    }
  }
});

test("render suppression cannot skip owner effects, ref snapshots, children, or escaped ownership", () => {
  const fixture = (statement: string, escape = ""): LegendPracticeFinding | undefined =>
    analyzeLegendPractices({
      fileName: "fixture.tsx",
      sourceText: `
        import { useMemo, useEffect, useLayoutEffect, useRef } from "react";
        import { observable } from "@legendapp/state";
        import { useValue, observer } from "@legendapp/state/react";
        const active$ = observable("a");
        function publish(value: string) {}
        function Child() { useEffect(() => publish(active$.peek())); return null; }
        function Row() {
          const id = useValue(active$);
          const selected = useMemo(() => id === "selected", [id]);
          ${statement}
          return <output>{selected ? "yes" : "no"}</output>;
        }
        ${escape}
        export function App() { return <Row />; }
      `,
    }).find((entry) => entry.action === "derive-computed-observable");
  for (const statement of [
    "useEffect(() => publish(active$.peek()));",
    "useLayoutEffect(() => publish(active$.peek()));",
    "const snapshot = useRef(); snapshot.current = active$.peek();",
    "publish(active$.peek());",
    "return <Child />;",
    "return <output ref={publish}>{selected}</output>;",
  ]) {
    assert.equal(fixture(statement)?.disposition, "candidate", statement);
  }
  for (const escape of [
    "export { Row };",
    "export default Row;",
    "const Wrapped = observer(Row);",
    "const alias = Row;",
  ]) {
    assert.equal(fixture("", escape)?.disposition, "candidate", escape);
  }
});

test("stable module child paths support strict comparisons, but accessors and narrow type arguments do not", () => {
  const fixture = (initial: string): LegendPracticeFinding | undefined =>
    analyzeLegendPractices({
      fileName: "fixture.tsx",
      sourceText: `
        import { useMemo } from "react";
        import { observable } from "@legendapp/state";
        import { useValue } from "@legendapp/state/react";
        const state$ = ${initial};
        function Row() {
          const id = useValue(state$.id);
          const selected = useMemo(() => { return "a" !== id; }, [id]);
          return <output data-selected={selected}>{selected ? "yes" : "no"}</output>;
        }
        export function App() { return <Row />; }
      `,
    }).find((entry) => entry.action === "derive-computed-observable");
  assert.equal(fixture('observable({ id: "a" })')?.disposition, "change");
  for (const initial of [
    'observable({ get id() { return "a"; } })',
    'observable({ id: "a" } as const)',
    'observable<{ id: "a" | "b" }>({ id: "a" })',
    'observable({ id: "a", ...other })',
    'observable({ id: "a", __proto__: other })',
  ]) {
    assert.equal(fixture(initial)?.disposition, "candidate", initial);
  }
});
