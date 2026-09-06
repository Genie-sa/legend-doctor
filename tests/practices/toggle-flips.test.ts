import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("replaces exact observable boolean flips with toggle", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useObservable } from "@legendapp/state/react";
    const shell$ = observable({ palette: { open: false } });
    export function useControls() {
      const local$ = useObservable({ expanded: false });
      const togglePalette = () => shell$.palette.open.set(!shell$.palette.open.peek());
      const toggleExpanded = () => local$.expanded.set(value => !value);
      return { toggleExpanded, togglePalette };
    }
  `,
    fileName: "fixture.ts",
  });
  const toggles = findings.filter((finding) => finding.action === "toggle-observable");
  assert.equal(toggles.length, 2);
  assert.ok(toggles.every((finding) => finding.confidence === "certain"));
  assert.match(requireValue(toggles[0]).message ?? "", /shell\$\.palette\.open\.toggle\(\)/u);
  assert.match(requireValue(toggles[1]).message ?? "", /local\$\.expanded\.toggle\(\)/u);
});

test("replaces exact boolean updater on a typed observable", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import type { Observable } from "@legendapp/state";
    export function toggle(state$: Observable<{ enabled: boolean }>) {
      state$.enabled.set(current => !current);
    }
  `,
    fileName: "fixture.ts",
  });

  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["toggle-observable"],
  );
});

test("keeps observable writes when an exact untracked boolean flip is not proven", () => {
  const source = (statement: string): LegendPracticeFinding[] =>
    analyzeLegendPractices({
      sourceText: `
    import { observable } from "@legendapp/state";
    const state$ = observable({ enabled: false, other: false, rows: {} as Record<string, boolean> });
    declare const external$: { enabled: { peek(): boolean } };
    export function toggle(key: string) {
      ${statement}
    }
  `,
      fileName: "fixture.ts",
    }).filter((finding) => finding.action === "toggle-observable");

  for (const statement of [
    `state$.enabled.set(!state$.enabled.get());`,
    `state$.enabled.set(!state$.other.peek());`,
    `state$.enabled.set(!external$.enabled.peek());`,
    `state$.rows[key].set(!state$.rows[key].peek());`,
    `state$.enabled.set(current => !state$.other.peek());`,
    `state$.enabled.set(current => { return !current; });`,
    `state$.enabled.set(async current => !current);`,
    `state$.enabled.set(current => !!current);`,
    `state$.enabled.toggle();`,
  ]) {
    assert.deepEqual(source(statement), [], statement);
  }
});

test("does not infer toggle support through a shadowed observable root", () => {
  assert.deepEqual(
    analyzeLegendPractices({
      sourceText: `
      import { observable } from "@legendapp/state";
      const state$ = observable({ enabled: false });
      export function toggle() {
        const state$ = externalState();
        state$.enabled.set(value => !value);
      }
    `,
      fileName: "fixture.ts",
    }).filter((finding) => finding.action === "toggle-observable"),
    [],
  );
});
