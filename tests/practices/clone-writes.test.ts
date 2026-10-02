import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("writes one changed object field through the narrowest observable child", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    const profile$ = observable({ name: "Ada", email: "ada@example.com" });
    export function rename(name: string) {
      const current = profile$.peek();
      profile$.set({ ...current, name });
    }
  `,
    fileName: "fixture.ts",
  });
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["narrow-observable-write"],
  );
  assert.match(requireValue(findings[0]).message ?? "", /profile\$\.name\.set\(name\)/u);
});

test("writes one dynamic record entry without cloning its parent object", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    const rows$ = observable<Record<string, { name: string }>>({});
    export function updateRow(id: string, row: { name: string }) {
      const rows = rows$.peek() ?? {};
      rows$.set({ ...rows, [id]: row });
    }
  `,
    fileName: "fixture.ts",
  });
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["narrow-observable-write"],
  );
  assert.match(requireValue(findings[0]).message ?? "", /rows\$\[id\]\.set\(row\)/u);
});

test("appends one inert value directly to a proven observable array", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useObservable } from "@legendapp/state/react";
    const pages$ = observable<string[]>([]);
    const store$ = observable({ rows: [] as string[] });
    export function append(page: string, row: string) {
      pages$.set(previous => [...previous, page]);
      store$.rows.set([...store$.rows.peek(), row]);
    }
    export function useFiles(file: string) {
      const files$ = useObservable<string[]>([]);
      const appendFile = (next: string) => {
        files$.set(previous => [...previous, next]);
      };
      appendFile(file);
    }
  `,
    fileName: "fixture.ts",
  });
  const appendFindings = findings.filter((finding) => finding.action === "narrow-observable-write");
  assert.equal(appendFindings.length, 3);
  assert.match(requireValue(appendFindings[0]).message ?? "", /pages\$\.push\(page\)/u);
  assert.match(requireValue(appendFindings[1]).message ?? "", /store\$\.rows\.push\(row\)/u);
  assert.match(requireValue(appendFindings[2]).message ?? "", /files\$\.push\(next\)/u);
});

test("keeps array writes whose append or array identity is not exact", () => {
  const bodies = [
    `list$.set(previous => [item, ...previous]);`,
    `list$.set(previous => [...previous, first, second]);`,
    `list$.set(previous => [...previous, ...items]);`,
    `list$.set(previous => [...previous, item].sort());`,
    `list$.set(previous => [...previous, createItem()]);`,
    `list$.set(previous => [...previous, source.value]);`,
    `list$.set(previous => [...previous, previous]);`,
    `list$.set([...list$.get(), item]);`,
    `const current = list$.peek(); consume(current); list$.set([...current, item]);`,
  ];
  for (const body of bodies) {
    const findings = analyzeLegendPractices({
      sourceText: `
      import { observable } from "@legendapp/state";
      const list$ = observable<string[]>([]);
      export function append(item: string, first: string, second: string, items: string[]) {
        ${body}
      }
    `,
      fileName: "fixture.ts",
    });
    assert.deepEqual(
      findings.filter((finding) => finding.action === "narrow-observable-write"),
      [],
      body,
    );
  }

  assert.deepEqual(
    analyzeLegendPractices({
      sourceText: `
      import { observable } from "@legendapp/state";
      const value$ = observable("ab");
      value$.set(previous => [...previous, "c"]);
    `,
      fileName: "fixture.ts",
    }).filter((finding) => finding.action === "narrow-observable-write"),
    [],
  );
  assert.deepEqual(
    analyzeLegendPractices({
      sourceText: `
      import { list$ } from "./store";
      list$.set(previous => [...previous, "item"]);
    `,
      fileName: "fixture.ts",
      importedObservables: new Set(["list$"]),
    }).filter((finding) => finding.action === "narrow-observable-write"),
    [],
  );
});

test("keeps clone writes whose snapshot or replacement path is not equivalent", () => {
  const sources = [
    `const current = profile$.get(); profile$.set({ ...current, name });`,
    `const current = other$.peek(); profile$.set({ ...current, name });`,
    `const current = profile$.peek(); profile$.set({ ...current, name, email });`,
    `const current = profile$.peek(); mutate(current); profile$.set({ ...current, name });`,
    `const current = profile$.peek(); current.email = "changed"; profile$.set({ ...current, name });`,
    `const current = profile$.peek(); current.tags.push("changed"); profile$.set({ ...current, name });`,
    `const current = profile$.peek(); await pause(); profile$.set({ ...current, name });`,
    `const current = profile$.peek(); profile$.set({ ...current, ...updates });`,
    `const current = profile$.peek(); profile$.set({ ...current, get: name });`,
    `const current = profile$.peek(); profile$.set({ ...current, [computeKey()]: name });`,
  ];
  for (const body of sources) {
    assert.deepEqual(
      analyzeLegendPractices({
        sourceText: `
        import { observable } from "@legendapp/state";
        const profile$ = observable({ name: "Ada", email: "ada@example.com", tags: [] as string[] });
        const other$ = observable({ name: "Grace", email: "grace@example.com" });
        export async function rename(name: string, updates: { name: string }) { ${body} }
      `,
        fileName: "fixture.ts",
      }).filter((finding) => finding.action === "narrow-observable-write"),
      [],
      body,
    );
  }
});

test("keeps clone writes when the old snapshot remains observable", () => {
  const bodies = [
    `const current = list$.peek(); list$.set([...current, item]); consume(current);`,
    `const current = profile$.peek(); profile$.set({ ...current, name }); return current.name;`,
    `const current = profile$.peek(); const alias = current; profile$.set({ ...current, name }); return alias.name;`,
    `const current = profile$.peek(); const read = () => current.name; profile$.set({ ...current, name }); return read();`,
    `const current = profile$.peek(); while (current.name !== name) { profile$.set({ ...current, name }); if (stop()) break; }`,
  ];
  for (const body of bodies) {
    const findings = analyzeLegendPractices({
      sourceText: `
      import { observable } from "@legendapp/state";
      const list$ = observable<string[]>([]);
      const profile$ = observable({ name: "Ada", email: "ada@example.com" });
      export function update(item: string, name: string) { ${body} }
    `,
      fileName: "snapshot.ts",
    });

    assert.equal(
      findings.some((finding) => finding.action === "narrow-observable-write"),
      false,
      body,
    );
  }
});

test("appends directly to an imported observable array whose declaring module starts it as an array", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { list$, store$, state } from "./store";
    export function append(item: string, row: string, todo: string) {
      list$.set(previous => [...previous, item]);
      store$.rows.set([...store$.rows.peek(), row]);
      state.todos$.set(previous => [...previous, todo]);
      store$.meta.set(previous => [...previous, item]);
    }
  `,
    fileName: "fixture.ts",
    importedObservableArrayPaths: new Set(["list$", "store$.rows", "state.todos$"]),
    importedObservables: new Set(["list$", "store$", "state.todos$"]),
  });
  assert.deepEqual(
    findings
      .filter((finding) => finding.action === "narrow-observable-write")
      .map(
        (finding) => finding.message?.match(/`(?<replacement>[^`]+)`/u)?.groups?.["replacement"],
      ),
    ["list$.push(item)", "store$.rows.push(row)", "state.todos$.push(todo)"],
  );
});

test("keeps clone writes to a synced root, whose seed is not plain data", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { synced } from "@legendapp/state/sync";
    const pages$ = observable(synced({ initial: [] as string[], persist: { name: "pages" } }));
    const remote$ = observable(synced({ get: () => fetchPages() }));
    export function append(page: string) {
      pages$.set(previous => [...previous, page]);
      remote$.set(previous => [...previous, page]);
    }
  `,
    fileName: "fixture.ts",
  });
  assert.deepEqual(
    findings.filter((finding) => finding.action === "narrow-observable-write"),
    [],
  );
});

