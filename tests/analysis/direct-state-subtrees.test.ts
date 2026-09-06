import { agentFindings } from "../../src/report/format.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("flags direct render state in a non-trivial owner as Legend-first", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const [active, setActive] = useState(false);
      return <main><Header /><Toolbar /><Content /><Button onClick={() => setActive(v => !v)} />{active && <Panel />}</main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "review-state");
  assert.equal(requireValue(finding).disposition, "candidate");
  assert.match(requireValue(finding).message ?? "", /Legend-first restructuring candidate/u);
});

test("reports competing observable subscriptions as evidence for direct render state", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    import { useValue } from "@legendapp/state/react";
    import { player$ } from "./state";
    export function Screen() {
      const [active, setActive] = useState(false);
      const positionSec = useValue(player$.positionSec);
      return <main><Header /><Toolbar time={positionSec} /><Content /><Button onClick={() => setActive(v => !v)} />{active && <Panel />}</main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "review-state");
  assert.match(requireValue(finding).message ?? "", /Legend-first restructuring candidate/u);
  assert.match(
    requireValue(finding).message ?? "",
    /also re-renders through an existing observable subscription; isolate this state only if it updates less often/u,
  );
});

test("reports multiple legacy-hook subscriptions as competing evidence", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    import { use$ } from "@legendapp/state/react";
    import { player$ } from "./state";
    export function Screen() {
      const [note, setNote] = useState("");
      const positionSec = use$(player$.positionSec);
      const duration = use$(player$.durationSec);
      return <main><Header /><Toolbar time={positionSec} max={duration} /><Content /><Button onClick={() => setNote("x")} />{note}</main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "review-state");
  assert.match(requireValue(finding).message ?? "", /2 existing observable subscriptions/u);
});

test("moves direct state into its strict stable JSX subtree", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const [expanded, setExpanded] = useState(false);
      ${"\n".repeat(150)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section><p>{expanded ? "Long" : "Short"}</p><button onClick={() => setExpanded(v => !v)}>Toggle</button></section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "move-state-down");
  assert.match(requireValue(finding).message ?? "", /every read and command is confined/u);
});

test("keeps ownership stable and extracts a conditional subscription subtree", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen({ show }: { show: boolean }) {
      const [expanded, setExpanded] = useState(false);
      ${"\n".repeat(150)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        {show ? <section><p>{expanded ? "Long" : "Short"}</p><button onClick={() => setExpanded(v => !v)}>Toggle</button></section> : null}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /preserves conditional mount lifetime/u);
});

test("keeps observable ownership across early-return and keyed subtree lifetimes", () => {
  const [earlyReturn] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen({ loading }: { loading: boolean }) {
      const [expanded, setExpanded] = useState(false);
      ${"\n".repeat(100)}
      if (loading) return <Loading />;
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section><p>{expanded ? "Long" : "Short"}</p><button onClick={() => setExpanded(v => !v)}>Toggle</button></section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(earlyReturn).action, "use-observable");

  const [keyed] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen({ identity }: { identity: string }) {
      const [expanded, setExpanded] = useState(false);
      ${"\n".repeat(100)}
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <article key={identity}><section><p>{expanded ? "Long" : "Short"}</p><button onClick={() => setExpanded(v => !v)}>Toggle</button></section></article>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(keyed).action, "use-observable");
});

test("does not isolate direct state whose reads span the owner", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const [active, setActive] = useState(false);
      ${"\n".repeat(150)}
      return <main data-active={active}>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section><button onClick={() => setActive(v => !v)}>Toggle</button></section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "review-state");
});

test("groups multiple direct states confined to the same JSX subtree", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const [query, setQuery] = useState("");
      const [expanded, setExpanded] = useState(false);
      ${"\n".repeat(150)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section>
          <input value={query} onChange={event => setQuery(event.target.value)} />
          <p>{expanded ? query : query.slice(0, 2)}</p>
          <button onClick={() => setExpanded(value => !value)}>Toggle</button>
        </section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const grouped = findings.filter((finding) => finding.group);
  assert.deepEqual(
    grouped.map((finding) => finding.action),
    ["move-state-down", "move-state-down"],
  );
  assert.deepEqual(requireValue(requireValue(grouped[0]).group).members, ["query", "expanded"]);
  assert.equal(agentFindings(findings).filter((finding) => finding.group).length, 1);
});

test("keeps observable ownership when a subtree cluster mixes direct and projected state", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const [query, setQuery] = useState("");
      const [selected, setSelected] = useState<{ id: string } | null>(null);
      return <main>
        <Header onSelect={item => setSelected(item)} /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section>
          <input onChange={event => setQuery(event.target.value)} />
          <p>{query}</p>
          <Dialog open={selected != null} />
          <Preview itemId={selected?.id ?? null} />
        </section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const grouped = findings.filter((finding) => finding.group);
  assert.deepEqual(
    grouped.map((finding) => finding.action),
    ["use-observable", "use-observable"],
  );
  assert.deepEqual(requireValue(requireValue(grouped[0]).group).members, ["query", "selected"]);
});

