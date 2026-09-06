import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("isolates an exact keyed record entry in a stable repeated row", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    type Verdict = "up" | "down";
    type Row = { id: string };
    export function Screen({ rows }: { rows: Row[] }) {
      const { mutateAsync: submitFeedback } = useSubmitFeedback();
      const [feedback, setFeedback] = useState<Record<string, Verdict>>({});
      async function vote(row: Row, verdict: Verdict) {
        setFeedback(previous => ({ ...previous, [row.id]: verdict }));
        try {
          await submitFeedback(row.id, verdict);
        } catch {
          setFeedback(previous => {
            const next = { ...previous };
            delete next[row.id];
            return next;
          });
        }
      }
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        {rows.map(row => <div key={row.id}>
          <button onClick={() => vote(row, "up")} aria-pressed={feedback[row.id] === "up"}>Up</button>
          <button onClick={() => vote(row, "down")} aria-pressed={feedback[row.id] === "down"}>Down</button>
        </div>)}
      </main>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "feedback");

  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /dynamic entry/u);
  assert.deepEqual(requireValue(finding).stateModel, {
    ownership: "local-observable",
    subscription: "leaf-use-value",
  });
});

test("keeps ambiguous keyed record entries conservative", () => {
  const variants = [
    {
      extra: "",
      label: "unstable row key",
      projection: 'aria-pressed={feedback[row.id] === "up"}',
      rowKey: "index",
      updater: "previous => ({ ...previous, [row.id]: verdict })",
    },
    {
      extra: "",
      label: "mismatched row key",
      projection: 'aria-pressed={feedback[row.id] === "up"}',
      rowKey: "row.slug",
      updater: "previous => ({ ...previous, [row.id]: verdict })",
    },
    {
      extra: "",
      label: "entry controls mount",
      projection: "{feedback[row.id] && <span>Voted</span>}",
      rowKey: "row.id",
      updater: "previous => ({ ...previous, [row.id]: verdict })",
    },
    {
      extra: "",
      label: "multi-entry write",
      projection: 'aria-pressed={feedback[row.id] === "up"}',
      rowKey: "row.id",
      updater: 'previous => ({ ...previous, [row.id]: verdict, global: "up" })',
    },
    {
      extra: "",
      label: "rollback side effect",
      projection: 'aria-pressed={feedback[row.id] === "up"}',
      rowKey: "row.id",
      updater:
        "previous => { const next = { ...previous }; audit(next); delete next[row.id]; return next; }",
    },
    {
      extra: "const count = Object.keys(feedback).length; void count;",
      label: "whole-record read",
      projection: 'aria-pressed={feedback[row.id] === "up"}',
      rowKey: "row.id",
      updater: "previous => ({ ...previous, [row.id]: verdict })",
    },
    {
      extra: "<button onClick={() => setFeedback({})}>Reset</button>",
      label: "whole-record reset",
      projection: 'aria-pressed={feedback[row.id] === "up"}',
      rowKey: "row.id",
      updater: "previous => ({ ...previous, [row.id]: verdict })",
    },
  ];

  for (const variant of variants) {
    const finding = analyzeSource(
      `
      import { useState } from "react";
      type Verdict = "up" | "down";
      type Row = { id: string; slug: string };
      export function Screen({ rows }: { rows: Row[] }) {
        const { mutateAsync: submitFeedback } = useSubmitFeedback();
        const [feedback, setFeedback] = useState<Record<string, Verdict>>({});
        async function vote(row: Row, verdict: Verdict) {
          setFeedback(${variant.updater});
          await submitFeedback(row.id, verdict);
        }
        ${variant.extra.startsWith("const") ? variant.extra : ""}
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
          {rows.map((row, index) => <div key={${variant.rowKey}}>
            ${
              variant.projection.startsWith("{")
                ? variant.projection
                : `<button onClick={() => vote(row, "up")} ${variant.projection}>Up</button>`
            }
          </div>)}
          ${variant.extra.startsWith("<") ? variant.extra : ""}
        </main>;
      }
    `,
      "fixture.tsx",
    ).find((candidate) => candidate.name === "feedback");
    assert.doesNotMatch(requireValue(finding).message ?? "", /dynamic entry/u, variant.label);
  }
});