test("does not trust an array member that a later spread or computed key may overwrite", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    const spread$ = observable({ rows: [] as string[], ...defaults });
    const computed$ = observable({ rows: [] as string[], [dynamicKey]: null });
    const last$ = observable({ rows: [] as string[], rows: {} });
    export function append(row: string) {
      spread$.rows.set(previous => [...previous, row]);
      computed$.rows.set(previous => [...previous, row]);
      last$.rows.set(previous => [...previous, row]);
    }
  `,
    fileName: "fixture.ts",
  });
  assert.deepEqual(
    findings.filter((finding) => finding.action === "narrow-observable-write"),
    [],
  );
});

const IDENTITY_STORE = `
  import { observable } from "@legendapp/state";
  import { use$, useValue } from "@legendapp/state/react";
  import React, { memo, useCallback, useEffect, useMemo } from "react";
  const rows$ = observable<Record<string, number>>({});
  const store$ = observable({ rows: {} as Record<string, number>, title: "" });
  const Totals = memo(function Totals({ rows }: { rows: Record<string, number> }) {
    return <>{Object.keys(rows).length}</>;
  });
  const MemoTotals = React.memo(Totals);
  export function bump(id: string) {
    rows$.set({ ...rows$.peek(), [id]: 1 });
    store$.rows.set({ ...store$.rows.peek(), [id]: 1 });
  }
`;

test("keeps clone writes whose replaced container identity reaches a memo, an effect, a memoized child, or an escape", () => {
  const consumers = [
    [
      `const rows = useValue(() => rows$.get()); return useMemo(() => Object.keys(rows), [rows]).length;`,
      "rows$[id].set(1)",
    ],
    [
      `const rows = useValue(rows$); const read = useCallback(() => rows.a, [rows]); return read();`,
      "rows$[id].set(1)",
    ],
    [`const rows = use$(rows$); return <Totals rows={rows} />;`, "rows$[id].set(1)"],
    [
      `const rows = rows$.get(); useEffect(() => console.log(rows.a), [rows]); return null;`,
      "rows$[id].set(1)",
    ],
    [`return <Totals rows={rows$.peek()} />;`, "rows$[id].set(1)"],
    [
      `const store = useValue(store$); return useMemo(() => store.rows.a, [store]);`,
      "store$.rows[id].set(1)",
    ],
    [
      `const rows = useValue(store$.rows); return <MemoTotals rows={rows} />;`,
      "store$.rows[id].set(1)",
    ],
    [`const store = store$.get(); return <Totals rows={store.rows} />;`, "store$.rows[id].set(1)"],
    [`return <Rows rows$={store$.rows} />;`, "store$.rows[id].set(1)"],
  ] as const;
  for (const [consumer, removed] of consumers) {
    const replacements = analyzeLegendPractices({
      sourceText: `${IDENTITY_STORE} export function View() { ${consumer} }`,
      fileName: "identity.tsx",
    }).map(
      (finding) => finding.message?.match(/`(?<replacement>[^`]+)`/u)?.groups?.["replacement"],
    );
    assert.ok(!replacements.includes(removed), consumer);
  }
  const escapedOrLinked = [
    `
    import { useObservable } from "@legendapp/state/react";
    export function useFiles(file: string) {
      const files$ = useObservable<string[]>([]);
      files$.set(previous => [...previous, file]);
      return files$;
    }
  `,
    `
    import { observable } from "@legendapp/state";
    const source$ = observable({ rows: {} as Record<string, number> });
    const store$ = observable({ rows: () => source$.rows });
    export function bump(id: string) {
      store$.rows.set({ ...store$.rows.peek(), [id]: 1 });
    }
  `,
  ];
  for (const sourceText of escapedOrLinked) {
    assert.deepEqual(
      analyzeLegendPractices({ sourceText, fileName: "fixture.ts" }).filter(
        (finding) => finding.action === "narrow-observable-write",
      ),
      [],
      sourceText,
    );
  }
});

test("narrows clone writes whose readers ignore the replaced container identity", () => {
  const consumers = [
    `const count = useValue(() => rows$.get().a); return useMemo(() => count * 2, [count]);`,
    `const title = useValue(store$.title); return <Totals rows={{ title }} />;`,
    `const row = useValue(() => store$.rows[id].get()); return useMemo(() => row + 1, [row]);`,
    `return rows$.get()[id] ?? store$.rows.peek()[id];`,
  ];
  for (const consumer of consumers) {
    const findings = analyzeLegendPractices({
      sourceText: `${IDENTITY_STORE} export function View({ id }: { id: string }) { ${consumer} }`,
      fileName: "identity.tsx",
    });
    assert.deepEqual(
      findings
        .filter((finding) => finding.action === "narrow-observable-write")
        .map(
          (finding) => finding.message?.match(/`(?<replacement>[^`]+)`/u)?.groups?.["replacement"],
        ),
      ["rows$[id].set(1)", "store$.rows[id].set(1)"],
      consumer,
    );
  }
});
