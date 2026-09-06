import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("treats syncState and useComputed results as observable bindings", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable, syncState } from "@legendapp/state";
    import { useComputed, useValue } from "@legendapp/state/react";
    const todos$ = observable<string[]>([]);
    const status$ = syncState(todos$);
    export function Status() {
      const total$ = useComputed(() => todos$.get().length);
      const loaded = useValue(() => status$.isLoaded.get());
      const total = useValue(() => total$.get());
      return <span>{loaded ? total : "…"}</span>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["pass-observable-to-use-value", "pass-observable-to-use-value"],
  );
  assert.match(requireValue(findings[0]).message ?? "", /useValue\(status\$\.isLoaded\)/u);
  assert.match(requireValue(findings[1]).message ?? "", /useValue\(total\$\)/u);
});

test("treats useLocalObservable as useObservable and the Observable* aliases as observable types", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import type { ObservableObject } from "@legendapp/state";
    import { useLocalObservable, useValue } from "@legendapp/state/react";
    function Name(profile$: ObservableObject<{ name: string; email: string }>) {
      const profile = useValue(profile$);
      return <span>{profile.name}</span>;
    }
    export function Screen() {
      const draft$ = useLocalObservable({ name: "", email: "" });
      const draft = useValue(() => draft$.name.get());
      return <>{draft}{Name(draft$)}</>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["narrow-use-value-subscription", "pass-observable-to-use-value"],
  );
});

test("reads exact object keys through a synced initial value", () => {
  const source = (reads: string): string[] =>
    analyzeLegendPractices({
      sourceText: `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      import * as Sync from "@legendapp/state/sync";
      const settings$ = observable(Sync.synced({ initial: { theme: "dark", locale: "en" } }));
      export function Settings() {
        const settings = useValue(settings$);
        return <span>${reads}</span>;
      }
    `,
      fileName: "fixture.tsx",
    }).map((finding) => finding.action);
  assert.deepEqual(source("{settings.theme}"), ["narrow-use-value-subscription"]);
  assert.deepEqual(source("{settings.theme}{settings.locale}"), []);
});
