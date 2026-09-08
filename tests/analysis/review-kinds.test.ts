import { ConfirmationSet } from "../../src/analysis/assumptions/confirmations.js";
import type { HookFinding } from "../../src/core/types.js";
import { analyzeSourceWith } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const SOURCE = `
  import { useState } from "react";
  export function Screen({ rows }) {
    const [query, setQuery] = useState("");
    return <main><header /><nav /><aside /><section /><article /><footer /><hr /><p /><p /><p /><p /><p />
      <input value={query} onChange={event => setQuery(event.target.value)} />
      {rows.filter(row => row.includes(query)).map(row => <p key={row}>{row}</p>)}
    </main>;
  }
`;

function query(confirmations: ConfirmationSet | null = null): HookFinding {
  return requireValue(
    analyzeSourceWith(SOURCE, "screen.tsx", { confirmations }).find(
      (finding) => finding.name === "query",
    ),
  );
}

test("review guidance distinguishes open, declined, stale, and converted answers", () => {
  const initial = query();
  const assumption = requireValue(initial.assumption);
  assert.equal(initial.review?.kind, "confirm");
  assert.equal(initial.review.next, assumption.question);
  assert.deepEqual(initial.review.blockers, ["render-cut-unproven"]);
  const rejected = query(
    new ConfirmationSet([{ id: assumption.id, answer: "no", fingerprint: assumption.fingerprint }]),
  );
  assert.equal(rejected.review?.kind, "declined");
  assert.equal(rejected.action, "review-state");
  const stale = query(
    new ConfirmationSet([{ id: assumption.id, answer: "yes", fingerprint: "old-source" }]),
  );
  assert.equal(stale.review?.kind, "recheck");
  assert.equal(stale.action, "review-state");
  const converted = query(
    new ConfirmationSet([
      { id: assumption.id, answer: "yes", fingerprint: assumption.fingerprint },
    ]),
  );
  assert.equal(converted.action, "use-observable");
  assert.equal(converted.review, undefined);
});

test("unsupported tuple bindings give a different next step from a render proof gap", () => {
  const findings = analyzeSourceWith(
    'import { useState } from "react"; export function Screen() { const state = useState(0); return <button onClick={() => state[1](1)}>{state[0]}</button>; }',
    "screen.tsx",
    {},
  );
  const finding = requireValue(findings[0]);
  assert.equal(finding.review?.kind, "unsupported");
  assert.deepEqual(finding.review.blockers, ["binding-shape-unsupported"]);
  assert.match(finding.review.next, /binding/u);
  assert.equal(finding.disposition, "candidate");
});

test("React bailout state is a no-benefit review, not a confirmable render optimization", () => {
  const findings = analyzeSourceWith(
    'import { useState } from "react"; export function Screen() { const [value, setValue] = useState(false); return <button onClick={() => setValue(false)}>{value}</button>; }',
    "screen.tsx",
    {},
  );
  const finding = requireValue(findings[0]);
  assert.equal(finding.review?.kind, "no-proven-benefit");
  assert.equal(finding.assumption, undefined);
  assert.equal(finding.action, "review-state");
});

test("effect review guidance follows its state questions without suggesting an independent edit", () => {
  const source = SOURCE.replace("import { useState }", "import { useState, useEffect }").replace(
    "return <main>",
    "useEffect(() => { external(query); }, [query]); return <main>",
  );
  const findings = analyzeSourceWith(source, "screen.tsx", {});
  const effect = requireValue(findings.find((finding) => finding.hook === "useEffect"));
  const state = requireValue(findings.find((finding) => finding.name === "query"));
  assert.equal(effect.review?.kind, "dependency");
  assert.deepEqual(effect.waitsOn, [requireValue(state.assumption).id]);
  assert.equal(effect.action, "review-effect");
});
