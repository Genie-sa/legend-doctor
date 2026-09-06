import { actions, requireValue } from "./harness.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

test("replaces legacy Legend React selectors with useValue", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useSelector as select, use$ } from "@legendapp/state/react";
    const profile$ = observable({ email: "", first: "", last: "", name: "" });
    export function Profile() {
      const name = select(profile$.name);
      const email = use$(() => profile$.email.get());
      const fullName = use$(() => profile$.first.get() + profile$.last.get());
      return <span>{name}{email}{fullName}</span>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["replace-legacy-use-value", "replace-legacy-use-value", "replace-legacy-use-value"],
  );
  assert.ok(findings.every((finding) => finding.confidence === "certain"));
  assert.match(requireValue(findings[0]).message ?? "", /useValue\(profile\$\.name\)/u);
  assert.match(requireValue(findings[1]).message ?? "", /useValue\(profile\$\.email\)/u);
  assert.match(
    requireValue(findings[1]).message ?? "",
    /pass the proven observable path directly/u,
  );
  assert.match(
    requireValue(findings[2]).message ?? "",
    /useValue\(\(\) => profile\$\.first\.get\(\) \+ profile\$\.last\.get\(\)\)/u,
  );
  assert.match(requireValue(findings[2]).message ?? "", /preserve the selector arguments/u);
});

test("keeps legacy callbacks when a direct observable path is not proven", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { use$ } from "@legendapp/state/react";
    const records$ = observable({ first: { name: "" } });
    declare const source: { get(): string };
    export function Screen({ id }: { id: "first" }) {
      use$(() => records$[id].get());
      use$(() => records$.first.get(true));
      use$(() => source.get());
      return null;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(findings.length, 3);
  for (const finding of findings) {
    assert.equal(finding.action, "replace-legacy-use-value");
    assert.match(finding.message, /preserve the selector arguments/u);
    assert.doesNotMatch(finding.message, /pass the proven observable path directly/u);
  }
});

test("replaces namespace legacy selectors without matching unrelated functions", () => {
  assert.deepEqual(
    actions(`
      import * as LegendReact from "@legendapp/state/react";
      export function Profile({ profile$ }) {
        return LegendReact.useSelector(profile$.name) + LegendReact.use$(() => profile$.email.get());
      }
    `),
    ["replace-legacy-use-value", "replace-legacy-use-value"],
  );
  for (const source of [
    `function useSelector(value: unknown) { return value; } useSelector(source);`,
    `import { useSelector } from "other-state"; useSelector(source);`,
    `import { useSelector } from "@legendapp/state/react";
     function Screen(useSelector) { return useSelector(source); }`,
    `import * as LegendReact from "@legendapp/state/react";
     function Screen(LegendReact) { return LegendReact.useSelector(source); }`,
  ]) {
    assert.deepEqual(actions(source), [], source);
  }
});

test("keeps replace-legacy-use-value as a change when no installed package is resolved", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
    import { useSelector } from "@legendapp/state/react";
    export function read(value: string) { return useSelector(() => value); }
  `,
    fileName: "fixture.ts",
  });
  assert.equal(requireValue(finding).action, "replace-legacy-use-value");
  assert.equal(requireValue(finding).disposition, "change");
});

test("marks replace-legacy-use-value as style when the installed useValue is an alias", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
      import { use$ } from "@legendapp/state/react";
      export function read(value: string) { return use$(() => value); }
    `,
    fileName: "fixture.ts",
    importedObservables: new Set(),
    importedObservableFactories: new Set(),
    installedLegendState: {
      syncExport: "available",
      useValueExport: "alias",
      version: "3.0.0-beta.48",
    },
  });
  assert.equal(requireValue(finding).disposition, "style");
  assert.match(requireValue(finding).evidence.join("\n") ?? "", /no runtime effect/u);
});

test("suppresses replace-legacy-use-value when the installed package lacks useValue", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
      import { useSelector } from "@legendapp/state/react";
      export function read(value: string) { return useSelector(() => value); }
    `,
    fileName: "fixture.ts",
    importedObservables: new Set(),
    importedObservableFactories: new Set(),
    installedLegendState: { syncExport: "missing", useValueExport: "missing", version: "2.1.0" },
  });
  assert.deepEqual(findings, []);
});
