import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

const CHROME =
  "<Header/><Toolbar/><Summary/><Filters/><List/><Footer/><Aside/><Help/><Status/><Actions/><Preview/>";

function fixture(command: string): string {
  return `import {useState} from "react";
export function Panel() {
  const [a,setA]=useState(false);
  const [b,setB]=useState(false);
  const [c,setC]=useState(false);
  async function run() { ${command} }
  return <main>${CHROME}<p>{a}</p><p>{b}</p><Unknown open={c}/><button onClick={run}/></main>;
}`;
}

// Risks: conflating a connected group with one transaction; evaluating a throwing RHS before
// An earlier write; fusing repeated writes to one field; discarding catch/finally provenance.
test("review preserves exact handoffs, suspension, and completion evidence without granting approval", () => {
  const findings = analyzeSource(
    fixture(`
    setA(true);
    setB(false);
    try {
      await work();
      setB(true);
    } finally {
      setC(false);
    }
  `),
    "panel.tsx",
  );
  const finding = findings.find((item) => item.name === "a");
  assert.equal(finding?.action, "review-state");
  const evidence = finding?.transitions;
  assert.ok(evidence);
  assert.deepEqual(
    evidence.writes.map((write) => [write.state, write.line]),
    [
      ["a", 7],
      ["b", 8],
      ["b", 11],
      ["c", 13],
    ],
  );
  assert.deepEqual(evidence.writes[2]?.controls, [{ kind: "try", line: 9 }]);
  assert.deepEqual(evidence.writes[3]?.controls, [{ kind: "finally", line: 9 }]);
  assert.deepEqual(
    evidence.relations.find((pair) => pair.from === 0 && pair.to === 1),
    { from: 0, to: 1, coexecution: "proven", fusion: "adjacent-literals" },
  );
  assert.deepEqual(
    evidence.relations.find((pair) => pair.from === 0 && pair.to === 2),
    { from: 0, to: 2, coexecution: "disproven", fusion: "preserve-source" },
  );
  assert.equal(
    evidence.relations.find((pair) => pair.from === 2 && pair.to === 3)?.fusion,
    "preserve-source",
  );
  assert.match(
    finding.assumption?.question ?? "",
    /connected group is not a single atomic transition/u,
  );
});

for (const command of [
  "setA(true); setB(compute()); setC(false);",
  "setA(true); work(); setB(false); setC(compute());",
  "setA(true); setA(false); setB(compute()); setC(compute());",
]) {
  test(`does not authorize literal fusion across expression or ordering hazards: ${command}`, () => {
    const findings = analyzeSource(fixture(command), "panel.tsx");
    const evidence = findings.find((finding) => finding.name === "a")?.transitions;
    assert.ok(evidence);
    assert.ok(evidence.relations.length > 0);
    assert.ok(evidence.relations.every((pair) => pair.fusion === "preserve-source"));
  });
}

test("records proven groups too and keeps distinct handler invocations independent", () => {
  const source = fixture("setA(true); setB(true);")
    .replace("const [c,setC]=useState(false);", "")
    .replace("<Unknown open={c}/>", "<button onClick={() => setA(false)}/>");
  const finding = analyzeSource(source, "panel.tsx").find((item) => item.name === "a");
  assert.equal(finding?.action, "use-observable");
  assert.equal(finding.transitions?.writes.length, 3);
  assert.equal(finding.transitions?.relations.length, 1);
  assert.equal(finding.transitions?.relations[0]?.fusion, "adjacent-literals");
  assert.match(finding.message, /never batch an async function/u);
});

test("recognizes the completed handoff before unrelated unsupported work", () => {
  const source = fixture("setA(true); setB(true); for (const item of items) work(item);")
    .replace("const [c,setC]=useState(false);", "")
    .replace("<Unknown open={c}/>", "");
  const findings = analyzeSource(source, "panel.tsx");
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["use-observable", "use-observable"],
  );
  assert.deepEqual(findings[0]?.group?.members, ["a", "b"]);
  assert.equal(findings[0]?.transitions?.relations[0]?.fusion, "adjacent-literals");
});
