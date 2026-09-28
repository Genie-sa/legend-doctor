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
