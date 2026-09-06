import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("uses peek for proven non-tracking React snapshots and event commands", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useEffect, useState } from "react";
    import { useObservable } from "@legendapp/state/react";
    const settings$ = observable({ name: "Ada", open: false });
    export function Profile() {
      const local$ = useObservable({ selected: 0 });
      const [initial] = useState(() => settings$.name.get());
      useEffect(() => {
        report(settings$.open.get());
      }, []);
      const handleSave = () => {
        save(settings$.name.get(), local$.selected.get());
      };
      return <button onClick={handleSave}>{initial}</button>;
    }
  `,
    fileName: "fixture.tsx",
  });
  const peekFindings = findings.filter((finding) => finding.action === "use-peek-for-snapshot");
  assert.equal(peekFindings.length, 4);
  assert.ok(peekFindings.every((finding) => finding.confidence === "probable"));
  assert.match(requireValue(peekFindings[0]).message ?? "", /\.peek\(\)/u);
});

test("uses peek for aliased React hooks and direct JSX event callbacks", () => {
  assert.deepEqual(
    analyzeLegendPractices({
      sourceText: `
      import * as React from "react";
      import { observable } from "@legendapp/state";
      const state$ = observable({ value: 1 });
      export function Screen() {
        React.useEffect(() => consume(state$.value.get()), []);
        return <button onClick={() => consume(state$.value.get())}>Read</button>;
      }
    `,
      fileName: "fixture.tsx",
    }).map((finding) => finding.action),
    ["use-peek-for-snapshot", "use-peek-for-snapshot"],
  );
});

test("uses peek in direct React and Legend lifecycle callbacks only", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import * as React from "react";
    import { useInsertionEffect as useInsert } from "react";
    import * as LegendReact from "@legendapp/state/react";
    import { useMount as onMount, useObserve } from "@legendapp/state/react";
    import { observable } from "@legendapp/state";
    const state$ = observable({ insertion: 0, layout: 0, mount: 0, nested: 0, tracked: 0, unmount: 0 });
    export function Screen() {
      useInsert(() => consume(state$.insertion.get()), []);
      React.useLayoutEffect(() => consume(state$.layout.get()), []);
      onMount(() => consume(state$.mount.get()));
      LegendReact.useUnmount(() => consume(state$.unmount.get()));
      onMount(() => subscribe(() => consume(state$.nested.get())));
      useObserve(() => consume(state$.tracked.get()));
      return null;
    }
  `,
    fileName: "fixture.tsx",
  });

  assert.deepEqual(
    findings
      .filter((finding) => finding.action === "use-peek-for-snapshot")
      .map((finding) => finding.location.line),
    [9, 10, 11, 12],
  );
});

test("uses direct useValue input as observable provenance for lifecycle snapshots", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { useMount, useValue } from "@legendapp/state/react";
    import { settings$ } from "./settings";
    export function Panel({ id }: { id: string }) {
      const size$ = settings$.panels[id];
      const size = useValue(size$);
      useMount(() => register({ id, size: size$.get() }));
      return <div>{size}</div>;
    }
  `,
    fileName: "fixture.tsx",
    importedObservables: new Set(["settings$"]),
  });

  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["use-peek-for-snapshot"],
  );
});

test("does not promote reserved element access from direct useValue input", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable } from "@legendapp/state";
    import { useMount, useValue } from "@legendapp/state/react";
    const state$ = observable({ value: 1 });
    export function Screen() {
      const getter$ = state$["get"];
      const getter = useValue(getter$);
      useMount(() => consume(getter$.get()));
      return <span>{String(getter)}</span>;
    }
  `,
    fileName: "fixture.tsx",
  });

  assert.deepEqual(findings, []);
});

test("uses peek only in direct callbacks of proven observable onChange listeners", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { observable, observe } from "@legendapp/state";
    const state$ = observable({ nested: 0, snapshot: 0, tracked: 0, trigger: 0 });
    const external = { onChange: (callback: () => void) => callback() };
    const named = () => consume(state$.nested.get());
    state$.trigger.onChange(() => consume(state$.snapshot.get()));
    state$.trigger.onChange(() => schedule(() => consume(state$.nested.get())));
    state$.trigger.onChange(named);
    observe(() => state$.trigger.onChange(() => consume(state$.nested.get()), { initial: true }));
    external.onChange(() => consume(state$.snapshot.get()));
    observe(() => consume(state$.tracked.get()));
  `,
    fileName: "fixture.ts",
  });

  assert.deepEqual(
    findings.map((finding) => ({ action: finding.action, line: finding.location.line })),
    [{ action: "use-peek-for-snapshot", line: 6 }],
  );
});

test("keeps get in tracking, render, shallow, and ambiguous callbacks", () => {
  const sources = [
    `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const state$ = observable({ value: 1 });
      export function Screen() {
        const value = useValue(() => state$.value.get() + 1);
        return <span>{value}</span>;
      }
    `,
    `
      import { observable, observe } from "@legendapp/state";
      const state$ = observable({ value: 1 });
      observe(() => consume(state$.value.get()));
    `,
    `
      import { observable } from "@legendapp/state";
      const state$ = observable({ value: 1 });
      export function Screen() {
        return <span>{state$.value.get()}</span>;
      }
    `,
    `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const state$ = observable({ rows: [] as string[] });
      export function Screen() {
        const rows = useValue(() => state$.rows.get(true));
        return <span>{rows.length}</span>;
      }
    `,
    `
      import { observable } from "@legendapp/state";
      const state$ = observable({ value: 1 });
      export function Screen() {
        const read = () => state$.value.get();
        subscribe(read);
        return <button onClick={read}>Read</button>;
      }
    `,
    `
      import { observable } from "@legendapp/state";
      const state$ = observable({ value: 1 });
      export function Screen() {
        return <button onClick={() => schedule(() => consume(state$.value.get()))}>Read</button>;
      }
    `,
    `
      import { observable } from "@legendapp/state";
      import { useMount } from "./hooks";
      const state$ = observable({ value: 1 });
      export function Screen() {
        useMount(() => consume(state$.value.get()));
        return null;
      }
    `,
  ];
  for (const source of sources) {
    assert.equal(
      analyzeLegendPractices({ sourceText: source, fileName: "fixture.tsx" }).some(
        (finding) => finding.action === "use-peek-for-snapshot",
      ),
      false,
      source,
    );
  }
});

test("uses cross-file observable provenance for event snapshots", () => {
  const findings = analyzeLegendPractices({
    sourceText: `
    import { profile$ } from "./store";
    export function Profile() {
      return <button onClick={() => save(profile$.name.get())}>Save</button>;
    }
  `,
    fileName: "fixture.tsx",
    importedObservables: new Set(["profile$"]),
  });
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["use-peek-for-snapshot"],
  );
});
