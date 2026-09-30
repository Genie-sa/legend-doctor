import type { HookFinding } from "../../src/core/types.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview /><Nav />";

function searchPanel(body: string): HookFinding {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    declare function useServerSearch(query: string): string[] | undefined;
    export function SearchPanel({ query, rows }: { query: string; rows: string[] }) {
      const [debounced, setDebounced] = useState("");
      ${body}
      return (
        <main>
          ${CHROME}
          <p>{debounced}</p>
        </main>
      );
    }
  `,
    "fixture.tsx",
  );
  return requireValue(findings.find((finding) => finding.name === "debounced"));
}

const DETACHED_WRITE = "useEffect(() => { setDebounced(query); }, [query]);";
const READ_AND_WRITE =
  "useEffect(() => { if (debounced !== query) setDebounced(query); }, [query, debounced]);";

test("a detached effect write leaves an escaped state blocked on its escape", () => {
  const finding = searchPanel(`${DETACHED_WRITE}\nconst results = useServerSearch(debounced);`);
  assert.equal(finding.action, "review-state");
  assert.equal(finding.abstentionReason, "ownership-flow-unresolved");
  const { facts, question } = requireValue(finding.assumption);
  assert.equal(facts[0], "ownership-flow-unresolved");
  assert.match(question, /escapes to code this analysis cannot follow/u);
  assert.doesNotMatch(question, /both reads and writes/u);
});

test("a detached effect write leaves a shadowed state without a confirmable question", () => {
  const finding = searchPanel(
    `${DETACHED_WRITE}\nconst labels = rows.map((row) => { const debounced = row.trim(); return debounced; });`,
  );
  assert.equal(finding.action, "review-state");
  assert.equal(finding.abstentionReason, "ownership-flow-unresolved");
  assert.equal(finding.assumption, undefined);
});

test("an effect that reads and writes a shadowed state asks nothing the leaf wrap cannot answer", () => {
  const finding = searchPanel(
    `${READ_AND_WRITE}\nconst labels = rows.map((row) => { const debounced = row.trim(); return debounced; });`,
  );
  assert.equal(finding.action, "review-state");
  assert.equal(finding.abstentionReason, "effect-write-ownership-unresolved");
  assert.equal(finding.assumption, undefined);
});

test("an effect that reads and writes an unescaped state still asks the effect and leaf facts", () => {
  const finding = searchPanel(READ_AND_WRITE);
  assert.equal(finding.abstentionReason, "effect-write-ownership-unresolved");
  const assumption = requireValue(finding.assumption);
  assert.deepEqual(assumption.facts, ["effect-write-ownership-unresolved", "render-cut-unproven"]);
  assert.equal(assumption.ifConfirmed, "use-observable");
  assert.match(assumption.question, /both reads and writes `debounced`/u);
});
