import type { HookFinding } from "../../src/core/types.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />";

function states(source: string): HookFinding[] {
  return analyzeSource(source, "fixture.tsx").filter((finding) => finding.hook === "useState");
}

test("subscribes at every independent JSX site of a broad owner's state", () => {
  const [finding] = states(`
    import { useState } from "react";
    export function Dashboard({ total }: { total: number }) {
      const [count, setCount] = useState(0);
      return (
        <section className="dashboard">
          ${CHROME}
          <p>{count} of {total}</p>
          <div className={count > 0 ? "active" : "idle"} />
          <button onClick={() => setCount(count + 1)}>Add</button>
          <button onClick={() => setCount(0)}>Reset</button>
          <footer>{count > 3 ? <strong>Many</strong> : null}</footer>
        </section>
      );
    }
  `);
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /subscribe at its 3 render sites/u);
  assert.match(finding?.message ?? "", /wrap the child expression in `Computed`/u);
  assert.match(finding?.message ?? "", /make the attribute a reactive prop \(className on <div>/u);
  assert.match(finding?.message ?? "", /Snapshot command reads with `\.peek\(\)`/u);
});

test("abstains when a read feeds a derived value, a render callback, or an unverified child", () => {
  const source = (body: string, extra = ""): string => `
    import { useState } from "react";
    export function Dashboard({ items }: { items: string[] }) {
      const [count, setCount] = useState(0);
      ${extra}
      return (
        <section>
          ${CHROME}
          ${body}
          <button onClick={() => setCount(1)}>Add</button>
        </section>
      );
    }
  `;
  const cases = {
    derived: source("<p>{label}</p>", 'const label = String(count) + " items";'),
    renderCallback: source("<ul>{items.map((item) => <li key={item}>{item}{count}</li>)}</ul>"),
    unverifiedChild: source("<Badge value={count} /><p>{count}</p>"),
    guard: source("<p>{count}</p>", "if (count < 0) return null;"),
  } satisfies Record<string, string>;
  for (const [name, fixture] of Object.entries(cases)) {
    const [finding] = states(fixture);
    assert.doesNotMatch(finding?.message ?? "", /render sites/u, name);
  }
});

test("does not fire below the broad-owner threshold or with companion writes", () => {
  const compact = states(`
    import { useState } from "react";
    export function Card() {
      const [count, setCount] = useState(0);
      return (
        <section>
          <p>{count}</p>
          <div className={count > 0 ? "active" : "idle"} />
          <button onClick={() => setCount(1)}>Add</button>
        </section>
      );
    }
  `);
  assert.doesNotMatch(compact[0]?.message ?? "", /render sites/u);
  const companion = states(`
    import { useState } from "react";
    export function Dashboard() {
      const [count, setCount] = useState(0);
      const [label, setLabel] = useState("");
      return (
        <section>
          ${CHROME}
          <p>{count}</p>
          <em>{label}</em>
          <div className={count > 0 ? "active" : "idle"} />
          <button onClick={() => { setCount(1); setLabel("one"); }}>Add</button>
        </section>
      );
    }
  `);
  assert.doesNotMatch(companion[0]?.message ?? "", /render sites/u);
});

test("accepts translation calls and pure derived constants inside wrapped sites", () => {
  const [finding] = states(`
    import { useState } from "react";
    import { useTranslation } from "react-i18next";
    export function Dashboard() {
      const { t } = useTranslation();
      const [count, setCount] = useState(0);
      const tone = count > 3 ? "loud" : "quiet";
      return (
        <section>
          ${CHROME}
          <p>{t("items", { count })}</p>
          <em className={tone}>{tone}</em>
          <button onClick={() => setCount(count + 1)}>Add</button>
        </section>
      );
    }
  `);
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /subscribe at its 3 render sites/u);
});

test("rejects unknown calls and impure derived constants inside wrapped sites", () => {
  const source = (body: string, extra = ""): string => `
    import { useState } from "react";
    import { format } from "./format";
    export function Dashboard() {
      const [count, setCount] = useState(0);
      ${extra}
      return (
        <section>
          ${CHROME}
          ${body}
          <button onClick={() => setCount(1)}>Add</button>
        </section>
      );
    }
  `;
  const cases = {
    unknownCall: source("<p>{format(count)}</p>"),
    impureDerived: source("<p>{label}</p>", "const label = format(count);"),
    localTranslation: source("<p>{t(count)}</p>", "const t = (value: number) => String(value);"),
  } satisfies Record<string, string>;
  for (const [name, fixture] of Object.entries(cases)) {
    const [finding] = states(fixture);
    assert.doesNotMatch(finding?.message ?? "", /render sites/u, name);
  }
});