test("separates observable ownership from leaf subscription placement", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    function Row() { return null; }
    export function LargeOwner({ rows }: { rows: string[] }) {
      ${Array.from({ length: 145 }, (_unusedValue, index) => `const padding${index} = ${index};`).join("\n")}
      const [selected, setSelected] = useState<string | null>(null);
      return rows.map(id => <Row selected={selected} onSelect={setSelected} />);
    }
  `,
    "fixture.tsx",
  );
  assert.deepEqual(requireValue(finding).stateModel, {
    ownership: "local-observable",
    subscription: "leaf-use-value",
  });
});

test("moves a scalar row cursor into stable per-row equality selectors", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Results({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      const choose = (id: string) => setSelectedId(id);
      const accept = () => selectedId && save(selectedId);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions onAccept={accept} />
        <Status /><Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
        {rows.map(row => <Row key={row.id} selected={selectedId === row.id} onPress={() => choose(row.id)} />)}
      </Screen>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /scalar row-selection/u);
});

test("recognizes an index cursor and a one-hop row presentation alias", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Results({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedIndex, setSelectedIndex] = useState(-1);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status />
        <Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
        {rows.map((row, index) => {
          const active = selectedIndex === index;
          return <Row key={row.id} active={active} onPointerMove={() => setSelectedIndex(index)} />;
        })}
      </Screen>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
});

test("does not mistake a nullish row prop projection for a row mount gate", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Results({ rows, activeStyle }: { rows: Array<{ id: string }>; activeStyle: unknown }) {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status />
        <Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
        {rows.map(row => {
          const selected = selectedId === row.id;
          return <Row key={row.id} selected={selected}
            hoverStyle={selected ? activeStyle : undefined}
            onPointerMove={() => setSelectedId(row.id)} />;
        })}
      </Screen>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
});

test("allows a row-only event path when a separate reset co-writes companion state", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    export function Results({ rows }: { rows: Array<{ id: string }> }) {
      const [query, setQuery] = useState("");
      const [selectedIndex, setSelectedIndex] = useState(-1);
      const reset = () => { setQuery(""); setSelectedIndex(-1); };
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions onReset={reset} />
        <Status /><Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
        {rows.map((row, index) => <Row key={row.id} active={selectedIndex === index}
          onPointerMove={() => setSelectedIndex(index)} />)}
      </Screen>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "selectedIndex")).action,
    "use-observable",
  );
});

test("requires scalar selectors to depend on a stable repeated item key", () => {
  for (const rows of [
    `rows.map(row => <Row key={row.id} selected={selectedId === activeId} onPress={() => setSelectedId(row.id)} />)`,
    `rows.map((row, index) => <Row key={index} selected={selectedId === row.id} onPress={() => setSelectedId(row.id)} />)`,
    `rows.map(row => <Row selected={selectedId === row.id} onPress={() => setSelectedId(row.id)} />)`,
  ]) {
    const finding = analyzeSource(
      `
      import { useState } from "react";
      export function Results({ rows, activeId }: { rows: Array<{ id: string }>; activeId: string }) {
        const [selectedId, setSelectedId] = useState<string | null>(null);
        return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status />
          <Help /><Footer /><Sidebar /><Banner /><Search /><Preview />{${rows}}
        </Screen>;
      }
    `,
      "fixture.tsx",
    ).find((candidate) => candidate.name === "selectedId");
    assert.notEqual(requireValue(finding).action, "use-observable");
  }
});

test("does not put a scalar selector inside its own row mount gate", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Results({ rows }: { rows: Array<{ id: string }> }) {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status />
        <Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
        {rows.map(row => selectedId === row.id && <Row key={row.id} onPress={() => setSelectedId(row.id)} />)}
      </Screen>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("keeps scalar selection that has effects, broadcast row reads, or no independent write", () => {
  const sources = [
    `useEffect(() => report(selectedId), [selectedId]);
     return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
       {rows.map(row => <Row key={row.id} selected={selectedId === row.id} onPress={() => setSelectedId(row.id)} />)}</Screen>;`,
    `return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
       {rows.map(row => <Row key={row.id} selected={selectedId === row.id} anySelected={selectedId !== null} onPress={() => setSelectedId(row.id)} />)}</Screen>;`,
    `const open = (id: string) => { setDirty(true); setSelectedId(id); };
     return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
       {rows.map(row => <Row key={row.id} selected={selectedId === row.id} onPress={() => open(row.id)} />)}</Screen>;`,
    `return <Screen><Header /><Toolbar /><Summary /><Filters /><Actions /><Status /><Help /><Footer /><Sidebar /><Banner /><Search /><Preview />
       {rows.map(row => <Row key={row.id} selected={selectedId === row.id}
         onPress={() => setSelectedId(previous => { audit(previous); return row.id; })} />)}</Screen>;`,
  ];
  for (const body of sources) {
    const finding = analyzeSource(
      `
      import { useEffect, useState } from "react";
      export function Results({ rows }: { rows: Array<{ id: string }> }) {
        const [dirty, setDirty] = useState(false);
        const [selectedId, setSelectedId] = useState<string | null>(null);
        ${body}
      }
    `,
      "fixture.tsx",
    ).find((candidate) => candidate.name === "selectedId");
    assert.notEqual(requireValue(finding).action, "use-observable");
  }
});
