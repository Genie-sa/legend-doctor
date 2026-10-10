import type { HookFinding } from "../../src/core/types.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />";

function states(source: string): HookFinding[] {
  return analyzeSource(source, "fixture.tsx").filter((finding) => finding.hook === "useState");
}

function dashboard(body: string, extra = ""): string {
  return `
    import { useEffect, useState } from "react";
    export function Dashboard({ total }: { total: number }) {
      const [count, setCount] = useState(0);
      const [label, setLabel] = useState("");
      ${extra}
      return (
        <section>
          ${CHROME}
          <p>{count} of {total}</p>
          <em>{label}</em>
          ${body}
          <button onClick={() => setLabel("")}>Clear</button>
        </section>
      );
    }
  `;
}

test("migrates a closed co-written group whose every member earns an observable verdict alone", () => {
  const [count, label] = states(
    dashboard(`<button onClick={() => { setCount(count + 1); setLabel("added"); }}>Add</button>`),
  );
  assert.equal(count?.action, "use-observable");
  assert.equal(label?.action, "use-observable");
  assert.deepEqual(count?.group?.members, ["count", "label"]);
  assert.equal(count?.group?.primary, true);
  assert.equal(label?.group?.primary, false);
  assert.match(count?.message ?? "", /co-written React states \(`count`, `label`\)/u);
  assert.match(count?.message ?? "", /one atomic `assign`/u);
  assert.match(
    count?.message ?? "",
    /For `count`: Replace `count` with a component-lifetime observable/u,
  );
  assert.match(label?.message ?? "", /For `label`: /u);
});

test("keeps the atomic-transition abstention when a member cannot migrate alone", () => {
  const effectWritten = dashboard(
    `<button onClick={() => { setCount(count + 1); setLabel("added"); setPending(true); }}>Add</button>`,
    `const [pending, setPending] = useState(false);
     useEffect(() => { setPending(false); }, [total]);
     const tone = pending ? "busy" : "idle";`,
  );
  const broadRead = dashboard(
    `<button onClick={() => { setCount(count + 1); setLabel("added"); }}>Add</button>`,
    `if (label === "hidden") return null;`,
  );
  for (const [name, fixture] of Object.entries({ broadRead, effectWritten })) {
    const findings = states(fixture);
    for (const finding of findings) {
      assert.notEqual(finding.action, "use-observable", `${name} ${finding.name}`);
      assert.equal(finding.group, undefined, `${name} ${finding.name}`);
    }
    assert.equal(findings[0]?.action, "review-state", name);
    assert.equal(findings[0]?.abstentionReason, "atomic-transition-unproven", name);
  }
});

test("treats a conditional companion write as the same closed group", () => {
  const [count, label] = states(
    dashboard(
      `<button onClick={() => { setCount(count + 1); if (total > 1) setLabel("added"); }}>Add</button>`,
    ),
  );
  assert.equal(count?.action, "use-observable");
  assert.equal(label?.action, "use-observable");
  assert.equal(count?.group?.id, label?.group?.id);
});

interface GatedDashboard {
  readonly body?: string;
  readonly extra?: string;
  readonly wrap?: (handler: string) => string;
}

/** Early returns make the flow leave the `count` and `label` co-writes unresolved. */
function gatedDashboard({
  body = "",
  extra = "",
  wrap = (handler) => handler,
}: GatedDashboard = {}): string {
  const handler = `{
    if (!enabled) {
      if (total > 1) { setCount(1); return; }
      setLabel("blocked");
      return;
    }
    setCount(2);
  }`;
  return `
    import { startTransition, useEffect, useState } from "react";
    export function Dashboard({ enabled, total }: { enabled: boolean; total: number }) {
      const [count, setCount] = useState(0);
      const [label, setLabel] = useState("");
      const toggle = () => ${wrap(handler)};
      ${extra}
      return (
        <section>
          ${CHROME}
          <p>{count} of {total}</p>
          <em>{label}</em>
          <button onClick={toggle}>Toggle</button>
          ${body}
          <button onClick={() => setLabel("")}>Clear</button>
        </section>
      );
    }
  `;
}

