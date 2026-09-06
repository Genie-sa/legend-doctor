import { actions, requireValue } from "./harness.js";
import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

const IMPORTS = `
  import { observable } from "@legendapp/state";
  import { useObservable, useValue } from "@legendapp/state/react";
  const store$ = observable({ user: { name: "Ada" }, count: 0 });
`;

function findings(body: string): LegendPracticeFinding[] {
  return analyzeLegendPractices({ fileName: "fixture.tsx", sourceText: `${IMPORTS}\n${body}` });
}

test("reuses an observable passed straight into useObservable or observable", () => {
  const found = findings(`
    const alias$ = observable(store$.user);
    export function Profile() {
      const local$ = useObservable(store$.user.name);
      return <span>{useValue(local$)}</span>;
    }
  `);
  const reuse = found.filter((finding) => finding.action === "reuse-observable-reference");
  assert.equal(reuse.length, 2);
  assert.match(
    requireValue(reuse[0]).message,
    /Replace `observable\(store\$\.user\)` with `store\$\.user`/u,
  );
  assert.match(
    requireValue(reuse[1]).message,
    /Replace `useObservable\(store\$\.user\.name\)` with `store\$\.user\.name`/u,
  );
  assert.ok(requireValue(reuse[1]).evidence.some((line) => line.includes("unmounts")));
  assert.ok(requireValue(reuse[0]).evidence.every((line) => !line.includes("unmounts")));
  assert.ok(reuse.every((finding) => finding.practice === "ownership"));
});

test("reuses an observable through namespace imports", () => {
  assert.deepEqual(
    actions(`
      import * as Legend from "@legendapp/state";
      import { observable } from "@legendapp/state";
      import * as LegendReact from "@legendapp/state/react";
      const store$ = observable({ count: 0 });
      const alias$ = Legend.observable(store$.count);
      export function useCount() {
        return LegendReact.useObservable(store$.count);
      }
    `),
    ["reuse-observable-reference", "reuse-observable-reference"],
  );
});

test("keeps observable arguments that create a new value or an intentional link", () => {
  assert.deepEqual(
    findings(`
      export function Profile({ enabled }: { enabled: boolean }) {
        const copy$ = useObservable(store$.count, [enabled]);
        const owned$ = useObservable({ user: store$.user });
        const array$ = useObservable([store$.count]);
        const plain$ = useObservable(store$.count.get());
        return <span>{useValue(copy$)}{useValue(owned$)}{useValue(array$)}{useValue(plain$)}</span>;
      }
    `).filter((finding) => finding.action === "reuse-observable-reference"),
    [],
  );
});

test("snapshots a tracked initializer whose observable is written later", () => {
  const found = findings(`
    export function Editor({ fallback }: { fallback: string }) {
      const draft$ = useObservable(() => store$.user.name.get() || fallback);
      const reset = () => draft$.set("");
      return (
        <input
          value={useValue(draft$)}
          onChange={(event) => draft$.set(event.target.value)}
          onBlur={reset}
        />
      );
    }
  `);
  const snapshot = found.filter((finding) => finding.action === "snapshot-computed-initializer");
  assert.equal(snapshot.length, 1);
  const finding = requireValue(snapshot[0]);
  assert.equal(finding.location.line, 8);
  assert.match(
    finding.message,
    /Replace `useObservable\(\(\) => store\$\.user\.name\.get\(\) \|\| fallback\)` with `useObservable\(store\$\.user\.name\.peek\(\) \|\| fallback\)`/u,
  );
  assert.match(finding.message, /writes at lines 9 and 13/u);
  assert.ok(finding.evidence.some((line) => line.includes("computed observable")));
});

test("describes a block initializer and child writes without rewriting the body", () => {
  const found = findings(`
    export function Form() {
      const form$ = useObservable(() => {
        const name = store$.user.name.get();
        return { name, dirty: false };
      });
      const markDirty = () => form$.dirty.set(true);
      return <button onClick={markDirty}>{useValue(form$.name)}</button>;
    }
  `);
  const snapshot = found.filter((finding) => finding.action === "snapshot-computed-initializer");
  assert.equal(snapshot.length, 1);
  assert.match(
    requireValue(snapshot[0]).message,
    /plain initial value whose observable reads use `\.peek\(\)`/u,
  );
  assert.match(requireValue(snapshot[0]).message, /writes at line 12/u);
});

test("keeps computed initializers that are never written, already snapshot, or linked", () => {
  assert.deepEqual(
    findings(`
      import { linked } from "@legendapp/state";
      export function Summary({ fallback }: { fallback: string }) {
        const derived$ = useObservable(() => store$.user.name.get() || fallback);
        const seeded$ = useObservable(store$.user.name.peek() || fallback);
        const lazy$ = useObservable(() => fallback.trim());
        const link$ = useObservable(() =>
          linked({ get: () => store$.count.get(), set: ({ value }) => store$.count.set(value) }),
        );
        const table$ = useObservable((id: string) => store$.user.name.get() + id);
        const reset = () => {
          seeded$.set("");
          lazy$.set("");
          link$.set(1);
          table$.set({});
        };
        return <button onClick={reset}>{useValue(derived$)}</button>;
      }
    `).filter((finding) => finding.action === "snapshot-computed-initializer"),
    [],
  );
});

test("keeps computed initializers whose tracked reads sit inside nested callbacks", () => {
  assert.deepEqual(
    findings(`
      export function Rows() {
        const rows$ = useObservable(() => ["a", "b"].map((row) => row + store$.count.get()));
        const clear = () => rows$.set([]);
        return <button onClick={clear}>{useValue(rows$).length}</button>;
      }
    `).filter((finding) => finding.action === "snapshot-computed-initializer"),
    [],
  );
});
