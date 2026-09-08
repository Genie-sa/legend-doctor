import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

function moves(statement: string): number {
  return analyzeLegendPractices({
    fileName: "effect-mutation.tsx",
    sourceText: `
      import { useObservable, useValue } from "@legendapp/state/react";
      import { useEffect } from "react";
      export function Screen({ label }: { label: string }) {
        const state$ = useObservable(0);
        const raw = useValue(state$);
        const bins = raw ?? 64;
        ${statement}
        useEffect(() => publish(label), [label]);
        return <main><Header/><Toolbar/><Summary/><Filters/><List/><Footer/>
          <Aside/><Help/><Status/><Actions/><Search/><h1>{bins}</h1></main>;
      }
    `,
  }).filter((finding) => finding.action === "move-use-value-down").length;
}

for (const statement of [
  "[label] = clock.read();",
  "({ label } = clock.read());",
  "({ value: label } = clock.read());",
  "({ value: [label = 'fallback'] } = clock.read());",
  "for (label of clock.read()) {}",
  "for ([label] of clock.read()) {}",
  "for (label in clock.read()) {}",
]) {
  test(`preserves effects when a primitive dependency is reassigned: ${statement}`, () => {
    assert.equal(moves(statement), 0);
  });
}

for (const statement of [
  "({ label: target.value } = source);",
  "({ [label]: target.value } = source);",
  "({ value: target.value = label } = source);",
]) {
  test(`keeps primitive dependency proof for a read without rebinding: ${statement}`, () => {
    assert.equal(moves(statement), 1);
  });
}
