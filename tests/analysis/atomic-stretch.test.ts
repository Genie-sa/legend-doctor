import type { HookFinding } from "../../src/core/types.js";
import { analyzeSourceWith } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview /><Nav />";

const PROVEN = /^atomic transition proven: /u;

function alerts(fail: string): string {
  return `
    import { startTransition, useState } from "react";
    import { flushSync } from "react-dom";
    declare function report(message: string): Promise<void>;
    export function Panel() {
      const [error, setError] = useState<string | null>(null);
      const [hint, setHint] = useState<string | null>(null);
      ${fail}
      return <main>${CHROME}
        <button onClick={() => fail("boom", true)} />
        {error ? <p role="alert">{error.toUpperCase()}</p> : null}
        {hint ? <p>{hint.toUpperCase()}</p> : null}
      </main>;
    }
  `;
}

function states(source: string): readonly HookFinding[] {
  return analyzeSourceWith(source, "src/panel.tsx", {}).filter(
    (finding) => finding.hook === "useState",
  );
}

function questions(source: string): readonly (string | undefined)[] {
  return states(source).map((finding) => finding.assumption?.facts.join("+"));
}

test("co-writes in one synchronous stretch drop the atomic question for the next blocker", () => {
  const findings = states(
    alerts(
      `const fail = (message: string, _retry: boolean) => { setError(message); setHint(message + "!"); };`,
    ),
  );
  assert.deepEqual(
    findings.map((finding) => [finding.abstentionReason, finding.assumption?.facts]),
    [
      ["render-cut-unproven", ["render-cut-unproven"]],
      ["render-cut-unproven", ["render-cut-unproven"]],
    ],
  );
  assert.ok(findings.every((finding) => PROVEN.test(finding.evidence.at(-1) ?? "")));
});

test("an await on one path between the co-writes keeps the atomic question", () => {
  assert.deepEqual(
    questions(
      alerts(
        `const fail = async (message: string, retry: boolean) => { setError(message); if (retry) await report(message); setHint(message + "!"); };`,
      ),
    ),
    [
      "atomic-transition-unproven+render-cut-unproven",
      "atomic-transition-unproven+render-cut-unproven",
    ],
  );
});

test("co-writes inside a transition stay unproven and ask nothing a commit-sensitive state cannot honour", () => {
  const findings = states(
    alerts(
      `const fail = (message: string, _retry: boolean) => { startTransition(() => { setError(message); setHint(message + "!"); }); };`,
    ),
  );
  assert.deepEqual(
    findings.map((finding) => [finding.abstentionReason, finding.assumption]),
    [
      ["atomic-transition-unproven", undefined],
      ["atomic-transition-unproven", undefined],
    ],
  );
  assert.ok(findings.every((finding) => !PROVEN.test(finding.evidence.at(-1) ?? "")));
});

test("an every-commit effect leaves no question whose yes it would override", () => {
  const source = alerts(
    `const fail = async (message: string, retry: boolean) => { setError(message); if (retry) await report(message); setHint(message + "!"); };
      useEffect(() => { document.title = String(Date.now()); });`,
  ).replace("{ startTransition, useState }", "{ startTransition, useEffect, useState }");
  assert.deepEqual(
    states(source).map((finding) => [finding.abstentionReason, finding.assumption]),
    [
      ["atomic-transition-unproven", undefined],
      ["atomic-transition-unproven", undefined],
    ],
  );
});

test("a flushSync split between the co-writes keeps the atomic question", () => {
  const findings = states(
    alerts(
      `const fail = (message: string, _retry: boolean) => { setHint(message + "!"); flushSync(() => setError(null)); setError(message); };`,
    ),
  );
  assert.deepEqual(
    findings.map((finding) => finding.assumption?.facts.join("+")),
    [
      "atomic-transition-unproven+render-cut-unproven",
      "atomic-transition-unproven+render-cut-unproven",
    ],
  );
  assert.ok(findings.every((finding) => !PROVEN.test(finding.evidence.at(-1) ?? "")));
});
