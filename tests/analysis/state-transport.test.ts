import { actions, requireValue } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

test("places pure JSX prop projections in a call-site subscriber wrapper", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const [selected, setSelected] = useState<{ id: string } | null>(null);
      const open = (item: { id: string }) => setSelected(item);
      ${"\n".repeat(100)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        <ItemDialog open={selected != null} itemId={selected?.id ?? null} onClose={() => setSelected(null)} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /leave the child API unchanged/u);
});

test("keeps raw state transport and its projection in one stable call-site wrapper", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const [target, setTarget] = useState<string | null>(null);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        <button onClick={() => setTarget("details")} />
        <DetailDialog id={target} open={!!target} onOpenChange={open => !open && setTarget(null)} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /leave the child API unchanged/u);
});

test("keeps mixed transport ownership above a state-controlled call-site gate", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const [target, setTarget] = useState<string | null>(null);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        <button onClick={() => setTarget("details")} />
        {target && <DetailDialog id={target} open onOpenChange={open => !open && setTarget(null)} />}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /full state-controlled render expression/u);
});

test("does not transport a whole mixed state value into every repeated row subscriber", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string }> }) {
      const [selected, setSelected] = useState<{ id: string } | null>(null);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        {rows.map(row => <Row key={row.id} selected={selected} active={selected?.id === row.id} onPress={() => setSelected(row)} />)}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
});

test("moves transport-only state into one child", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function SearchInput() { return null; }
      export function SearchPage() {
        const [query, setQuery] = useState("");
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <SearchInput value={query} onChange={setQuery} />
        </main>;
      }
    `),
    ["move-state-down"],
  );
});

test("moves controlled state when an inline setter callback belongs to the same leaf", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen() {
        const [active, setActive] = useState("profile");
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <Tabs value={active} onValueChange={value => setActive(String(value))} />
        </main>;
      }
    `),
    ["move-state-down"],
  );
});

test("moves branch-local state down when every outside reset provably unmounts the branch", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    type Phase = { kind: "idle" } | { kind: "loading" } | { kind: "done" };
    function Result(_props: unknown) { return null; }
    export function Screen() {
      const [phase, setPhase] = useState<Phase>({ kind: "idle" });
      const [showDetails, setShowDetails] = useState(false);
      const begin = () => {
        setShowDetails(false);
        setPhase({ kind: "loading" });
      };
      return <main>
        <button onClick={begin}>Begin</button>
        {phase.kind === "done" ? (
          <Result
            showDetails={showDetails}
            onToggleDetails={() => setShowDetails(value => !value)}
            onAgain={() => setPhase({ kind: "idle" })}
          />
        ) : null}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const finding = findings.find((candidate) => candidate.name === "showDetails");
  assert.equal(requireValue(finding).action, "move-state-down");
  assert.match(requireValue(finding).message ?? "", /resets it only when that branch unmounts/u);
});

test("does not move branch-local state when an outside reset can leave the branch mounted", () => {
  for (const reset of [
    `setShowDetails(false);`,
    `setShowDetails(false); setPhase({ kind: "done" });`,
    `setShowDetails(false); setPhase({ kind: "loading" }); setPhase({ kind: "done" });`,
    `setShowDetails(false); setPhase({ kind: "loading", kind });`,
    `setShowDetails(false); setPhase({ kind: "loading", ...nextPhase });`,
    `setShowDetails(false); setPhase(nextPhase);`,
    `if (shouldClose) { setShowDetails(false); } setPhase({ kind: "loading" });`,
  ]) {
    const findings = analyzeSource(
      `
      import { useState } from "react";
      type Phase = { kind: "idle" } | { kind: "loading" } | { kind: "done" };
      function Result(_props: unknown) { return null; }
      export function Screen({ shouldClose }: { shouldClose: boolean }) {
        const [phase, setPhase] = useState<Phase>({ kind: "idle" });
        const [showDetails, setShowDetails] = useState(false);
        const begin = () => { ${reset} };
        return <main>
          <button onClick={begin}>Begin</button>
          {phase.kind === "done" ? (
            <Result showDetails={showDetails} onToggleDetails={() => setShowDetails(value => !value)} />
          ) : null}
        </main>;
      }
    `,
      "fixture.tsx",
    );
    const finding = findings.find((candidate) => candidate.name === "showDetails");
    assert.notEqual(requireValue(finding).action, "move-state-down", reset);
  }
});

test("does not move an inline controlled callback that co-writes owner state", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen() {
        const [active, setActive] = useState("profile");
        const [dirty, setDirty] = useState(false);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <Tabs value={active} onValueChange={value => { setActive(String(value)); setDirty(true); }} />
          <Save disabled={!dirty} />
        </main>;
      }
    `),
    ["review-state", "review-state"],
  );
});

test("keeps observable ownership above a receiving leaf with an outside setter command", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen() {
        const [active, setActive] = useState("profile");
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <button onClick={() => setActive("settings")} />
          <Tabs value={active} />
        </main>;
      }
    `),
    ["use-observable"],
  );
});

test("does not move controlled state through an opaque JSX callback", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen() {
        const [active, setActive] = useState("profile");
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <Panel render={() => <Tabs value={active} onValueChange={setActive} />} />
        </main>;
      }
    `),
    ["review-state"],
  );
});

test("does not move controlled state through a stored JSX value", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen({ show }: { show: boolean }) {
        const [active, setActive] = useState("profile");
        const tabs = <Tabs value={active} onValueChange={setActive} />;
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          {show ? tabs : null}
        </main>;
      }
    `),
    ["review-state"],
  );
});

test("does not move controlled state out of a custom hook that returns JSX", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function useTabs() {
        const [active, setActive] = useState("profile");
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <Tabs value={active} onValueChange={setActive} />
        </main>;
      }
    `),
    ["review-state"],
  );
});

test("does not move direct state into an opaque render callback", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen() {
        const [expanded, setExpanded] = useState(false);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <VirtualList renderItem={() => <section><b>{expanded ? "Yes" : "No"}</b><button onClick={() => setExpanded(value => !value)} /></section>} />
        </main>;
      }
    `),
    ["review-state"],
  );
});

test("reviews fanout to multiple leaves without assuming Legend is faster", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function SearchInput() { return null; }
      function Preview() { return null; }
      export function SearchPage() {
        const [query, setQuery] = useState("");
        return <><SearchInput value={query} onChange={setQuery} /><Preview query={query} /></>;
      }
    `),
    ["review-state"],
  );
});

test("suggests observable transport for a repeated leaf", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function Row() { return null; }
      export function Results({ rows }: { rows: string[] }) {
        const [selectedId, setSelectedId] = useState<string | null>(null);
        return rows.map(id => <Row key={id} id={id} selectedId={selectedId} onSelect={setSelectedId} />);
      }
    `),
    ["use-observable"],
  );
});
