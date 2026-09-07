import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

for (const update of ["setTick(tick + 1)", "setTick(1)"]) {
  for (const rendered of ["count.current", 'count["current"]', "readCount()", "shown", "label"]) {
    test(`keeps the render refreshing ${rendered} when ${update}`, () => {
      const findings = analyzeSource(
        `
        import { useRef, useState } from "react";
        function Panel() {
          const [tick, setTick] = useState(0);
          const count = useRef(0);
          ${rendered === "shown" ? "const shown = count.current;" : ""}
          const readCount = () => count.current;
          ${rendered === "label" ? "const label = readCount();" : ""}
          return <button onClick={() => { count.current++; ${update}; }}>${"{"}${rendered}}</button>;
        }
      `,
        "fixture.tsx",
      );
      const tick = findings.find((finding) => finding.name === "tick");
      assert.equal(tick?.disposition, "candidate");
      assert.match(tick?.message ?? "", /render.*refresh/iu);
    });
  }
}

test("a ref used only by commands does not block deletion of unused state", () => {
  const findings = analyzeSource(
    `
    import { useRef, useState } from "react";
    function Panel() {
      const [tick, setTick] = useState(0);
      const count = useRef(0);
      return <button onClick={() => { count.current++; setTick(1); }}>Count</button>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(findings.find((finding) => finding.name === "tick")?.action, "delete-unused-state");
});

test("preserves ref reads reached through a local call in an attribute", () => {
  const findings = analyzeSource(
    `
    import { useRef, useState } from "react";
    function Panel() {
      const [tick, setTick] = useState(0);
      const count = useRef(0);
      const readCount = () => count.current;
      return <button title={readCount()} onClick={() => { count.current++; setTick(1); }}>Count</button>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(findings.find((finding) => finding.name === "tick")?.disposition, "candidate");
});
