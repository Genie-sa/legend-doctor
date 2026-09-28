import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("tracks observable paths created by proven project factories and aliases", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { useValue } from "@legendapp/state/react";
    import { makeStore } from "./create-store";
    const store$ = makeStore({ profile: { name: "Ada", email: "ada@example.com" } });
    const profile$ = store$.profile;
    function Name(value$: typeof profile$) {
      const profile = useValue(value$);
      return <span>{profile.name}</span>;
    }
  `,
    fileName: "fixture.tsx",
    importedObservables: new Set(),
    importedObservableFactories: new Set(["makeStore"]),
  });
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["narrow-use-value-subscription"],
  );
  assert.match(requireValue(findings[0]).message ?? "", /useValue\(value\$\.name\)/u);
});

test("tracks typed aliases of source-proven observable member paths", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { useValue } from "@legendapp/state/react";
    import { dialog } from "./state";
    function Name(value$: typeof dialog.value$.profile) {
      const profile = useValue(value$);
      return <span>{profile.name}</span>;
    }
  `,
    fileName: "fixture.tsx",
    importedObservables: new Set(["dialog.value$"]),
  });
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["narrow-use-value-subscription"],
  );
  assert.match(requireValue(findings[0]).message ?? "", /useValue\(value\$\.name\)/u);
});

test("does not infer mutable, nullable, reserved, or unproven observable aliases", () => {
  const source = (declarations: string, expression: string): LegendPracticeFinding[] =>
    analyzeLegendPractices({
      sourceText: `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const store$ = observable({ profile: { name: "Ada" } });
    ${declarations}
    export function Name() {
      const profile = useValue(${expression});
      return <span>{profile.name}</span>;
    }
  `,
      fileName: "fixture.tsx",
    });
  for (const [declarations, expression] of [
    ["let profile$ = store$.profile;", "profile$"],
    ["const getter$ = store$.get.bind;", "getter$"],
    ["const profile$: typeof store$.profile | null = store$.profile;", "profile$"],
    ["const profile$ = makeStore({ name: 'Ada' });", "profile$"],
  ] as const) {
    assert.deepEqual(source(declarations, expression), [], declarations);
  }
});

test("does not propagate observable provenance through shadowed roots or factories", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
      import { useValue } from "@legendapp/state/react";
      import { createStore, shared$ } from "./store";

      const fromFactory$ = createStore();
      const fromShared$ = shared$.profile;

      export function Screen() {
        const createStore = () => ({ profile: { name: "local" } });
        const shared$ = { profile: { name: "local" } };
        const factoryValue = useValue(fromFactory$);
        const sharedValue = useValue(fromShared$);
        return <>{factoryValue.profile.name}{sharedValue.name}{createStore}{shared$}</>;
      }
    `,
    fileName: "Screen.tsx",
    importedObservables: new Set(["shared$"]),
    importedObservableFactories: new Set(["createStore"]),
  });

  assert.equal(
    findings.some((finding) => finding.action === "narrow-use-value-subscription"),
    false,
  );
});

const PROFILE = "{ name: string; email: string }";

function typedProfileActions(declaration: string): string[] {
  return analyzeLegendPractices({
    sourceText: `
    import type { Observable, ObservableParam } from "@legendapp/state";
    import { observable } from "@legendapp/state";
    import { useObservable, useValue } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada", email: "ada@example.com" });
    ${declaration}
  `,
    fileName: "fixture.tsx",
  }).map((finding) => finding.action);
}

test("does not prove observables through maybe-observable, nullable, or optional annotations", () => {
  for (const declaration of [
    `export function Name(value$: Observable<${PROFILE}> | ${PROFILE}) {
      const profile = useValue(value$);
      return <span>{profile.name}</span>;
    }`,
    `export function Name(value$: Observable<${PROFILE}> | undefined) {
      const profile = useValue(value$);
      return <span>{profile?.name}</span>;
    }`,
    `export function Name(value$: (null | ObservableParam<${PROFILE}>)) {
      const profile = useValue(value$);
      return <span>{profile?.name}</span>;
    }`,
    `export function Name(value$?: Observable<${PROFILE}>) {
      const profile = useValue(value$);
      return <span>{profile?.name}</span>;
    }`,
    `export function Name(value$?: typeof profile$) {
      const profile = useValue(value$);
      return <span>{profile?.name}</span>;
    }`,
    `declare function pick(): Observable<${PROFILE}> | ${PROFILE};
    const picked$ = pick();
    export function Name() {
      const profile = useValue(picked$);
      return <span>{profile.name}</span>;
    }`,
    `export function Name(name$: Observable<string> | string) {
      const local$ = useObservable(name$);
      return <span>{useValue(local$)}</span>;
    }`,
    `export function Name(name$?: Observable<string>) {
      const local$ = useObservable(name$);
      return <span>{useValue(local$)}</span>;
    }`,
    `export function Name({ value$ }: { value$: Observable<${PROFILE}> | ${PROFILE} }) {
      const profile = useValue(value$);
      return <span>{profile.name}</span>;
    }`,
  ]) {
    assert.deepEqual(typedProfileActions(declaration), [], declaration);
  }
});

test("proves unions whose every member is an observable type", () => {
  for (const declaration of [
    `export function Name(value$: Observable<${PROFILE}> | ObservableParam<${PROFILE}>) {
      const profile = useValue(value$);
      return <span>{profile.name}</span>;
    }`,
    `type Props = { value$: Observable<${PROFILE}> | ObservableParam<${PROFILE}> };
    export function Name({ value$ }: Props) {
      const profile = useValue(value$);
      return <span>{profile.name}</span>;
    }`,
  ]) {
    assert.deepEqual(
      typedProfileActions(declaration),
      ["narrow-use-value-subscription"],
      declaration,
    );
  }
});
