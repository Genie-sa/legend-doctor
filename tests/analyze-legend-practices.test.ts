import assert from "node:assert/strict";
import test from "node:test";

import { analyzeLegendPractices } from "../src/analyze-legend-practices.js";

function actions(source: string): string[] {
  return analyzeLegendPractices(source, "fixture.ts").map(finding => finding.action);
}

test("assigns consecutive direct fields of one local observable", () => {
  const [finding] = analyzeLegendPractices(`
    import { observable } from "@legendapp/state";
    const player$ = observable({ loading: false, error: null as string | null });
    export function fail(message: string) {
      player$.error.set(message);
      player$.loading.set(false);
    }
  `, "fixture.ts");
  assert.equal(finding?.action, "assign-observable-fields");
  assert.equal(finding?.location.line, 5);
  assert.match(finding?.message ?? "", /observers publish once/);
  assert.match(finding?.message ?? "", /player\$\.assign/);
  assert.match(finding?.message ?? "", /`error`, `loading`/);
});

test("recognizes typed observable parameters", () => {
  assert.deepEqual(
    actions(`
      import type { Observable } from "@legendapp/state";
      export function reset(state$: Observable<{ open: boolean; value: string }>) {
        state$.open.set(false);
        state$.value.set("");
      }
    `),
    ["assign-observable-fields"]
  );
});

test("recognizes useObservable bindings", () => {
  assert.deepEqual(
    actions(`
      import { useObservable } from "@legendapp/state/react";
      export function useSelection() {
        const selection$ = useObservable({ anchor: -1, focus: -1 });
        const clear = () => {
          selection$.anchor.set(-1);
          selection$.focus.set(-1);
        };
        return clear;
      }
    `),
    ["assign-observable-fields"]
  );
});

test("assigns direct fields under the same nested observable object", () => {
  const [finding] = analyzeLegendPractices(`
    import { observable } from "@legendapp/state";
    const player$ = observable({ status: { loading: false, error: "" } });
    player$.status.loading.set(false);
    player$.status.error.set("failed");
  `, "fixture.ts");
  assert.equal(finding?.action, "assign-observable-fields");
  assert.match(finding?.message ?? "", /player\$\.status\.assign/);
});

test("uses batch when a transaction spans observable roots", () => {
  assert.deepEqual(
    actions(`
      import { observable } from "@legendapp/state";
      const player$ = observable({ loading: false });
      const session$ = observable({ error: "" });
      player$.loading.set(false);
      session$.error.set("failed");
    `),
    ["batch-observable-writes"]
  );
});

test("uses batch when assign would change updater or read ordering", () => {
  for (const secondWrite of [
    `state$.second.set(value => value + 1);`,
    `state$.second.set(state$.first.get() + 1);`,
  ]) {
    assert.deepEqual(
      actions(`
        import { observable } from "@legendapp/state";
        const state$ = observable({ first: 0, second: 0 });
        state$.first.set(1);
        ${secondWrite}
      `),
      ["batch-observable-writes"]
    );
  }
});

