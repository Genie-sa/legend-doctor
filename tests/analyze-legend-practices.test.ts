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
