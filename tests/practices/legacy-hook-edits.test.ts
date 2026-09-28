import { assertVerifiedEdits, practiceFindings } from "./edit-assertions.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

const WITHOUT_USE_VALUE = {
  source: "lockfile",
  syncExport: "available",
  useValueExport: "missing",
  version: "3.0.0-beta.30",
} as const;

test("subscribes a render read with useSelector when the installed Legend State has no useValue", () => {
  const source = `import { observable } from "@legendapp/state";
import { useMount } from "@legendapp/state/react";

declare function track(): void;

const counter$ = observable({ count: 0 });

export function Counter() {
  useMount(track);
  const count = counter$.count.get();
  return <p>{count}</p>;
}
`;
  const findings = analyzeLegendPractices({
    fileName: "fixture.tsx",
    installedLegendState: {
      source: "installed",
      syncExport: "available",
      useValueExport: "missing",
      version: "3.0.0-alpha.1",
    },
    sourceText: source,
  });
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["use-value-for-render-read"],
  );
  assert.match(findings[0]?.message ?? "", /with `useSelector\(counter\$\.count\)`/u);
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { useMount, useSelector } from "@legendapp/state/react";

declare function track(): void;

const counter$ = observable({ count: 0 });

export function Counter() {
  useMount(track);
  const count = useSelector(counter$.count);
  return <p>{count}</p>;
}
`,
    findings,
  );
});

test("subscribes a render read with the legacy hook the file already imports", () => {
  const source = `import { observable } from "@legendapp/state";
import { use$ as useLegend } from "@legendapp/state/react";

const counter$ = observable({ count: 0, label: "" });

export function Counter() {
  const label = useLegend(counter$.label);
  const count = counter$.count.get();
  return <p>{label}{count}</p>;
}
`;
  const findings = analyzeLegendPractices({
    fileName: "fixture.tsx",
    installedLegendState: WITHOUT_USE_VALUE,
    sourceText: source,
  }).filter((finding) => finding.action === "use-value-for-render-read");
  assert.match(findings[0]?.message ?? "", /with `useLegend\(counter\$\.count\)`/u);
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { use$ as useLegend } from "@legendapp/state/react";

const counter$ = observable({ count: 0, label: "" });

export function Counter() {
  const label = useLegend(counter$.label);
  const count = useLegend(counter$.count);
  return <p>{label}{count}</p>;
}
`,
    findings,
  );
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
      ["replace-legacy-use-value", "change"],
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

test("collapses a legacy direct selector only when no legacy migration carries it", () => {
  const source = `import { observable } from "@legendapp/state";
import * as Legend from "@legendapp/state/react";

const profile$ = observable({ email: "", name: "" });

export function Profile() {
  const name = Legend.useSelector(() => profile$.name.get());
  return <p>{name}</p>;
}
`;
  const withoutUseValue = analyzeLegendPractices({
    fileName: "fixture.tsx",
    installedLegendState: WITHOUT_USE_VALUE,
    sourceText: source,
  });
  assert.deepEqual(
    withoutUseValue.map((finding) => [finding.action, finding.disposition]),
    [["pass-observable-to-use-value", "style"]],
  );
  assertVerifiedEdits(
    source,
    source.replace(
      "Legend.useSelector(() => profile$.name.get())",
      "Legend.useSelector(profile$.name)",
    ),
    withoutUseValue,
  );
  assert.deepEqual(
    analyzeLegendPractices({ fileName: "fixture.tsx", sourceText: source }).map(
      (finding) => finding.action,
    ),
    ["replace-legacy-use-value"],
  );
});