test("does not let a direct state pull an escaped projection into its subtree cluster", () => {
  const findings = analyzeSource(
    `
    import { useCallback, useState } from "react";
    export function Screen() {
      const [query, setQuery] = useState("");
      const [selected, setSelected] = useState<{ id: string } | null>(null);
      useCommands({ onSelect: useCallback(item => setSelected(item), []) });
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section>
          <input onChange={event => setQuery(event.target.value)} />
          <p>{query}</p>
          <Dialog open={selected != null} />
          <Preview itemId={selected?.id ?? null} />
        </section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const selected = findings.find((finding) => finding.name === "selected");
  assert.equal(requireValue(selected).action, "review-state");
  assert.equal(requireValue(selected).group, undefined);
});

test("does not let a direct state pull a reactive-mutation projection into its subtree cluster", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const { mutateAsync: submitSelection } = useSubmitSelection();
      const [query, setQuery] = useState("");
      const [selected, setSelected] = useState<{ id: string } | null>(null);
      const select = async (item: { id: string }) => {
        setSelected(item);
        try { await submitSelection(item); } catch { setSelected(null); }
      };
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section>
          <input onChange={event => setQuery(event.target.value)} />
          <p>{query}</p>
          <button onClick={() => select({ id: "x" })}>Select</button>
          <Dialog open={selected != null} />
          <Preview itemId={selected?.id ?? null} />
        </section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const selected = findings.find((finding) => finding.name === "selected");
  assert.equal(requireValue(selected).action, "review-state");
  assert.equal(requireValue(selected).group, undefined);
});

test("moves state down with the owner-level handler that is only used inside the subtree", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen({ save }) {
      const [saving, setSaving] = useState(false);
      const handleSave = () => {
        setSaving(!saving);
        save();
      };
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section><SaveButton pending={saving} onPress={handleSave} /><p>{saving ? "Saving" : "Idle"}</p></section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "move-state-down");
  assert.match(requireValue(finding).message ?? "", /Move `handleSave` into that leaf as well/u);
});

test("keeps state up when the confined handler is also referenced outside the subtree", () => {
  const cases = [
    `useEffect(() => { window.addEventListener("keydown", handleSave); return () => window.removeEventListener("keydown", handleSave); }, [handleSave]);`,
    `const shortcuts = { save: handleSave };`,
  ];
  for (const outsideUse of cases) {
    const [finding] = analyzeSource(
      `
      import { useEffect, useState } from "react";
      export function Screen({ save }) {
        const [saving, setSaving] = useState(false);
        const handleSave = () => {
          setSaving(!saving);
          save();
        };
        ${outsideUse}
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
          <section><SaveButton pending={saving} onPress={handleSave} /><p>{saving ? "Saving" : "Idle"}</p></section>
        </main>;
      }
    `,
      "fixture.tsx",
    );
    assert.notEqual(requireValue(finding).action, "move-state-down", outsideUse);
  }
});

test("keeps state up when a derived constant reading it is used in a sibling subtree", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const [open, setOpen] = useState(false);
      const label = open ? "Close" : "Open";
      return <main>
        <Header title={label} /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section><button onClick={() => setOpen(true)}>{label}</button><p>{open ? "Shown" : "Hidden"}</p></section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "move-state-down");
});

test("moves state down through a chain of owner-level constants that end inside the subtree", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen({ save }) {
      const [saving, setSaving] = useState(false);
      const handleSave = () => {
        setSaving(!saving);
        save();
      };
      const actions = { onPress: handleSave, label: saving ? "Saving" : "Save" };
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section><SaveButton pending={saving} {...actions} /><p>{actions.label}</p></section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "move-state-down");
  assert.match(
    requireValue(finding).message ?? "",
    /Move `actions`, `handleSave` into that leaf as well/u,
  );
});

test("keeps observable ownership above the leaf when the owner has an alternate return", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen({ save, ready }) {
      const [saving, setSaving] = useState(false);
      const handleSave = () => {
        setSaving(!saving);
        save();
      };
      if (!ready) {
        return <Spinner />;
      }
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section><SaveButton pending={saving} onPress={handleSave} /><p>{saving ? "Saving" : "Idle"}</p></section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /preserves conditional mount lifetime/u);
  assert.match(requireValue(finding).message ?? "", /Move `handleSave` into that leaf as well/u);
});

test("rejects confinement when the state's JSX uses are split across two returns", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen({ save, ready }) {
      const [saving, setSaving] = useState(false);
      const handleSave = () => {
        setSaving(!saving);
        save();
      };
      if (!ready) {
        return <Spinner busy={saving} />;
      }
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section><SaveButton pending={saving} onPress={handleSave} /><p>{saving ? "Saving" : "Idle"}</p></section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.notEqual(requireValue(finding).action, "use-observable");
  assert.notEqual(requireValue(finding).action, "move-state-down");
});
