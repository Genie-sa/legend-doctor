import { actions } from "./harness.js";
import assert from "node:assert/strict";
import test from "node:test";

function withTracker(tracker: string): string[] {
  return actions(`
    import { observable, observe } from "@legendapp/state";
    const player$ = observable({ index: -1, isPlaying: false, volume: 1, muted: false });
    export function play(index: number) {
      player$.index.set(index);
      player$.isPlaying.set(true);
    }
    ${tracker}
  `);
}

test("emits no transaction when nothing outside React tracks the written paths", () => {
  assert.deepEqual(withTracker(""), []);
});

test("emits no transaction when every tracker reads at most one written path", () => {
  for (const tracker of [
    `observe(() => { player$.index.get(); });`,
    `observe(() => player$.index.get()); observe(() => player$.isPlaying.get());`,
    `player$.isPlaying.onChange(() => {});`,
    `observe(() => { player$.index.get(); setTimeout(() => player$.isPlaying.get()); });`,
  ]) {
    assert.deepEqual(withTracker(tracker), [], tracker);
  }
});

test("emits no transaction when the file's trackers read only unwritten paths", () => {
  assert.deepEqual(
    withTracker(`observe(() => { player$.volume.get(); player$.muted.get(); });`),
    [],
  );
});

test("suggests the transaction when a parent onChange listener covers both written paths", () => {
  assert.deepEqual(withTracker(`player$.onChange(() => {});`), ["assign-observable-fields"]);
});
