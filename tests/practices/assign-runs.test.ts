import { actions, requireValue } from "./harness.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

test("assigns consecutive direct fields of one local observable", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    const player$ = observable({ loading: false, error: null as string | null });
    export function fail(message: string) {
      player$.error.set(message);
      player$.loading.set(false);
    }
  `,
    fileName: "fixture.ts",
  });
  assert.equal(requireValue(finding).action, "assign-observable-fields");
  assert.equal(requireValue(finding).location.line, 5);
  assert.match(requireValue(finding).message ?? "", /observers publish once/u);
  assert.match(requireValue(finding).message ?? "", /player\$\.assign/u);
  assert.match(requireValue(finding).message ?? "", /`error`, `loading`/u);
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
    ["assign-observable-fields"],
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
    ["assign-observable-fields"],
  );
});

test("assigns direct fields under the same nested observable object", () => {
  const [finding] = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    const player$ = observable({ status: { loading: false, error: "" } });
    player$.status.loading.set(false);
    player$.status.error.set("failed");
  `,
    fileName: "fixture.ts",
  });
  assert.equal(requireValue(finding).action, "assign-observable-fields");
  assert.match(requireValue(finding).message ?? "", /player\$\.status\.assign/u);
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
    ["batch-observable-writes"],
  );
});

test("uses batch when assign would change updater or read ordering", () => {
  for (const secondWrite of [
    `state$.second.set(value => value + 1);`,
    `state$.second.set(state$.first.get() + 1);`,
    `state$.second.set(deriveSecond());`,
    `state$.second.set(new Widget());`,
    `state$.second.set(source.value);`,
    "state$.second.set(tag`value`);",
    `state$.second.set({ ...source });`,
    `state$.second.set(source + "");`,
    `state$.second.set(+1n);`,
    `state$.second.set(source = next);`,
    `state$.second.set(++index);`,
    `state$.second.set(delete source.value);`,
  ]) {
    assert.deepEqual(
      actions(`
        import { observable } from "@legendapp/state";
        const state$ = observable({ first: 0, second: 0 });
        state$.first.set(1);
        ${secondWrite}
      `),
      ["batch-observable-writes"],
    );
  }
});

test("recommends batch when a conditional same-root write follows an assign run", () => {
  const [finding, ...rest] = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    const player$ = observable({ index: -1, isPlaying: false, positionSec: 0, durationSec: 0 });
    export function play(index: number, track: { duration: number } | null) {
      player$.index.set(index);
      player$.isPlaying.set(true);
      player$.positionSec.set(0);
      if (track) player$.durationSec.set(track.duration);
    }
  `,
    fileName: "fixture.ts",
  });
  assert.deepEqual(rest, []);
  assert.equal(requireValue(finding).action, "batch-observable-writes");
  assert.equal(requireValue(finding).location.line, 5);
  assert.match(requireValue(finding).message ?? "", /batch\(\(\) => \{ \.\.\. \}\)/u);
  assert.match(requireValue(finding).message ?? "", /player\$\.assign/u);
  assert.match(requireValue(finding).message ?? "", /`player\$\.durationSec`/u);
});

test("recommends batch when a conditional same-root write interrupts an assign run", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    const player$ = observable({ index: -1, isPlaying: false, durationSec: 0 });
    export function play(index: number, track: { duration: number } | null) {
      player$.index.set(index);
      if (track) { player$.durationSec.set(track.duration); }
      player$.isPlaying.set(true);
    }
  `,
    fileName: "fixture.ts",
  });
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["batch-observable-writes"],
  );
  assert.match(
    requireValue(findings[0]).message ?? "",
    /conditional write to `player\$\.durationSec`/u,
  );
});

test("keeps the assign recommendation when the conditional writes another root", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    const player$ = observable({ index: -1, isPlaying: false });
    const ui$ = observable({ toast: "" });
    export function play(index: number, track: { title: string } | null) {
      player$.index.set(index);
      player$.isPlaying.set(true);
      if (track) ui$.toast.set(track.title);
    }
  `,
    fileName: "fixture.ts",
  });
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["assign-observable-fields"],
  );
});

test("keeps the assign recommendation when the conditional branch mixes non-write statements", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    const player$ = observable({ index: -1, isPlaying: false, durationSec: 0 });
    export function play(index: number, track: { duration: number } | null) {
      player$.index.set(index);
      player$.isPlaying.set(true);
      if (track) {
        console.log(track.duration);
        player$.durationSec.set(track.duration);
      }
    }
  `,
    fileName: "fixture.ts",
  });
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["assign-observable-fields"],
  );
});

test("emits nothing when a conditional write overlaps an unconditional path", () => {
  assert.deepEqual(
    actions(`
      import { observable } from "@legendapp/state";
      const player$ = observable({ index: -1, isPlaying: false });
      export function play(index: number, resume: boolean) {
        player$.index.set(index);
        player$.isPlaying.set(false);
        if (resume) player$.isPlaying.set(true);
      }
    `),
    [],
  );
});
