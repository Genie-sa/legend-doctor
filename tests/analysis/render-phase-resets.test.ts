import { ConfirmationSet } from "../../src/analysis/assumptions/confirmations.js";
import type { HookFinding } from "../../src/core/types.js";
import { analyzeSourceWith } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

function resetEffect(
  body: string,
  confirmations: ConfirmationSet | null = null,
  draftState = 'useState("")',
): HookFinding {
  const source = `
    import { useEffect, useLayoutEffect, useRef, useState } from "react";
    const FIRST_PAGE = 1;
    export function Results({ query, rows, onPick, sort = [], filters: { scope } }) {
      const [tab, setTab] = useState("all");
      const [page, setPage] = useState(FIRST_PAGE);
      const [draft, setDraft] = ${draftState};
      const ref = useRef(0);
      const columns = [query];
      const format = () => query;
      const selection = useSelection();
      const filterKey = \`\${query}|\${tab}\`;
      ${body}
      return <input value={draft + tab + page + rows.length} onChange={(event) => { setDraft(event.target.value); setTab(event.target.value); onPick(); }} />;
    }
  `;
  return requireValue(
    analyzeSourceWith(source, "fixture.tsx", { confirmations }).find(
      (finding) => finding.hook === "useEffect",
    ),
  );
}

test("a reset keyed by local state, a module binding, and a length is a change", () => {
  const finding = resetEffect("useEffect(() => { setPage(FIRST_PAGE); }, [tab, rows.length]);");
  assert.equal(finding.action, "reset-during-render");
  assert.equal(finding.disposition, "change");
  assert.match(finding.message, /useState\(\[tab, rows\.length\]\)/u);
  assert.match(
    finding.message,
    /if \(tab !== prevDeps\[0\] \|\| rows\.length !== prevDeps\[1\]\)/u,
  );
  assert.doesNotMatch(finding.message, /initialize/u);
});

test("a reset keyed by component props is a change, since a render-phase rerun keeps them", () => {
  const finding = resetEffect('useEffect(() => setDraft(""), [query, scope.id]);');
  assert.equal(finding.action, "reset-during-render");
  assert.equal(finding.disposition, "change");
});

test("a reset keyed by a local primitive is a change, since it compares by value", () => {
  const finding = resetEffect("useEffect(() => { setPage(FIRST_PAGE); }, [filterKey]);");
  assert.equal(finding.action, "reset-during-render");
});

test("a reset keyed by a hook result asks whether the result keeps its identity", () => {
  const finding = resetEffect('useEffect(() => setDraft(""), [selection]);');
  assert.equal(finding.action, "review-effect");
  assert.equal(finding.abstentionReason, "dependency-identity-unproven");
  const assumption = requireValue(finding.assumption);
  assert.equal(assumption.ifConfirmed, "reset-during-render");
  assert.match(assumption.question, /^`selection` keeps its identity/u);
});

test("a reset keyed by a defaulted prop asks, since the default is rebuilt every render", () => {
  const finding = resetEffect('useEffect(() => setDraft(""), [sort]);');
  assert.equal(finding.abstentionReason, "dependency-identity-unproven");
});

test("a reset keyed by a custom hook's parameter asks, since the caller rebuilds it", () => {
  const finding = analyzeSourceWith(
    `
      import { useEffect, useState } from "react";
      export function useDraft(query) {
        const [draft, setDraft] = useState("");
        useEffect(() => setDraft(""), [query]);
        return [draft, setDraft];
      }
    `,
    "fixture.ts",
    { confirmations: null },
  ).find((result) => result.hook === "useEffect");
  assert.equal(requireValue(finding).abstentionReason, "dependency-identity-unproven");
});

test("a confirmed identity answer turns the reset into a change with a verification recipe", () => {
  const body = 'useEffect(() => setDraft(""), [selection]);';
  const { id } = requireValue(resetEffect(body).assumption);
  const finding = resetEffect(body, new ConfirmationSet([{ answer: "yes", id }]));
  assert.equal(finding.action, "reset-during-render");
  assert.equal(finding.disposition, "change");
  assert.match(
    finding.message,
    /const \[prevSelection, setPrevSelection\] = useState\(selection\)/u,
  );
  assert.match(
    requireValue(finding.verification).expect,
    /commits the owner once instead of twice/u,
  );
});

test("an initializer laid out differently from the reset value is the same mount value", () => {
  const finding = resetEffect(
    'useEffect(() => {\n        setDraft(\n          tab /* reset */ ? "a" : "b",\n        );\n      }, [tab]);',
    null,
    'useState(tab ? "a" : "b")',
  );
  assert.equal(finding.action, "reset-during-render");
});

test("a lazy initializer that computes the reset value is the same mount value", () => {
  const finding = resetEffect(
    'useEffect(() => { setDraft(rows.length ? "rows" : ""); }, [tab]);',
    null,
    'useState(() => (rows.length ? "rows" : ""))',
  );
  assert.equal(finding.action, "reset-during-render");
});