test("follows a derived constant built from read-only prototype methods", () => {
  const source = (projection: string): string => `
    import { useState } from "react";
    export function Dashboard({ names }: { names: string[] }) {
      const [query, setQuery] = useState("");
      const matches = ${projection};
      return (
        <section>
          ${CHROME}
          <p>{matches}</p>
          <input value={query} onChange={(event) => setQuery(event.target.value)} />
        </section>
      );
    }
  `;
  const [pure] = states(
    source(
      'names.filter((name) => name.toLowerCase().includes(query.toLowerCase())).map((name) => name.trim()).join(", ")',
    ),
  );
  assert.equal(pure?.action, "use-observable");
  assert.match(pure?.message ?? "", /render sites/u);
  const [mutating] = states(source("names.push(query)"));
  assert.doesNotMatch(mutating?.message ?? "", /render sites/u);
});

test("wraps sites that read through read-only built-in calls on proven receivers", () => {
  const [finding] = states(`
    import { useState } from "react";
    interface Item { readonly done: boolean; readonly label: string }
    export function Dashboard() {
      const [items, setItems] = useState<readonly Item[]>([]);
      return (
        <section>
          ${CHROME}
          <p>{items.filter((item) => item.done).length} done</p>
          <em>{Math.max(0, items.length - 3)} more</em>
          <span title={String(items.length)} />
          <ul>{items.map((item) => <li key={item.label}>{item.label}</li>)}</ul>
          <button onClick={() => setItems([])}>Clear</button>
        </section>
      );
    }
  `);
  assert.equal(finding?.action, "use-observable");
  assert.match(finding?.message ?? "", /subscribe at its 4 render sites/u);
});

test("rejects mutating, impure, nondeterministic, and unproven-receiver calls inside wrapped sites", () => {
  const source = (body: string, extra = ""): string => `
    import { useState } from "react";
    interface Item { readonly done: boolean; readonly label: string }
    interface Store {
      filter(predicate: (row: Item) => boolean): Item[];
      includes(value: Item): boolean;
    }
    export function Dashboard({ store }: { store: Store }) {
      const [items, setItems] = useState<Item[]>([]);
      const [seen, setSeen] = useState(0);
      ${extra}
      return (
        <section>
          ${CHROME}
          <p>{seen}</p>
          <em>{items.length}</em>
          ${body}
          <button onClick={() => setItems([])}>Clear</button>
        </section>
      );
    }
  `;
  const cases = {
    sort: source("<p>{items.sort().length}</p>"),
    reverse: source("<p>{items.reverse().length}</p>"),
    splice: source("<p>{items.splice(0, 1).length}</p>"),
    setterInCallback: source(
      "<p>{items.map((item) => { setSeen(1); return item.label; }).join()}</p>",
    ),
    outerWriteInCallback: source(
      "<p>{items.map((item) => { total += 1; return item.label; }).join()}</p>",
      "let total = 0;",
    ),
    unprovenFilterReceiver: source(
      "<p>{items.length > 0 && store.filter((row) => row.done).length}</p>",
    ),
    unprovenIncludesReceiver: source("<p>{String(store.includes(items[0]!))}</p>"),
    unprovenCallback: source(
      "<p>{items.filter(isDone).length}</p>",
      "const isDone = (item: Item) => item.done;",
    ),
    nondeterministic: source("<p>{Math.random() > 0.5 ? items.length : 0}</p>"),
    shadowedGlobal: source(
      "<p>{String(items.length)}</p>",
      "const String = (value: number) => value.toFixed();",
    ),
  } satisfies Record<string, string>;
  const itemsFinding = (fixture: string): HookFinding | undefined =>
    states(fixture).find((candidate) => candidate.name === "items");
  assert.match(
    itemsFinding(source("<p>{items.filter((item) => item.done).length}</p>"))?.message ?? "",
    /render site/u,
  );
  for (const [name, fixture] of Object.entries(cases)) {
    assert.doesNotMatch(itemsFinding(fixture)?.message ?? "", /render site/u, name);
  }
});
