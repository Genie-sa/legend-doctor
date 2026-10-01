import type { HookFinding } from "../../src/core/types.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview /><Nav />";

function pad(renderPhase: string, rows = ""): HookFinding[] {
  return analyzeSource(
    `
    import { useCallback, useRef, useState } from "react";
    export function Pad({ revision, rows }: { revision: number; rows: string[] }) {
      const seenRevision = useRef(revision);
      const [undoDepth, setUndoDepth] = useState(0);
      ${renderPhase}
      return (
        <main>
          ${CHROME}
          <button onClick={() => setUndoDepth((depth) => depth + 1)}>push</button>
          <button disabled={undoDepth === 0}>undo</button>
          <ul>${rows}</ul>
        </main>
      );
    }
  `,
    "fixture.tsx",
  );
}

function undoDepth(findings: readonly HookFinding[]): HookFinding {
  return requireValue(findings.find((finding) => finding.name === "undoDepth"));
}

test("keeps state whose setter runs in the owner's render body", () => {
  const finding = undoDepth(
    pad(`if (seenRevision.current !== revision) {
      seenRevision.current = revision;
      setUndoDepth(0);
    }`),
  );
  assert.equal(finding.action, "keep-state");
  assert.match(finding.message, /runs while its owner renders/u);
});

test("keeps state whose setter runs in a synchronous render callback", () => {
  const finding = undoDepth(
    pad(`const labels = rows.map((row) => { if (row === "") setUndoDepth(0); return row; });`),
  );
  assert.equal(finding.action, "keep-state");
});

test("keeps state whose setter runs through a local function called during render", () => {
  const finding = undoDepth(
    pad(`const clearHistory = useCallback(() => setUndoDepth(0), []);
    if (seenRevision.current !== revision) {
      seenRevision.current = revision;
      clearHistory();
    }`),
  );
  assert.equal(finding.action, "keep-state");
});

test("asks no question whose yes would move a render-phase write into an observable", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    export function Pad({ revision }: { revision: number }) {
      const [seen, setSeen] = useState(revision);
      const [undoDepth, setUndoDepth] = useState(0);
      if (seen !== revision) {
        setSeen(revision);
        setUndoDepth(0);
      }
      return (
        <main>
          ${CHROME}
          <button onClick={() => setUndoDepth((depth) => depth + 1)}>push</button>
          <p>{undoDepth}</p>
        </main>
      );
    }
  `,
    "fixture.tsx",
  );
  const finding = undoDepth(findings);
  assert.equal(finding.action, "keep-state");
  assert.equal(finding.assumption, undefined);
});

test("still migrates state whose setter runs only in event handlers", () => {
  assert.equal(undoDepth(pad("")).action, "use-observable");
  assert.equal(
    undoDepth(
      pad(
        "const clearHistory = useCallback(() => setUndoDepth(0), []);",
        `<li onClick={clearHistory}>clear</li>`,
      ),
    ).action,
    "use-observable",
  );
  assert.equal(
    undoDepth(
      pad("", `{rows.map((row) => <li key={row} onClick={() => setUndoDepth(0)}>{row}</li>)}`),
    ).action,
    "use-observable",
  );
});