test("passes a proven observable directly to useValue", () => {
  const [finding] = analyzeLegendPractices(`
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const theme$ = observable({ accent: "blue" });
    export function Theme() {
      const accent = useValue(() => theme$.accent.get());
      return <span>{accent}</span>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "pass-observable-to-use-value");
  assert.equal(finding?.confidence, "certain");
  assert.match(finding?.message ?? "", /useValue\(theme\$\.accent\)/);
});

test("uses cross-file observable provenance for direct useValue", () => {
  assert.deepEqual(
    analyzeLegendPractices(`
      import { useValue } from "@legendapp/state/react";
      import { settings$ } from "./store";
      export function Theme() {
        return <span>{useValue(() => settings$.theme.get())}</span>;
      }
    `, "fixture.tsx", new Set(["settings$"])).map(finding => finding.action),
    ["pass-observable-to-use-value"]
  );
});

test("keeps computed, shallow, dynamic, and unproven useValue selectors", () => {
  const source = (selector: string) => analyzeLegendPractices(`
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const state$ = observable({ selected: 1, rows: [{ name: "one" }] });
    const external = { get: () => 1 };
    export function Row({ index }: { index: number }) {
      const value = useValue(${selector});
      return <span>{String(value)}</span>;
    }
  `, "fixture.tsx");
  for (const selector of [
    `() => state$.selected.get() === 1`,
    `() => state$.rows.get(true)`,
    `() => state$.rows[index].get()`,
    `() => external.get()`,
  ]) {
    assert.deepEqual(source(selector), [], selector);
  }
  assert.deepEqual(
    analyzeLegendPractices(`
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const state$ = observable({ value: 1 });
      useValue(() => state$.value.get(), { suspense: true });
    `, "fixture.tsx"),
    []
  );
});

test("narrows a broad useValue binding to its only static child", () => {
  const [finding] = analyzeLegendPractices(`
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada", email: "ada@example.com" });
    export function Profile() {
      const profile = useValue(profile$);
      return <><h1>{profile.name}</h1><span>{profile.name.trim()}</span></>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "narrow-use-value-subscription");
  assert.equal(finding?.confidence, "certain");
  assert.match(finding?.message ?? "", /useValue\(profile\$\.name\)/);
  assert.match(finding?.evidence.join(" ") ?? "", /2 raw-value reads/);
});

test("narrows a child used by a boolean projection", () => {
  const [finding] = analyzeLegendPractices(`
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ enabled: false, name: "Ada" });
    export function Profile() {
      const profile = useValue(profile$);
      return <span>{!profile.enabled ? "off" : "on"}</span>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "narrow-use-value-subscription");
  assert.match(finding?.message ?? "", /useValue\(profile\$\.enabled\)/);
});

test("narrows a single-property useValue destructure", () => {
  const [finding] = analyzeLegendPractices(`
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const theme$ = observable({ colors: { dark: { text: "black" }, light: { text: "white" } } });
    export function Theme() {
      const { dark: palette } = useValue(theme$.colors);
      return <span>{palette.text}</span>;
    }
  `, "fixture.tsx");
  assert.equal(finding?.action, "narrow-use-value-subscription");
  assert.match(finding?.message ?? "", /useValue\(theme\$\.colors\.dark\)/);
});

test("keeps broad useValue reads when the child subscription is not proven equivalent", () => {
  const source = (body: string) => analyzeLegendPractices(`
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada", email: "ada@example.com", rows: [] as string[] });
    export function Profile({ keyName }: { keyName: "name" }) {
      const profile = useValue(profile$);
      ${body}
    }
  `, "fixture.tsx");
  for (const body of [
    `return <span>{profile.name} {profile.email}</span>;`,
    `return <span>{profile?.name}</span>;`,
    `return <span>{profile[keyName]}</span>;`,
    `return <Child profile={profile} />;`,
    `profile.name = "Grace"; return <span>{profile.name}</span>;`,
    `return <span>{profile.name()}</span>;`,
    `function nested(profile: { name: string }) { return profile.name; } return <span>{profile.name}</span>;`,
  ]) {
    assert.deepEqual(source(body), [], body);
  }
});

test("keeps array length as a selector concern rather than an observable child", () => {
  assert.deepEqual(
    analyzeLegendPractices(`
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const rows$ = observable(["one"]);
      export function Count() {
        const rows = useValue(rows$);
        return <span>{rows.length}</span>;
      }
    `, "fixture.tsx"),
    []
  );
});

test("keeps multi-property, defaulted, and rest useValue destructures", () => {
  const source = (binding: string) => analyzeLegendPractices(`
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada", email: "ada@example.com" });
    export function Profile() {
      const ${binding} = useValue(profile$);
      return null;
    }
  `, "fixture.tsx");
  for (const binding of [
    `{ name, email }`,
    `{ name = "Unknown" }`,
    `{ name, ...rest }`,
  ]) {
    assert.deepEqual(source(binding), [], binding);
  }
});

test("recognizes namespace observable and batch calls", () => {
  assert.deepEqual(
    actions(`
      import * as legend from "@legendapp/state";
      const state$ = legend.observable({ first: "", second: "" });
      legend.batch(() => {
        state$.first.set("one");
        state$.second.set("two");
      });
    `),
    []
  );
});

test("does not report writes already enclosed by batch", () => {
  assert.deepEqual(
    actions(`
      import { batch, observable } from "@legendapp/state";
      const state$ = observable({ open: false, value: "" });
      batch(() => {
        state$.open.set(false);
        state$.value.set("");
      });
    `),
    []
  );
});

test("does not infer Legend observables from dollar names or set syntax", () => {
  assert.deepEqual(
    actions(`
      const map$ = new Map<string, number>();
      map$.set("one", 1);
      map$.set("two", 2);
    `),
    []
  );
});

test("does not recommend a partial batch beside an unproven set call", () => {
  assert.deepEqual(
    actions(`
      import { observable } from "@legendapp/state";
      const state$ = observable({ first: "", second: "" });
      export function reset(external: { set(value: string): void }) {
        external.set("start");
        state$.first.set("one");
        state$.second.set("two");
      }
    `),
    []
  );
});

test("does not recommend production migrations in tests, stories, or demos", () => {
  const source = `
    import { observable } from "@legendapp/state";
    const state$ = observable({ first: "", second: "" });
    state$.first.set("one");
    state$.second.set("two");
  `;
  for (const fileName of ["store.test.ts", "__tests__/store.ts", "stories/store.ts"]) {
    assert.deepEqual(analyzeLegendPractices(source, fileName), [], fileName);
  }
});

test("does not batch repeated writes to the same observable path", () => {
  assert.deepEqual(
    actions(`
      import { observable } from "@legendapp/state";
      const phase$ = observable("idle");
      phase$.set("closing");
      phase$.set("closed");
    `),
    []
  );
});

test("does not batch parent and child writes together", () => {
  assert.deepEqual(
    actions(`
      import { observable } from "@legendapp/state";
      const state$ = observable({ open: false, value: "" });
      state$.set({ open: false, value: "" });
      state$.open.set(true);
    `),
    []
  );
});

test("does not infer stable paths through dynamic observable keys", () => {
  assert.deepEqual(
    actions(`
      import { observable } from "@legendapp/state";
      const rows$ = observable<Record<string, { first: string; second: string }>>({});
      export function reset(id: string) {
        rows$[id].first.set("one");
        rows$[id].second.set("two");
      }
    `),
    []
  );
});

test("does not cross control flow or unrelated statements", () => {
  assert.deepEqual(
    actions(`
      import { observable } from "@legendapp/state";
      const state$ = observable({ open: false, value: "" });
      state$.open.set(false);
      notify();
      state$.value.set("");
    `),
    []
  );
});

test("does not recommend an async batch callback", () => {
  assert.deepEqual(
    actions(`
      import { observable } from "@legendapp/state";
      const state$ = observable({ first: "", second: "" });
      async function load() {
        state$.first.set(await first());
        state$.second.set("done");
      }
    `),
    []
  );
});

test("rejects shadowed observable binding names", () => {
  assert.deepEqual(
    actions(`
      import { observable } from "@legendapp/state";
      const state$ = observable({ first: "", second: "" });
      function other() {
        const state$ = apiState();
        state$.first.set("one");
        state$.second.set("two");
      }
    `),
    []
  );
});

test("does not treat a collection containing observables as one observable", () => {
  assert.deepEqual(
    actions(`
      import type { Observable } from "@legendapp/state";
      export function reset(states: Array<Observable<{ first: string; second: string }>>) {
        states[0].first.set("one");
        states[0].second.set("two");
      }
    `),
    []
  );
});
