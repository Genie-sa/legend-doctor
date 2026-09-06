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