test("migrates a primitive group whose co-writes the flow cannot resolve", () => {
  const [count, label] = states(gatedDashboard());
  assert.equal(count?.action, "use-observable");
  assert.equal(label?.action, "use-observable");
  assert.equal(count?.group?.id, label?.group?.id);
  assert.match(
    count?.message ?? "",
    /`const dashboardState\$ = useObservable\(\{ count: 0, label: "" \}\)`; replace each setter call with `dashboardState\$\.<member>\.set\(\.\.\.\)` in place; and read each member only inside its leaf, as `useValue\(dashboardState\$\.count\)`/u,
  );
});

test("keeps an unresolved group under review when a member admits objects", () => {
  const findings = states(
    gatedDashboard({
      body: `<button onClick={pick}>Pick</button><b>{item?.id}</b>`,
      extra: `const [item, setItem] = useState<{ id: string } | null>(null);
        const pick = () => { if (!enabled) { if (total > 1) { setItem({ id: "a" }); return; } setLabel("picked"); } };`,
    }),
  );
  for (const name of ["label", "item"]) {
    const finding = findings.find((candidate) => candidate.name === name);
    assert.equal(finding?.action, "review-state", name);
    assert.equal(finding?.abstentionReason, "atomic-transition-unproven", name);
    assert.equal(finding?.group, undefined, name);
  }
});

test("keeps an unresolved group under review when a member is read by an effect", () => {
  const findings = states(
    gatedDashboard({ extra: "useEffect(() => { console.log(label); }, [label]);" }),
  );
  for (const finding of findings) {
    assert.equal(finding.action, "review-state", finding.name ?? "");
    assert.equal(finding.abstentionReason, "atomic-transition-unproven", finding.name ?? "");
  }
  assert.ok(findings[0]?.assumption?.members?.some((member) => member.outcome === "review-state"));
});

test("keeps an unresolved group in React when a member's reads cover the whole owner", () => {
  for (const finding of states(gatedDashboard({ extra: `if (label === "hidden") return null;` }))) {
    assert.notEqual(finding.action, "use-observable", finding.name ?? "");
    assert.equal(finding.group, undefined, finding.name ?? "");
  }
});

test("keeps an unresolved group in React inside a transition", () => {
  const fixture = gatedDashboard({ wrap: (handler) => `startTransition(() => ${handler})` });
  for (const finding of states(fixture)) {
    assert.notEqual(finding.action, "use-observable", finding.name ?? "");
  }
});

test("lets an await keep its commit split between converted members", () => {
  const [count, label] = states(
    dashboard(
      `<button onClick={async () => { setCount(1); if (total > 1) await save(); setLabel("saved"); }}>Save</button>`,
      "const save = async (): Promise<void> => {};",
    ),
  );
  assert.equal(count?.action, "use-observable");
  assert.equal(label?.action, "use-observable");
  assert.equal(count?.group?.id, label?.group?.id);
});

test("spells out the atomic assign for adjacent literal co-writes of a dialog", () => {
  const [open, view] = states(`
    import { useState } from "react";
    export function Settings() {
      const [open, setOpen] = useState(false);
      const [view, setView] = useState<"main" | "edit">("main");
      return (
        <section>
          ${CHROME}
          <p>{open ? "open" : "closed"}</p>
          <em>{view}</em>
          <button onClick={() => { setOpen(true); setView("edit"); }}>Edit</button>
          <button onClick={() => { setOpen(false); setView("main"); }}>Close</button>
          <button onClick={() => setView("main")}>Back</button>
        </section>
      );
    }
  `);
  assert.equal(open?.action, "use-observable");
  assert.equal(view?.action, "use-observable");
  assert.match(
    open?.message ?? "",
    /`settingsState\$\.assign\(\{ open: true, view: "edit" \}\)` at line 11, `settingsState\$\.assign\(\{ open: false, view: "main" \}\)` at line 12; replace every other setter call with `settingsState\$\.<member>\.set\(\.\.\.\)` in place/u,
  );
});
