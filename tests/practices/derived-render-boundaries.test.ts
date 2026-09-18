import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

function fixture(name: string, usage: string, pragma = ""): LegendPracticeFinding | undefined {
  return analyzeLegendPractices({
    fileName: "fixture.tsx",
    sourceText: `
      ${pragma}
      import { useMemo } from "react";
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const active$ = observable("a");
      function ${name}() {
        const id = useValue(active$);
        const selected = useMemo(() => id === "selected", [id]);
        return <output>{selected ? "yes" : "no"}</output>;
      }
      export function App() { return ${usage}; }
    `,
  }).find((entry) => entry.action === "derive-computed-observable");
}

test("only a real component tag reference can establish a removable owner render", () => {
  assert.equal(fixture("Row", "<Row />")?.disposition, "change");
  assert.equal(fixture("Row", "<Row></Row>")?.disposition, "change");
  assert.equal(fixture("row", "<row />")?.disposition, "candidate");
  assert.equal(fixture("Row", "<div />")?.disposition, "candidate");
});

test("custom JSX transforms cannot inherit React host purity", () => {
  for (const pragma of [
    "/** @jsx customFactory */",
    "/** @jsxImportSource custom-runtime */",
    "/** @jsxFrag CustomFragment */",
    "/** @jsxRuntime classic */",
  ]) {
    assert.equal(fixture("Row", "<Row />", pragma)?.disposition, "candidate", pragma);
  }
});
