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
      assert.equal(finding.action, "review-state", `${name} ${finding.name}`);
      assert.equal(finding.group, undefined, `${name} ${finding.name}`);
    }
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
