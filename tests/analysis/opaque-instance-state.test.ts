import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("keeps React state that can hold a DOM node or ref target out of observables", () => {
  const cases = {
    "const [value, setValue] = useState<HTMLDivElement | null>(null);": "keep-state",
    "const [value, setValue] = useState<{ anchor: HTMLElement } | null>(null);": "keep-state",
    "const [value, setValue] = useState(null); const ref = <div ref={setValue} />;": "keep-state",
    "const [value, setValue] = useState(null); const attach = useCallback((node) => setValue(node), []); const ref = <div ref={attach} />;":
      "keep-state",
    "const [value, setValue] = useState(0); const measure = useCallback((node) => setValue(node.offsetWidth), []); const ref = <div ref={measure} />;":
      "use-observable",
    "type HTMLPanelElement = { id: string }; const [value, setValue] = useState<HTMLPanelElement | null>(null);":
      "use-observable",
  };
  for (const [declaration, action] of Object.entries(cases)) {
    const findings = analyzeSource(
      `
      import { useCallback, useState } from "react";
      export function Screen() {
        ${declaration}
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <button onClick={() => setValue(pick())}>Pick</button>
          <section><Leaf ready={value != null} /></section>
        </main>;
      }
    `,
      "fixture.tsx",
    );
    const value = requireValue(findings.find((finding) => finding.name === "value"));
    assert.equal(value.action, action, declaration);
  }
});
