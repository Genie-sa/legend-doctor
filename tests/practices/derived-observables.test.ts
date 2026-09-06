import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const derived = (source: string): LegendPracticeFinding[] =>
  analyzeLegendPractices({ sourceText: source, fileName: "fixture.tsx" }).filter(
    (finding) => finding.action === "derive-computed-observable",
  );

test("computes a primitive memo over confined useValue inputs as one observable", () => {
  const [finding] = derived(`
    import { useMemo } from "react";
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const library$ = observable({ selectedView: "all", selectedPlaylistId: "" });
    export function Header() {
      const selectedView = useValue(library$.selectedView);
      const selectedPlaylistId = useValue(library$.selectedPlaylistId);
      const title = useMemo(
        () => (selectedView === "playlist" && selectedPlaylistId ? \`playlist-\${selectedPlaylistId}\` : "Library"),
        [selectedView, selectedPlaylistId],
      );
      return <h1>{title}</h1>;
    }
  `);
  const found = requireValue(finding);
  assert.equal(found.confidence, "certain");
  assert.equal(found.disposition, "change");
  assert.equal(found.practice, "reactivity");
  assert.equal(found.location.line, 9);
  assert.match(found.message, /const title\$ = useObservable\(\(\) => …\)/u);
  assert.match(found.message, /`library\$\.selectedView\.get\(\)` for `selectedView`/u);
  assert.match(found.message, /const title = useValue\(title\$\)/u);
  assert.match(found.evidence.join(" "), /read only inside this memo/u);
});

test("proves primitive results through callback-local counters and namespace hooks", () => {
  const [finding] = derived(`
    import React from "react";
    import type { Observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    type Filters = { min: number | null; max: number | null; tags: string[] };
    export function useActiveFilterCount(filters$: Observable<Filters>) {
      const filters = useValue(filters$);
      const count = React.useMemo(() => {
        let total = 0;
        if (filters.min !== null || filters.max !== null) total++;
        if (filters.tags.length > 0) total += 1;
        return total;
      }, [filters]);
      return count;
    }
  `);
  const found = requireValue(finding);
  assert.match(found.message, /`useValue\(filters\$\)` subscription it depends on/u);
  assert.match(found.message, /`filters\$\.get\(\)` for `filters`/u);
});

test("keeps memos whose inputs, dependencies, body, or result are not proven", () => {
  const fixture = (body: string): LegendPracticeFinding[] =>
    derived(`
    import { useMemo, useRef } from "react";
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const state$ = observable({ query: "", rows: [] as string[], limit: 10 });
    const other$ = observable({ flag: false });
    export function Panel({ locale }: { locale: string }) {
      const query = useValue(state$.query);
      const rows = useValue(state$.rows);
      const latest = useRef(0);
      const format = (value: string) => value.trim();
      ${body}
      return <span>{String(result)}</span>;
    }
  `);
  for (const body of [
    `const result = useMemo(() => query.length > 0, [query]); const echo = query;`,
    `const result = useMemo(() => query === locale, [query, locale]);`,
    `const result = useMemo(() => ({ query }), [query]);`,
    `const result = useMemo(() => rows.filter((row) => row === query), [rows, query]);`,
    `const result = useMemo(() => query, [query]);`,
    `const result = useMemo(() => rows.length, [rows]);`,
    `const result = useMemo(() => query === "" || other$.flag.peek(), [query]);`,
    `const result = useMemo(() => format(query) === "", [query]);`,
    `const result = useMemo(() => latest.current > 0 && query === "", [query]);`,
    `const result = useMemo(() => query === "", []);`,
    `let result = useMemo(() => query === "", [query]);`,
    `const result = useMemo(() => query === "", [query, query]);`,
    `const result = useMemo(() => { if (query) { return rows; } }, [query, rows]);`,
    `const result = useMemo(async () => query === "", [query]);`,
  ]) {
    assert.deepEqual(fixture(body), [], body);
  }
});

test("treats a fall-through memo body as returning the primitive undefined", () => {
  const findings = derived(`
    import { useMemo } from "react";
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const state$ = observable({ query: "" });
    export function Panel() {
      const query = useValue(state$.query);
      const result = useMemo(() => {
        if (query) {
          return true;
        }
      }, [query]);
      return <span>{String(result)}</span>;
    }
  `);
  assert.equal(findings.length, 1);
});

test("keeps memos over useValue calls with options or selector inputs", () => {
  assert.deepEqual(
    derived(`
    import { useMemo } from "react";
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const state$ = observable({ query: "", limit: 10 });
    export function Panel() {
      const query = useValue(state$.query, { suspense: true });
      const limit = useValue(() => state$.limit.get());
      const short = useMemo(() => query.length < limit, [query, limit]);
      return <span>{String(short)}</span>;
    }
  `),
    [],
  );
});

test("accepts a bare return alongside primitive results", () => {
  const findings = derived(`
    import { useMemo } from "react";
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const state$ = observable({ total: 0, pending: false });
    export function Badge() {
      const total = useValue(state$.total);
      const pending = useValue(state$.pending);
      const label = useMemo(() => {
        if (pending) {
          return;
        }
        return total > 99 ? "99+" : String(total);
      }, [total, pending]);
      return <span>{label}</span>;
    }
  `);
  assert.equal(findings.length, 1);
  assert.match(
    requireValue(findings[0]).message,
    /`state\$\.total\.get\(\)` for `total` and `state\$\.pending\.get\(\)` for `pending`/u,
  );
});