test("a guarded reset keeps its guard inside the comparison", () => {
  const finding = resetEffect(
    'useEffect(() => { if (tab === "all") { setPage(FIRST_PAGE); } }, [tab]);',
  );
  assert.equal(finding.action, "reset-during-render");
  assert.match(finding.message, /setPrevTab\(tab\); if \(tab === "all"\)/u);
});

for (const [label, initializer, body, dependency] of [
  [
    "a literal the initializer maps to the written value",
    'useState(query === "app" ? "open" : "")',
    'if (query === "link") { setDraft(""); }',
    "query",
  ],
  [
    "a count the initializer compares to the same value",
    'useState(rows.length > 0 ? "rows" : "")',
    'if (rows.length === 0) setDraft("");',
    "rows.length",
  ],
  [
    "each literal it writes through, which the initializer also selects",
    'useState(query === "b" ? "b" : "a")',
    'if (query === "a" || query === "b") setDraft(query);',
    "query",
  ],
] as const) {
  test(`a guarded reset that pins ${label} keeps the first commit and is a change`, () => {
    const finding = resetEffect(
      `useEffect(() => { ${body} }, [${dependency}]);`,
      null,
      initializer,
    );
    assert.equal(finding.action, "reset-during-render");
  });
}

for (const [label, initializer, body, dependency] of [
  [
    "a range the guard does not pin",
    'useState("")',
    'if (rows.length > 0) setDraft("rows");',
    "rows.length",
  ],
  [
    "a literal under which the initializer differs",
    'useState(query === "app" ? "open" : "")',
    'if (query === "app") setDraft("");',
    "query",
  ],
  [
    "two subjects",
    'useState(query === "app" ? "open" : "")',
    'if (query === "link" || tab === "all") setDraft("");',
    "query, tab",
  ],
  [
    "a zero it stores, which may be -0",
    "useState(rows.length === 0 ? 0 : 1)",
    "if (rows.length === 0) setDraft(rows.length);",
    "rows.length",
  ],
  [
    "a value the initializer reads through another name",
    'useState(filterKey === "a" ? "a" : "")',
    'if (query === "a") setDraft("a");',
    "query",
  ],
] as const) {
  test(`a guarded reset over ${label} is not a render-phase reset`, () => {
    const finding = resetEffect(
      `useEffect(() => { ${body} }, [${dependency}]);`,
      null,
      initializer,
    );
    assert.notEqual(finding.action, "reset-during-render");
    assert.notEqual(finding.abstentionReason, "dependency-identity-unproven");
  });
}

test("a layout-effect reset still resets during render", () => {
  const finding = resetEffect("useLayoutEffect(() => { setPage(FIRST_PAGE); }, [tab]);");
  assert.equal(finding.action, "reset-during-render");
});

for (const [label, body] of [
  ["reads the state it resets", "useEffect(() => { setPage(page + 1); }, [tab]);"],
  [
    "writes another value than the initializer on mount",
    "useEffect(() => { setPage(2); }, [tab]);",
  ],
  [
    "applies an updater on mount",
    "useEffect(() => { setPage((current) => Math.min(current, 3)); }, [tab]);",
  ],
  ["calls an unknown function", "useEffect(() => { setPage(track(tab)); }, [tab]);"],
  [
    "returns a cleanup",
    "useEffect(() => { setPage(FIRST_PAGE); return () => setPage(0); }, [tab]);",
  ],
  ["is async", "useEffect(async () => { setPage(FIRST_PAGE); }, [tab]);"],
  ["writes a ref", "useEffect(() => { ref.current = 1; setPage(FIRST_PAGE); }, [tab]);"],
  ["reads a ref", "useEffect(() => { setPage(ref.current); }, [tab]);"],
  ["has an else branch", "useEffect(() => { if (tab) setPage(1); else setPage(2); }, [tab]);"],
  ["writes one state twice", "useEffect(() => { setPage(1); setPage(2); }, [tab]);"],
  ["calls a prop", "useEffect(() => { onPick(tab); }, [tab]);"],
  [
    "depends on an array rebuilt each render",
    "useEffect(() => { setPage(FIRST_PAGE); }, [columns]);",
  ],
  [
    "depends on a function rebuilt each render",
    "useEffect(() => { setPage(FIRST_PAGE); }, [format]);",
  ],
  ["depends on the state it resets", "useEffect(() => { setPage(FIRST_PAGE); }, [page]);"],
  ["has no dependency list", "useEffect(() => { setPage(FIRST_PAGE); });"],
  ["runs once on mount", "useEffect(() => { setPage(FIRST_PAGE); }, []);"],
] as const) {
  test(`an effect that ${label} is not a render-phase reset`, () => {
    const finding = resetEffect(body);
    assert.notEqual(finding.action, "reset-during-render");
    assert.notEqual(finding.abstentionReason, "dependency-identity-unproven");
  });
}
