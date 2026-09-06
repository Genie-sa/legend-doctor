import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const STORE = `
  import { observable } from "@legendapp/state";
  import { useSelector, useValue } from "@legendapp/state/react";
  const state$ = observable({ a: 1, b: 2, name: "", items: [] as string[] });
`;

function splits(body: string): LegendPracticeFinding[] {
  return analyzeLegendPractices({
    sourceText: `${STORE}\n${body}`,
    fileName: "fixture.tsx",
  }).filter((finding) => finding.action === "split-use-value-result");
}

test("splits a destructured object selector into one useValue per read", () => {
  const [finding] = splits(`
    export function Pair({ total }: { total: number }) {
      const { a, b, total: sum } = useValue(() => ({ a: state$.a.get(), b: state$.b.get(), total, unused: 1 }));
      return <div>{a + b + sum}</div>;
    }
  `);
  assert.equal(requireValue(finding).confidence, "certain");
  assert.equal(requireValue(finding).disposition, "change");
  assert.equal(requireValue(finding).location.line, 8);
  assert.match(
    requireValue(finding).message,
    /^Replace `const \{ a, b, total: sum \} = useValue\(\(\) => \(\{ .* \}\)\)` with `const a = useValue\(state\$\.a\); const b = useValue\(state\$\.b\); const sum = total`; the selector returns a new object on every tracked change/u,
  );
  assert.match(
    requireValue(finding).evidence.join("\n"),
    /2 destructured members .* are a direct observable read/u,
  );
});

test("splits a destructured array selector and keeps the legacy hook name for the rename rule", () => {
  const findings = analyzeLegendPractices({
    sourceText: `${STORE}
      export function Tuple() {
        const [name, , count] = useSelector(() => [state$.name.get(), 0, state$.items.get()]);
        return <div>{name}{count.length}</div>;
      }
    `,
    fileName: "fixture.tsx",
  });
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["replace-legacy-use-value", "split-use-value-result"],
  );
  assert.match(
    requireValue(findings[1]).message,
    /with `const name = useSelector\(state\$\.name\); const count = useSelector\(state\$\.items\)`; the selector returns a new array/u,
  );
});

test("abstains when the result is used whole, computed, spread, defaulted, or built from calls", () => {
  for (const body of [
    "const pair = useValue(() => ({ a: state$.a.get(), b: state$.b.get() }));",
    "const { a } = useValue(() => { return { a: state$.a.get() }; });",
    "const { a, ...rest } = useValue(() => ({ a: state$.a.get(), b: 2 }));",
    "const { a = 0 } = useValue(() => ({ a: state$.a.get() }));",
    "const { a } = useValue(() => ({ ...state$.get(), a: state$.a.get() }));",
    "const { a } = useValue(() => ({ a: state$.a.get(), get b() { return 1; } }));",
    "const { total } = useValue(() => ({ total: state$.a.get() + state$.b.get() }));",
    "const { names } = useValue(() => ({ names: state$.items.get().map(String) }));",
    "const { a } = useValue(() => ({ a: state$.a }));",
    "const { a, b } = useValue(() => ({ a: 1, b: 2 }));",
    "const { missing } = useValue(() => ({ a: state$.a.get() }));",
    "const [a, b] = useValue(() => [state$.a.get()]);",
  ]) {
    assert.deepEqual(splits(`export function Case() { ${body} return null; }`), [], body);
  }
});
