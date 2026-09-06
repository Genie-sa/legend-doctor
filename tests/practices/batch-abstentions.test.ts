import { actions } from "./harness.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

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
    [],
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
    [],
  );
});

test("does not infer Legend observables from dollar names or set syntax", () => {
  assert.deepEqual(
    actions(`
      const map$ = new Map<string, number>();
      map$.set("one", 1);
      map$.set("two", 2);
    `),
    [],
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
    [],
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
    assert.deepEqual(analyzeLegendPractices({ sourceText: source, fileName }), [], fileName);
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
    [],
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
    [],
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
    [],
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
    [],
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
    [],
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
    [],
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
    [],
  );
});
