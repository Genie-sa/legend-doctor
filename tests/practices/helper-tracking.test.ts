import { observable, observe } from "@legendapp/state";
import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

function findingsFor(body: string): LegendPracticeFinding[] {
  return analyzeLegendPractices({
    fileName: "fixture.tsx",
    sourceText: `
      import { batch, observable } from "@legendapp/state";
      import { useObserve, useObserveEffect, useValue } from "@legendapp/state/react";
      const state$ = observable({ trigger: 0, hidden: 0, published: 0 });
      ${body}
    `,
  });
}

function candidatesFor(body: string): LegendPracticeFinding[] {
  return findingsFor(body).filter((finding) => String(finding.action) === "review-helper-tracking");
}

test("reviews inherited helper dependencies without prescribing a snapshot rewrite", () => {
  for (const hook of ["useObserve", "useObserveEffect", "useValue"]) {
    const findings = findingsFor(`
      const publish = () => {
        batch(() => {
          const next = state$.hidden.get() + 1;
          state$.published.set(next);
        });
      };
      export function Screen() {
        ${hook}(() => { state$.trigger.get(); publish(); });
        return null;
      }
    `);
    const candidate = requireValue(
      findings.find((finding) => String(finding.action) === "review-helper-tracking"),
    );
    assert.equal(candidate.disposition, "candidate", hook);
    assert.match(candidate.evidence.join(" "), /hidden/u);
    assert.match(candidate.evidence.join(" "), /published/u);
    assert.match(candidate.evidence.join(" "), /batch/u);
    assert.equal(
      findings.some((finding) => finding.action === "use-peek-for-snapshot"),
      false,
    );
  }
});

test("keeps deferred helper reads outside the original selector tracking scope", () => {
  for (const helper of [
    "const read = () => { setTimeout(() => state$.hidden.get(), 0); };",
    "const read = () => { queueMicrotask(() => state$.hidden.get()); };",
    "const read = () => { Promise.resolve().then(() => state$.hidden.get()); };",
    "const read = async () => { await Promise.resolve(); state$.hidden.get(); };",
  ]) {
    assert.deepEqual(
      candidatesFor(`${helper}
        export function Screen() {
          useObserveEffect(() => { state$.trigger.get(); read(); });
          return null;
        }
      `),
      [],
      helper,
    );
  }
});

test("does not interpret a separate reaction or an unknown callback API as the selector", () => {
  for (const invocation of [
    "useObserveEffect(() => state$.trigger.get(), () => read());",
    "useObserveEffect(() => { state$.trigger.get(); schedule(read); });",
  ]) {
    assert.deepEqual(
      candidatesFor(`
        const read = () => state$.hidden.get();
        export function Screen() { ${invocation} return null; }
      `),
      [],
      invocation,
    );
  }
});

test("abstains on recursive and mutable helper dispatch", () => {
  for (const declaration of [
    "function read() { state$.hidden.get(); read(); }",
    "let read = () => state$.hidden.get(); read = externalRead;",
    "const helpers = { read: () => state$.hidden.get() }; const read = helpers[key];",
  ]) {
    assert.deepEqual(
      candidatesFor(`${declaration}
        export function Screen() {
          useObserveEffect(() => { state$.trigger.get(); read(); });
          return null;
        }
      `),
      [],
      declaration,
    );
  }
});

test("resolves helper and observable identities instead of matching shadowed names", () => {
  for (const body of [
    `const read = () => state$.hidden.get();
     export function Screen({ read }: { read: () => void }) {
       useObserveEffect(() => { state$.trigger.get(); read(); }); return null;
     }`,
    `function read(state$: { hidden: { get: () => number } }) { return state$.hidden.get(); }
     export function Screen() {
       useObserveEffect(() => { state$.trigger.get(); read(external); }); return null;
     }`,
    `const read = () => state$.hidden.get();
     export function Screen({ useObserveEffect }: { useObserveEffect: Function }) {
       useObserveEffect(() => { state$.trigger.get(); read(); }); return null;
     }`,
  ]) {
    assert.deepEqual(candidatesFor(body), [], body);
  }
});

test("requires an independent direct trigger before reviewing a helper dependency", () => {
  assert.deepEqual(
    candidatesFor(`
      const read = () => state$.hidden.get();
      export function Screen() { useObserveEffect(() => read()); return null; }
    `),
    [],
  );
});

test("does not claim an extra dependency when the helper only rereads the direct trigger", () => {
  assert.deepEqual(
    candidatesFor(`
      const read = () => state$.trigger.get();
      export function Screen() {
        useObserveEffect(() => { state$.trigger.get(); read(); }); return null;
      }
    `),
    [],
  );
});

test("abstains on default parameters, reassigned functions, and inaccessible local helpers", () => {
  for (const declaration of [
    "const read = (value = state$.hidden.get()) => value;",
    "function read() { return state$.hidden.get(); } read = externalRead;",
    "function outer() { const read = () => state$.hidden.get(); }",
  ]) {
    assert.deepEqual(
      candidatesFor(`${declaration}
        export function Screen() {
          useObserveEffect(() => { state$.trigger.get(); read(); }); return null;
        }
      `),
      [],
      declaration,
    );
  }
});

test("abstains on async and generator selectors whose execution contract differs", () => {
  for (const selector of [
    "async () => { state$.trigger.get(); read(); }",
    "function* () { state$.trigger.get(); read(); }",
  ]) {
    assert.deepEqual(
      candidatesFor(`
        const read = () => state$.hidden.get();
        export function Screen() { useObserveEffect(${selector}); return null; }
      `),
      [],
      selector,
    );
  }
});

