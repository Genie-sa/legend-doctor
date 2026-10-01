import { assertVerifiedEdits, practiceFindings } from "./edit-assertions.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

test("names useValue beside an imported legacy hook and leaves the edit to the legacy migration", () => {
  const source = `import { observable } from "@legendapp/state";
import { use$ as useLegend } from "@legendapp/state/react";

const counter$ = observable({ count: 0, label: "" });

export function Counter() {
  const label = useLegend(counter$.label);
  const count = counter$.count.get();
  return <p>{label}{count}</p>;
}
`;
  const finding = analyzeLegendPractices({ fileName: "fixture.tsx", sourceText: source }).find(
    (candidate) => candidate.action === "use-value-for-render-read",
  );
  assert.match(finding?.message ?? "", /with `useValue\(counter\$\.count\)`/u);
  assert.equal(finding?.edits, undefined);
});

test("keeps the legacy callee when narrowing, and composes with the legacy migration", () => {
  const source = `import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";

const profile$ = observable({ email: "", name: "" });

export function changeEmail(email: string) {
  profile$.email.set(email);
}

export function Name() {
  const { name } = use$(profile$);
  return <p>{name}</p>;
}
`;
  const narrowed = practiceFindings(source, "narrow-use-value-subscription");
  assert.match(narrowed[0]?.message ?? "", /`const name = use\$\(profile\$\.name\)`/u);
  assertVerifiedEdits(
    source,
    source.replace("{ name } = use$(profile$)", "name = use$(profile$.name)"),
    narrowed,
  );
  assertVerifiedEdits(
    source,
    source
      .replace("{ use$ }", "{ useValue }")
      .replace("{ name } = use$(profile$)", "name = useValue(profile$.name)"),
    analyzeLegendPractices({ fileName: "fixture.tsx", sourceText: source }),
  );
});

test("passes an eager read straight to a legacy hook, beside the legacy migration", () => {
  const source = `import { observable } from "@legendapp/state";
import { useSelector } from "@legendapp/state/react";

const profile$ = observable({ email: "", name: "" });

export function Profile() {
  const name = useSelector(profile$.name.get());
  return <p>{name}</p>;
}
`;
  const findings = analyzeLegendPractices({ fileName: "fixture.tsx", sourceText: source });
  assert.deepEqual(
    findings.map((finding) => [finding.action, finding.disposition]),
    [
      ["replace-legacy-use-value", "style"],
      ["pass-observable-to-use-value", "change"],
    ],
  );
  assert.match(findings[1]?.message ?? "", /with `useSelector\(profile\$\.name\)`/u);
  assertVerifiedEdits(
    source,
    source
      .replace("{ useSelector }", "{ useValue }")
      .replace("useSelector(profile$.name.get())", "useValue(profile$.name)"),
    findings,
  );
});

test("leaves a legacy direct selector to the legacy migration", () => {
  const source = `import { observable } from "@legendapp/state";
import * as Legend from "@legendapp/state/react";

const profile$ = observable({ email: "", name: "" });

export function Profile() {
  const name = Legend.useSelector(() => profile$.name.get());
  return <p>{name}</p>;
}
`;
  assert.deepEqual(
    analyzeLegendPractices({ fileName: "fixture.tsx", sourceText: source }).map(
      (finding) => finding.action,
    ),
    ["replace-legacy-use-value"],
  );
});
