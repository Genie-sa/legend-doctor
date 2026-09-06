import type { HookFinding } from "../../src/core/types.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />";

function dashboard(effect: string, extra = ""): HookFinding[] {
  return analyzeSource(
    `
    import { useEffect, useMemo, useState } from "react";
    declare function load(): Promise<number>;
    export function Dashboard({ items }: { items: string[] }) {
      const [count, setCount] = useState(0);
      ${effect}
      ${extra}
      return (
        <section>
          ${CHROME}
          <p>{count} items</p>
          <footer>{count > 3 ? <strong>Many</strong> : null}</footer>
        </section>
      );
    }
  `,
    "fixture.tsx",
  );
}

test("migrates state an effect writes without reading or scheduling on it", () => {
  const findings = dashboard("useEffect(() => { setCount(items.length); }, [items]);");
  const count = findings.find((finding) => finding.name === "count");
  const effect = findings.find((finding) => finding.hook === "useEffect");
  assert.equal(count?.action, "use-observable");
  assert.match(count?.message ?? "", /2 bounded presentation leaves|2 render sites/u);
  assert.match(count?.message ?? "", /Keep the React effect that writes it/u);
  assert.equal(effect?.action, "keep-effect");
});

test("migrates state written after an awaited load with a cleanup guard", () => {
  const findings = dashboard(
    `useEffect(() => {
       let alive = true;
       load().then((next) => { if (alive) setCount(next); });
       return () => { alive = false; };
     }, []);`,
  );
  const count = findings.find((finding) => finding.name === "count");
  assert.equal(count?.action, "use-observable");
  assert.match(count?.message ?? "", /Keep the React effect that writes it/u);
});

test("keeps the effect-write abstention when an effect reads the state", () => {
  const findings = dashboard(
    "useEffect(() => { if (count !== items.length) setCount(items.length); }, [items, count]);",
  );
  const count = findings.find((finding) => finding.name === "count");
  assert.equal(count?.action, "review-state");
  assert.equal(count?.abstentionReason, "effect-write-ownership-unresolved");
});

test("abstains when another hook schedules on the state", () => {
  const findings = dashboard(
    "useEffect(() => { setCount(items.length); }, [items]);",
    'const label = useMemo(() => String(count) + " items", [count]);',
  );
  const count = findings.find((finding) => finding.name === "count");
  assert.equal(count?.action, "review-state");
});

test("abstains when the effect also writes a companion that stays in React", () => {
  const findings = dashboard(
    "useEffect(() => { setCount(items.length); setNote(items.join()); }, [items]);",
    `const [note, setNote] = useState("");
     if (note === "hidden") return null;`,
  );
  const count = findings.find((finding) => finding.name === "count");
  assert.equal(count?.action, "review-state");
  assert.equal(count?.abstentionReason, "atomic-transition-unproven");
});