test("does not execute generator batch callbacks or class instance initializers in summaries", () => {
  for (const body of [
    "batch(function* () { state$.hidden.get(); });",
    "class Deferred { value = state$.hidden.get(); }",
  ]) {
    assert.deepEqual(
      candidatesFor(`
        const read = () => { ${body} };
        export function Screen() {
          useObserveEffect(() => { state$.trigger.get(); read(); }); return null;
        }
      `),
      [],
      body,
    );
  }
});

test("does not grant synchronous batch semantics to a shadowing parameter", () => {
  assert.deepEqual(
    candidatesFor(`
      const read = (batch: (callback: () => void) => void) => {
        batch(() => state$.hidden.get());
      };
      export function Screen() {
        useObserveEffect(() => { state$.trigger.get(); read(schedule); }); return null;
      }
    `),
    [],
  );
});

test("keeps a helper child within an existing parent dependency", () => {
  for (const [trigger, hidden] of [["state$", "state$.hidden"]]) {
    assert.deepEqual(
      candidatesFor(`
        const read = () => ${hidden}.get();
        export function Screen() {
          useObserveEffect(() => { ${trigger}.get(); read(); }); return null;
        }
      `),
      [],
      `${trigger} / ${hidden}`,
    );
  }
});

test("does not invent dependencies from unreachable or unresolved conditional work", () => {
  for (const helper of [
    "const read = () => { return; state$.hidden.get(); };",
    "const read = () => { if (false) state$.hidden.get(); };",
    "const read = () => false && state$.hidden.get();",
  ]) {
    assert.deepEqual(
      candidatesFor(`${helper}
      export function Screen() { useObserveEffect(() => { state$.trigger.get(); read(); }); return null; }
    `),
      [],
    );
  }
});

test("compares structural observable paths and preserves terminating blocks", () => {
  for (const helper of [
    "const read = () => state$. trigger.get();",
    "const read = () => { { return; } state$.hidden.get(); };",
  ]) {
    assert.deepEqual(
      candidatesFor(`${helper}
      export function Screen() { useObserveEffect(() => { state$.trigger.get(); read(); }); return null; }
    `),
      [],
    );
  }
});

test("does not trust a reassigned observable receiver", () => {
  const findings = analyzeLegendPractices({
    fileName: "fixture.tsx",
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useObserveEffect } from "@legendapp/state/react";
    const trigger$ = observable(0);
    let state$ = observable({ hidden: 0 });
    state$ = external;
    const read = () => state$.hidden.get();
    export function Screen() { useObserveEffect(() => { trigger$.get(); read(); }); return null; }
  `,
  });
  assert.equal(
    findings.some((finding) => finding.action === "review-helper-tracking"),
    false,
  );
});

test("abstains when optional chains or logical assignments can skip helper reads", () => {
  for (const [helper, invocation] of [
    ["const read = (target) => target?.[state$.hidden.get()];", "read(undefined);"],
    ["const read = () => state$.hidden.get();", "const target = undefined; target?.[read()];"],
    ["const read = (flag) => flag ||= state$.hidden.get();", "read(true);"],
    ["const read = (flag) => flag &&= state$.hidden.get();", "read(false);"],
    ["const read = (flag) => flag ??= state$.hidden.get();", "read(1);"],
  ]) {
    assert.deepEqual(
      candidatesFor(`${helper}
      export function Screen() {
        useObserveEffect(() => { state$.trigger.get(); ${invocation} }); return null;
      }
    `),
      [],
      invocation,
    );
  }
});

test("abstains when labeled exits or throwing helpers prevent later reads", () => {
  for (const [helper, invocation] of [
    ["const read = () => { done: { break done; state$.hidden.get(); } };", "read();"],
    ["const read = () => state$.hidden.get();", "done: { break done; read(); }"],
    ["const fail = () => { throw 0; }; const read = () => state$.hidden.get();", "fail(); read();"],
    [
      "const fail = () => { batch(() => { throw 0; }); }; const read = () => state$.hidden.get();",
      "fail(); read();",
    ],
  ]) {
    assert.deepEqual(
      candidatesFor(`${helper}
      export function Screen() {
        useObserveEffect(() => { state$.trigger.get(); ${invocation} }); return null;
      }
    `),
      [],
      invocation,
    );
  }
});

test("does not prove a const helper available before its initialization", () => {
  assert.deepEqual(
    candidatesFor(`
    export function Screen() {
      useValue(() => { state$.trigger.get(); read(); });
      const read = () => state$.hidden.get();
      return null;
    }
  `),
    [],
  );
  const initialized = candidatesFor(`
    export function Screen() {
      const read = () => state$.hidden.get();
      useValue(() => { state$.trigger.get(); read(); });
      return null;
    }
  `);
  assert.equal(initialized.length, 1);
});

test("reviews a helper parent read that adds siblings beyond a direct child", () => {
  const candidate = requireValue(
    candidatesFor(`
    const read = () => state$.get();
    export function Screen() {
      useObserveEffect(() => { state$.trigger.get(); read(); }); return null;
    }
  `)[0],
  );
  assert.match(candidate.evidence.join(" "), /additional paths: state\$/u);
});

test("a helper root read adds sibling updates to a direct child subscription", (context) => {
  const state$ = observable({ trigger: 0, sibling: 0 });
  let directRuns = 0;
  let helperRuns = 0;
  const read = (): { trigger: number; sibling: number } => state$.get();
  context.after(
    observe(() => {
      state$.trigger.get();
      directRuns += 1;
    }),
  );
  context.after(
    observe(() => {
      state$.trigger.get();
      read();
      helperRuns += 1;
    }),
  );
  assert.deepEqual([directRuns, helperRuns], [1, 1]);
  state$.sibling.set(1);
  assert.deepEqual([directRuns, helperRuns], [1, 2]);
});
