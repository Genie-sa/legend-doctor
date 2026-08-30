import assert from "node:assert/strict";
import test from "node:test";

import { analyzeLegendPractices } from "../src/analyze-legend-practices.js";

const requireValue = <Value>(value: Value | undefined): Value => {
  assert.ok(value);
  return value;
};

function actions(source: string): string[] {
  return analyzeLegendPractices(source, "fixture.ts").map((finding) => finding.action);
}

test("assigns consecutive direct fields of one local observable", () => {
  const [finding] = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    const player$ = observable({ loading: false, error: null as string | null });
    export function fail(message: string) {
      player$.error.set(message);
      player$.loading.set(false);
    }
  `,
    "fixture.ts",
  );
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

test("replaces exact observable boolean flips with toggle", () => {
  const findings = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useObservable } from "@legendapp/state/react";
    const shell$ = observable({ palette: { open: false } });
    export function useControls() {
      const local$ = useObservable({ expanded: false });
      const togglePalette = () => shell$.palette.open.set(!shell$.palette.open.peek());
      const toggleExpanded = () => local$.expanded.set(value => !value);
      return { toggleExpanded, togglePalette };
    }
  `,
    "fixture.ts",
  );
  const toggles = findings.filter((finding) => finding.action === "toggle-observable");
  assert.equal(toggles.length, 2);
  assert.ok(toggles.every((finding) => finding.confidence === "certain"));
  assert.match(requireValue(toggles[0]).message ?? "", /shell\$\.palette\.open\.toggle\(\)/u);
  assert.match(requireValue(toggles[1]).message ?? "", /local\$\.expanded\.toggle\(\)/u);
});

test("replaces exact boolean updater on a typed observable", () => {
  const findings = analyzeLegendPractices(
    `
    import type { Observable } from "@legendapp/state";
    export function toggle(state$: Observable<{ enabled: boolean }>) {
      state$.enabled.set(current => !current);
    }
  `,
    "fixture.ts",
  );

  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["toggle-observable"],
  );
});

test("keeps observable writes when an exact untracked boolean flip is not proven", () => {
  const source = (statement: string) =>
    analyzeLegendPractices(
      `
    import { observable } from "@legendapp/state";
    const state$ = observable({ enabled: false, other: false, rows: {} as Record<string, boolean> });
    declare const external$: { enabled: { peek(): boolean } };
    export function toggle(key: string) {
      ${statement}
    }
  `,
      "fixture.ts",
    ).filter((finding) => finding.action === "toggle-observable");

  for (const statement of [
    `state$.enabled.set(!state$.enabled.get());`,
    `state$.enabled.set(!state$.other.peek());`,
    `state$.enabled.set(!external$.enabled.peek());`,
    `state$.rows[key].set(!state$.rows[key].peek());`,
    `state$.enabled.set(current => !state$.other.peek());`,
    `state$.enabled.set(current => { return !current; });`,
    `state$.enabled.set(async current => !current);`,
    `state$.enabled.set(current => !!current);`,
    `state$.enabled.toggle();`,
  ]) {
    assert.deepEqual(source(statement), [], statement);
  }
});

test("does not infer toggle support through a shadowed observable root", () => {
  assert.deepEqual(
    analyzeLegendPractices(
      `
      import { observable } from "@legendapp/state";
      const state$ = observable({ enabled: false });
      export function toggle() {
        const state$ = externalState();
        state$.enabled.set(value => !value);
      }
    `,
      "fixture.ts",
    ).filter((finding) => finding.action === "toggle-observable"),
    [],
  );
});

test("replaces legacy Legend React selectors with useValue", () => {
  const findings = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useSelector as select, use$ } from "@legendapp/state/react";
    const profile$ = observable({ email: "", first: "", last: "", name: "" });
    export function Profile() {
      const name = select(profile$.name);
      const email = use$(() => profile$.email.get());
      const fullName = use$(() => profile$.first.get() + profile$.last.get());
      return <span>{name}{email}{fullName}</span>;
    }
  `,
    "fixture.tsx",
  );
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["replace-legacy-use-value", "replace-legacy-use-value", "replace-legacy-use-value"],
  );
  assert.ok(findings.every((finding) => finding.confidence === "certain"));
  assert.match(requireValue(findings[0]).message ?? "", /useValue\(profile\$\.name\)/u);
  assert.match(requireValue(findings[1]).message ?? "", /useValue\(profile\$\.email\)/u);
  assert.match(
    requireValue(findings[1]).message ?? "",
    /pass the proven observable path directly/u,
  );
  assert.match(
    requireValue(findings[2]).message ?? "",
    /useValue\(\(\) => profile\$\.first\.get\(\) \+ profile\$\.last\.get\(\)\)/u,
  );
  assert.match(requireValue(findings[2]).message ?? "", /preserve the selector arguments/u);
});

test("keeps legacy callbacks when a direct observable path is not proven", () => {
  const findings = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { use$ } from "@legendapp/state/react";
    const records$ = observable({ first: { name: "" } });
    declare const source: { get(): string };
    export function Screen({ id }: { id: "first" }) {
      use$(() => records$[id].get());
      use$(() => records$.first.get(true));
      use$(() => source.get());
      return null;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(findings.length, 3);
  for (const finding of findings) {
    assert.equal(finding.action, "replace-legacy-use-value");
    assert.match(finding.message, /preserve the selector arguments/u);
    assert.doesNotMatch(finding.message, /pass the proven observable path directly/u);
  }
});

test("replaces namespace legacy selectors without matching unrelated functions", () => {
  assert.deepEqual(
    actions(`
      import * as LegendReact from "@legendapp/state/react";
      export function Profile({ profile$ }) {
        return LegendReact.useSelector(profile$.name) + LegendReact.use$(() => profile$.email.get());
      }
    `),
    ["replace-legacy-use-value", "replace-legacy-use-value"],
  );
  for (const source of [
    `function useSelector(value: unknown) { return value; } useSelector(source);`,
    `import { useSelector } from "other-state"; useSelector(source);`,
    `import { useSelector } from "@legendapp/state/react";
     function Screen(useSelector) { return useSelector(source); }`,
    `import * as LegendReact from "@legendapp/state/react";
     function Screen(LegendReact) { return LegendReact.useSelector(source); }`,
  ]) {
    assert.deepEqual(actions(source), [], source);
  }
});

test("assigns direct fields under the same nested observable object", () => {
  const [finding] = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    const player$ = observable({ status: { loading: false, error: "" } });
    player$.status.loading.set(false);
    player$.status.error.set("failed");
  `,
    "fixture.ts",
  );
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

test("passes a proven observable directly to useValue", () => {
  const [finding] = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const theme$ = observable({ accent: "blue" });
    export function Theme() {
      const accent = useValue(() => theme$.accent.get());
      return <span>{accent}</span>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "pass-observable-to-use-value");
  assert.equal(requireValue(finding).confidence, "certain");
  assert.match(requireValue(finding).message ?? "", /useValue\(theme\$\.accent\)/u);
});

test("passes a dynamically keyed observable directly only for one stable primitive parameter", () => {
  const positive = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const ratings$ = observable<Record<string, number | null>>({});
    export function useRating(key: string) {
      return useValue(() => ratings$[key].get());
    }
  `,
    "fixture.ts",
  );
  assert.deepEqual(
    positive.map((finding) => finding.action),
    ["pass-observable-to-use-value"],
  );
  assert.match(requireValue(positive[0]).message ?? "", /useValue\(ratings\$\[key\]\)/u);

  for (const [parameter, setup, key] of [
    ["key: { toString(): string }", "", "key"],
    ["key: string", "key = 'other';", "key"],
    ["key: string", "[key] = ['other'];", "key"],
    ["key: string", "for (key of ['other']) break;", "key"],
    ["key: string", "", "nextKey()"],
    ["key?: string", "", "key"],
  ] as const) {
    const findings = analyzeLegendPractices(
      `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const ratings$ = observable<Record<string, number | null>>({});
      declare function nextKey(): string;
      export function useRating(${parameter}) {
        ${setup}
        return useValue(() => ratings$[${key}].get());
      }
    `,
      "fixture.ts",
    );
    assert.deepEqual(findings, [], `${parameter}; ${setup}; ${key}`);
  }
});

test("passes an eagerly read observable directly to useValue", () => {
  const findings = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useValue as read } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada", avatar: Promise.resolve("ada.png") });
    export function Profile() {
      const name = read(profile$.name.get());
      const avatar = read(profile$.avatar.get(), { suspense: true });
      return <span>{name}{avatar}</span>;
    }
  `,
    "fixture.tsx",
  );
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["pass-observable-to-use-value", "pass-observable-to-use-value"],
  );
  assert.match(requireValue(findings[0]).message ?? "", /read\(profile\$\.name\)/u);
  assert.match(
    requireValue(findings[1]).message ?? "",
    /read\(profile\$\.avatar, \{ suspense: true \}\)/u,
  );
  assert.match(
    requireValue(findings[0]).evidence.join(" ") ?? "",
    /before useValue can subscribe/u,
  );
});

test("preserves useValue types and options when simplifying one direct get selector", () => {
  const [finding] = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import * as LegendReact from "@legendapp/state/react";
    const profile$ = observable({ avatar: Promise.resolve("ada.png") });
    export function Profile() {
      return LegendReact.useValue<Promise<string>>(
        () => profile$.avatar.get(),
        { suspense: true }
      );
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "pass-observable-to-use-value");
  assert.match(
    requireValue(finding).message ?? "",
    /LegendReact\.useValue<Promise<string>>\(profile\$\.avatar, \{ suspense: true \}\)/u,
  );
});

test("keeps eager useValue inputs that are not one proven static get", () => {
  const findings = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada", rows: ["one"] });
    const external = { get: () => "outside" };
    const key = "name" as const;
    useValue(profile$.name.peek());
    useValue(profile$.rows.get(true));
    useValue(profile$[key].get());
    useValue(external.get());
    useValue(profile$.name?.get());
    useValue(profile$.name.get<string>());
    useValue(profile$.get.get());
    useValue(profile$.name.get(), {}, "extra");
  `,
    "fixture.tsx",
  );
  assert.deepEqual(findings, []);
});

test("keeps eager reads passed to a shadowing useValue binding", () => {
  const findings = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada" });
    export function Profile(useValue: (value: string) => string) {
      return useValue(profile$.name.get());
    }
  `,
    "fixture.tsx",
  );
  assert.deepEqual(findings, []);
});

test("writes one changed object field through the narrowest observable child", () => {
  const findings = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    const profile$ = observable({ name: "Ada", email: "ada@example.com" });
    export function rename(name: string) {
      const current = profile$.peek();
      profile$.set({ ...current, name });
    }
  `,
    "fixture.ts",
  );
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["narrow-observable-write"],
  );
  assert.match(requireValue(findings[0]).message ?? "", /profile\$\.name\.set\(name\)/u);
});

test("writes one dynamic record entry without cloning its parent object", () => {
  const findings = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    const rows$ = observable<Record<string, { name: string }>>({});
    export function updateRow(id: string, row: { name: string }) {
      const rows = rows$.peek() ?? {};
      rows$.set({ ...rows, [id]: row });
    }
  `,
    "fixture.ts",
  );
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["narrow-observable-write"],
  );
  assert.match(requireValue(findings[0]).message ?? "", /rows\$\[id\]\.set\(row\)/u);
});

test("appends one inert value directly to a proven observable array", () => {
  const findings = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useObservable } from "@legendapp/state/react";
    const pages$ = observable<string[]>([]);
    const store$ = observable({ rows: [] as string[] });
    export function append(page: string, row: string) {
      pages$.set(previous => [...previous, page]);
      store$.rows.set([...store$.rows.peek(), row]);
    }
    export function useFiles(file: string) {
      const files$ = useObservable<string[]>([]);
      const appendFile = (next: string) => {
        files$.set(previous => [...previous, next]);
      };
      appendFile(file);
      return files$;
    }
  `,
    "fixture.ts",
  );
  const appendFindings = findings.filter((finding) => finding.action === "narrow-observable-write");
  assert.equal(appendFindings.length, 3);
  assert.match(requireValue(appendFindings[0]).message ?? "", /pages\$\.push\(page\)/u);
  assert.match(requireValue(appendFindings[1]).message ?? "", /store\$\.rows\.push\(row\)/u);
  assert.match(requireValue(appendFindings[2]).message ?? "", /files\$\.push\(next\)/u);
});

test("keeps array writes whose append or array identity is not exact", () => {
  const bodies = [
    `list$.set(previous => [item, ...previous]);`,
    `list$.set(previous => [...previous, first, second]);`,
    `list$.set(previous => [...previous, ...items]);`,
    `list$.set(previous => [...previous, item].sort());`,
    `list$.set(previous => [...previous, createItem()]);`,
    `list$.set(previous => [...previous, source.value]);`,
    `list$.set(previous => [...previous, previous]);`,
    `list$.set([...list$.get(), item]);`,
    `const current = list$.peek(); consume(current); list$.set([...current, item]);`,
  ];
  for (const body of bodies) {
    const findings = analyzeLegendPractices(
      `
      import { observable } from "@legendapp/state";
      const list$ = observable<string[]>([]);
      export function append(item: string, first: string, second: string, items: string[]) {
        ${body}
      }
    `,
      "fixture.ts",
    );
    assert.deepEqual(
      findings.filter((finding) => finding.action === "narrow-observable-write"),
      [],
      body,
    );
  }

  assert.deepEqual(
    analyzeLegendPractices(
      `
      import { observable } from "@legendapp/state";
      const value$ = observable("ab");
      value$.set(previous => [...previous, "c"]);
    `,
      "fixture.ts",
    ).filter((finding) => finding.action === "narrow-observable-write"),
    [],
  );
  assert.deepEqual(
    analyzeLegendPractices(
      `
      import { list$ } from "./store";
      list$.set(previous => [...previous, "item"]);
    `,
      "fixture.ts",
      new Set(["list$"]),
    ).filter((finding) => finding.action === "narrow-observable-write"),
    [],
  );
});

test("keeps clone writes whose snapshot or replacement path is not equivalent", () => {
  const sources = [
    `const current = profile$.get(); profile$.set({ ...current, name });`,
    `const current = other$.peek(); profile$.set({ ...current, name });`,
    `const current = profile$.peek(); profile$.set({ ...current, name, email });`,
    `const current = profile$.peek(); mutate(current); profile$.set({ ...current, name });`,
    `const current = profile$.peek(); current.email = "changed"; profile$.set({ ...current, name });`,
    `const current = profile$.peek(); current.tags.push("changed"); profile$.set({ ...current, name });`,
    `const current = profile$.peek(); await pause(); profile$.set({ ...current, name });`,
    `const current = profile$.peek(); profile$.set({ ...current, ...updates });`,
    `const current = profile$.peek(); profile$.set({ ...current, get: name });`,
    `const current = profile$.peek(); profile$.set({ ...current, [computeKey()]: name });`,
  ];
  for (const body of sources) {
    assert.deepEqual(
      analyzeLegendPractices(
        `
        import { observable } from "@legendapp/state";
        const profile$ = observable({ name: "Ada", email: "ada@example.com", tags: [] as string[] });
        const other$ = observable({ name: "Grace", email: "grace@example.com" });
        export async function rename(name: string, updates: { name: string }) { ${body} }
      `,
        "fixture.ts",
      ).filter((finding) => finding.action === "narrow-observable-write"),
      [],
      body,
    );
  }
});

test("keeps clone writes when the old snapshot remains observable", () => {
  const bodies = [
    `const current = list$.peek(); list$.set([...current, item]); consume(current);`,
    `const current = profile$.peek(); profile$.set({ ...current, name }); return current.name;`,
    `const current = profile$.peek(); const alias = current; profile$.set({ ...current, name }); return alias.name;`,
    `const current = profile$.peek(); const read = () => current.name; profile$.set({ ...current, name }); return read();`,
    `const current = profile$.peek(); while (current.name !== name) { profile$.set({ ...current, name }); if (stop()) break; }`,
  ];
  for (const body of bodies) {
    const findings = analyzeLegendPractices(
      `
      import { observable } from "@legendapp/state";
      const list$ = observable<string[]>([]);
      const profile$ = observable({ name: "Ada", email: "ada@example.com" });
      export function update(item: string, name: string) { ${body} }
    `,
      "snapshot.ts",
    );

    assert.equal(
      findings.some((finding) => finding.action === "narrow-observable-write"),
      false,
      body,
    );
  }
});

test("uses cross-file observable provenance for direct useValue", () => {
  assert.deepEqual(
    analyzeLegendPractices(
      `
      import { useValue } from "@legendapp/state/react";
      import { settings$ } from "./store";
      export function Theme() {
        return <span>{useValue(() => settings$.theme.get())}</span>;
      }
    `,
      "fixture.tsx",
      new Set(["settings$"]),
    ).map((finding) => finding.action),
    ["pass-observable-to-use-value"],
  );
});

test("uses peek for proven non-tracking React snapshots and event commands", () => {
  const findings = analyzeLegendPractices(
    `
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
    "fixture.tsx",
  );
  const peekFindings = findings.filter((finding) => finding.action === "use-peek-for-snapshot");
  assert.equal(peekFindings.length, 4);
  assert.ok(peekFindings.every((finding) => finding.confidence === "probable"));
  assert.match(requireValue(peekFindings[0]).message ?? "", /\.peek\(\)/u);
});

test("uses peek for aliased React hooks and direct JSX event callbacks", () => {
  assert.deepEqual(
    analyzeLegendPractices(
      `
      import * as React from "react";
      import { observable } from "@legendapp/state";
      const state$ = observable({ value: 1 });
      export function Screen() {
        React.useEffect(() => consume(state$.value.get()), []);
        return <button onClick={() => consume(state$.value.get())}>Read</button>;
      }
    `,
      "fixture.tsx",
    ).map((finding) => finding.action),
    ["use-peek-for-snapshot", "use-peek-for-snapshot"],
  );
});

test("uses peek in direct React and Legend lifecycle callbacks only", () => {
  const findings = analyzeLegendPractices(
    `
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
    "fixture.tsx",
  );

  assert.deepEqual(
    findings
      .filter((finding) => finding.action === "use-peek-for-snapshot")
      .map((finding) => finding.location.line),
    [9, 10, 11, 12],
  );
});

test("uses direct useValue input as observable provenance for lifecycle snapshots", () => {
  const findings = analyzeLegendPractices(
    `
    import { useMount, useValue } from "@legendapp/state/react";
    import { settings$ } from "./settings";
    export function Panel({ id }: { id: string }) {
      const size$ = settings$.panels[id];
      const size = useValue(size$);
      useMount(() => register({ id, size: size$.get() }));
      return <div>{size}</div>;
    }
  `,
    "fixture.tsx",
    new Set(["settings$"]),
  );

  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["use-peek-for-snapshot"],
  );
});

test("does not promote reserved element access from direct useValue input", () => {
  const findings = analyzeLegendPractices(
    `
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
    "fixture.tsx",
  );

  assert.deepEqual(findings, []);
});

test("uses peek only in direct callbacks of proven observable onChange listeners", () => {
  const findings = analyzeLegendPractices(
    `
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
    "fixture.ts",
  );

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
      analyzeLegendPractices(source, "fixture.tsx").some(
        (finding) => finding.action === "use-peek-for-snapshot",
      ),
      false,
      source,
    );
  }
});

test("uses cross-file observable provenance for event snapshots", () => {
  const findings = analyzeLegendPractices(
    `
    import { profile$ } from "./store";
    export function Profile() {
      return <button onClick={() => save(profile$.name.get())}>Save</button>;
    }
  `,
    "fixture.tsx",
    new Set(["profile$"]),
  );
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["use-peek-for-snapshot"],
  );
});

test("keeps computed, shallow, dynamic, and unproven useValue selectors", () => {
  const source = (selector: string) =>
    analyzeLegendPractices(
      `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const state$ = observable({ selected: 1, rows: [{ name: "one" }] });
    const external = { get: () => 1 };
    export function Row({ index }: { index: number }) {
      const value = useValue(${selector});
      return <span>{String(value)}</span>;
    }
  `,
      "fixture.tsx",
    );
  for (const selector of [
    `() => state$.selected.get() === 1`,
    `() => state$.rows.get(true)`,
    `() => state$.rows[index].get()`,
    `() => external.get()`,
  ]) {
    assert.deepEqual(source(selector), [], selector);
  }
});

test("narrows a broad useValue binding to its only static child", () => {
  const [finding] = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada", email: "ada@example.com" });
    export function Profile() {
      const profile = useValue(profile$);
      return <><h1>{profile.name}</h1><span>{profile.name.trim()}</span></>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "narrow-use-value-subscription");
  assert.equal(requireValue(finding).confidence, "certain");
  assert.match(requireValue(finding).message ?? "", /useValue\(profile\$\.name\)/u);
  assert.match(requireValue(finding).evidence.join(" ") ?? "", /2 raw-value reads/u);
});

test("narrows useValue to the deepest shared static observable path", () => {
  const [finding] = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ contact: { name: "Ada", email: "ada@example.com" } });
    export function Profile() {
      const profile = useValue(profile$);
      return <><h1>{profile.contact.name}</h1><span>{profile.contact.name.trim()}</span></>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "narrow-use-value-subscription");
  assert.match(requireValue(finding).message ?? "", /useValue\(profile\$\.contact\.name\)/u);
  assert.match(requireValue(finding).message ?? "", /profile\.contact\.name/u);
});

test("uses the deepest common path when sibling leaves are read", () => {
  const [finding] = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ contact: { name: "Ada", email: "ada@example.com" } });
    export function Profile() {
      const profile = useValue(profile$);
      return <span>{profile.contact.name} {profile.contact.email}</span>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "narrow-use-value-subscription");
  assert.match(requireValue(finding).message ?? "", /useValue\(profile\$\.contact\)/u);
});

test("keeps a broad subscription when every known observable field is consumed", () => {
  const findings = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const single$ = observable({ value: "one" });
    const pair$ = observable({ first: "one", second: "two" });
    export function Screen() {
      const single = useValue(single$);
      const pair = useValue(pair$);
      return <span>{single.value}{pair.first}{pair.second}</span>;
    }
  `,
    "fixture.tsx",
  );
  assert.deepEqual(
    findings.filter(
      (finding) =>
        finding.action === "narrow-use-value-subscription" ||
        finding.action === "split-use-value-leaves",
    ),
    [],
  );
});

test("moves a subscription only into one stable isolated JSX leaf", () => {
  const positive = analyzeLegendPractices(
    `
    import { useObservable, useValue } from "@legendapp/state/react";
    export function Screen() {
      const open$ = useObservable(false);
      const open = useValue(open$);
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions /><Search />
        <Dialog open={open} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(positive.find((finding) => finding.location.line === 5)).action,
    "move-use-value-down",
  );
  assert.match(
    requireValue(positive.find((finding) => finding.location.line === 5)).message ?? "",
    /1 JSX element instead of the 13-element owner/u,
  );

  const cohesive = analyzeLegendPractices(
    `
    import { useObservable, useValue } from "@legendapp/state/react";
    export function Dialog() {
      const open$ = useObservable(false);
      const open = useValue(open$);
      return <Popup open={open} />;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    cohesive.some((finding) => finding.action === "move-use-value-down"),
    false,
  );

  for (const leaf of [
    "items.map(item => <Dialog key={item.id} open={open} />)",
    "<Dialog key={id} open={open} />",
    "<Dialog open={open} onOpenChange={() => log(open)} />",
  ]) {
    const findings = analyzeLegendPractices(
      `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen({ show, items }) {
        const open$ = useObservable(false);
        const open = useValue(open$);
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {${leaf}}
        </main>;
      }
    `,
      "fixture.tsx",
    );
    assert.equal(
      findings.some((finding) => finding.action === "move-use-value-down"),
      false,
      leaf,
    );
  }

  const splitReturn = analyzeLegendPractices(
    `
    import { useObservable, useValue } from "@legendapp/state/react";
    export function Screen({ loading }) {
      const open$ = useObservable(false);
      const open = useValue(open$);
      if (loading) return <Loading />;
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions /><Search />
        <Dialog open={open} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    splitReturn.some((finding) => finding.action === "move-use-value-down"),
    false,
  );
});

test("moves a subscription behind a complete conditional JSX slot without changing its lifetime", () => {
  const positive = analyzeLegendPractices(
    `
    import { useObservable, useValue } from "@legendapp/state/react";
    export function Screen({ view }) {
      const kind$ = useObservable("all");
      const kind = useValue(kind$);
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions /><Search />
        {view === "category" && <CategoryFilter kind={kind} />}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const finding = positive.find((candidate) => candidate.location.line === 5);
  assert.equal(requireValue(finding).action, "move-use-value-down");
  assert.match(requireValue(finding).message ?? "", /always-mounted wrapper/u);
  assert.match(requireValue(finding).message ?? "", /complete conditional JSX slot/u);
  assert.match(
    requireValue(finding).evidence.join(" ") ?? "",
    /preserves the subscription lifetime/u,
  );

  const controllingValue = analyzeLegendPractices(
    `
    import { useObservable, useValue } from "@legendapp/state/react";
    export function Screen() {
      const open$ = useObservable(false);
      const open = useValue(open$);
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions /><Search />
        {open ? <Dialog /> : null}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(controllingValue.find((candidate) => candidate.location.line === 5)).action,
    "move-use-value-down",
  );

  for (const source of [
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen({ loading, view }) {
        const kind$ = useObservable("all");
        const kind = useValue(kind$);
        if (loading) return <Loading />;
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {view === "category" && <CategoryFilter kind={kind} />}
        </main>;
      }
    `,
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen({ items, view }) {
        const kind$ = useObservable("all");
        const kind = useValue(kind$);
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {items.map(item => <section key={item.id}>
            {view === "category" && <CategoryFilter kind={kind} />}
          </section>)}
        </main>;
      }
    `,
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen({ show, view }) {
        const kind$ = useObservable("all");
        const kind = useValue(kind$);
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {show && <section>{view === "category" && <CategoryFilter kind={kind} />}</section>}
        </main>;
      }
    `,
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen({ view, id }) {
        const kind$ = useObservable("all");
        const kind = useValue(kind$);
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {view === "category" && <CategoryFilter key={id} kind={kind} />}
        </main>;
      }
    `,
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen({ view }) {
        const kind$ = useObservable("all");
        const kind = useValue(kind$);
        const panel = <section>{view === "category" && <CategoryFilter kind={kind} />}</section>;
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {panel}
        </main>;
      }
    `,
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen({ view }) {
        const state$ = useObservable({ kind: "all", error: "" });
        const state = useValue(state$);
        const error = useValue(state$.error);
        return <main>
          <Header kind={state.kind} /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {error ? <ErrorMessage>{error}</ErrorMessage> : null}
        </main>;
      }
    `,
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen({ view, check }) {
        const kind$ = useObservable("all");
        const kind = useValue(kind$);
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {check(view) && <CategoryFilter kind={kind} />}
        </main>;
      }
    `,
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      let visible = false;
      export function Screen() {
        const kind$ = useObservable("all");
        const kind = useValue(kind$);
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {visible && <CategoryFilter kind={kind} />}
        </main>;
      }
    `,
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen() {
        const state$ = useObservable({ error: "" });
        const hasError = useValue(() => state$.error.get().length > 0);
        const error = useValue(state$.error);
        return <main>
          <Header hasError={hasError} /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {error ? <ErrorMessage>{error}</ErrorMessage> : null}
        </main>;
      }
    `,
  ]) {
    const findings = analyzeLegendPractices(source, "fixture.tsx");
    assert.equal(
      findings.some((candidate) => candidate.action === "move-use-value-down"),
      false,
    );
  }
});

test("splits divergent leaf reads into per-leaf subscriptions", () => {
  const [finding] = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const localMusicState$ = observable({ tracks: [], isLocalFilesSelected: false, scanProgress: 0 });
    export function Playlist() {
      const state = useValue(localMusicState$);
      const hasTracks = state.tracks.length > 0;
      return <section>{hasTracks && String(state.isLocalFilesSelected)}{String(state.tracks)}</section>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "split-use-value-leaves");
  assert.equal(requireValue(finding).confidence, "certain");
  assert.equal(requireValue(finding).disposition, "change");
  assert.match(
    requireValue(finding).message ?? "",
    /const tracks = useValue\(localMusicState\$\.tracks\)/u,
  );
  assert.match(
    requireValue(finding).message ?? "",
    /const isLocalFilesSelected = useValue\(localMusicState\$\.isLocalFilesSelected\)/u,
  );
  assert.match(
    requireValue(finding).evidence.join(" ") ?? "",
    /3 raw-value reads resolve through 2 distinct static leaf paths/u,
  );
});

test("keeps the single-path narrowing when one shared path exists", () => {
  const [finding] = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ contact: { name: "Ada" }, other: 1 });
    export function Profile() {
      const profile = useValue(profile$);
      return <span>{profile.contact.name} {profile.contact.name.trim()}</span>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "narrow-use-value-subscription");
});

test("abstains from the split when the whole value escapes as a bare read", () => {
  for (const escape of [
    `track(state);`,
    `const snapshot = state;`,
    `<Row item={state} />`,
    `<Row {...state} />`,
    `[state].length;`,
  ]) {
    const findings = analyzeLegendPractices(
      `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const state$ = observable({ title: "a", done: false });
      function Row(props: Record<string, unknown>) { return null; }
      function track(value: unknown) { return value; }
      export function Screen() {
        const state = useValue(state$);
        ${escape}
        return <span>{state.title}{String(state.done)}</span>;
      }
    `,
      "fixture.tsx",
    );
    assert.deepEqual(findings, [], escape);
  }
});

test("abstains from the split on writes, calls, dynamic access, and reserved members", () => {
  for (const hazard of [
    `state.title = "x";`,
    `state?.title;`,
    `state["title"];`,
    `state.validate();`,
    `String(state.size);`,
  ]) {
    const findings = analyzeLegendPractices(
      `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const state$ = observable({ title: "a", done: false, validate: () => true, size: 1 });
      export function Screen() {
        const state = useValue(state$);
        ${hazard}
        return <span>{state.title}{String(state.done)}</span>;
      }
    `,
      "fixture.tsx",
    );
    assert.deepEqual(findings, [], hazard);
  }
});

test("abstains from the split when a proposed leaf name already binds in the owner", () => {
  const [finding] = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const state$ = observable({ tracks: [], ready: true });
    export function Screen() {
      const state = useValue(state$);
      const tracks = [1, 2, 3];
      return <span>{String(tracks.length)}{String(state.ready)}{String(state.tracks)}</span>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(finding, undefined);
});

test("stops narrowing at a TypeScript assertion boundary", () => {
  const [finding] = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({
      contact: { name: "Ada" } as { name: string } | null,
      status: "active",
    });
    export function Profile() {
      const profile = useValue(profile$);
      return <span>{(profile.contact!).name}</span>;
    }
  `,
    "fixture.tsx",
  );
  assert.match(requireValue(finding).message ?? "", /useValue\(profile\$\.contact\)/u);
});

test("narrows a child used by a boolean projection", () => {
  const [finding] = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ enabled: false, name: "Ada" });
    export function Profile() {
      const profile = useValue(profile$);
      return <span>{!profile.enabled ? "off" : "on"}</span>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "narrow-use-value-subscription");
  assert.match(requireValue(finding).message ?? "", /useValue\(profile\$\.enabled\)/u);
});

test("narrows a single-property useValue destructure", () => {
  const [finding] = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const theme$ = observable({ colors: { dark: { text: "black" }, light: { text: "white" } } });
    export function Theme() {
      const { dark: palette } = useValue(theme$.colors);
      return <span>{palette.text}</span>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "narrow-use-value-subscription");
  assert.match(requireValue(finding).message ?? "", /useValue\(theme\$\.colors\.dark\)/u);
  assert.match(requireValue(finding).message ?? "", /const palette =/u);
  assert.doesNotMatch(requireValue(finding).message ?? "", /palette\.dark/u);
});

test("tracks observable paths created by proven project factories and aliases", () => {
  const findings = analyzeLegendPractices(
    `
    import { useValue } from "@legendapp/state/react";
    import { makeStore } from "./create-store";
    const store$ = makeStore({ profile: { name: "Ada", email: "ada@example.com" } });
    const profile$ = store$.profile;
    function Name(value$: typeof profile$) {
      const profile = useValue(value$);
      return <span>{profile.name}</span>;
    }
  `,
    "fixture.tsx",
    new Set(),
    new Set(["makeStore"]),
  );
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["narrow-use-value-subscription"],
  );
  assert.match(requireValue(findings[0]).message ?? "", /useValue\(value\$\.name\)/u);
});

test("tracks typed aliases of source-proven observable member paths", () => {
  const findings = analyzeLegendPractices(
    `
    import { useValue } from "@legendapp/state/react";
    import { dialog } from "./state";
    function Name(value$: typeof dialog.value$.profile) {
      const profile = useValue(value$);
      return <span>{profile.name}</span>;
    }
  `,
    "fixture.tsx",
    new Set(["dialog.value$"]),
  );
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["narrow-use-value-subscription"],
  );
  assert.match(requireValue(findings[0]).message ?? "", /useValue\(value\$\.name\)/u);
});

test("does not infer mutable, nullable, reserved, or unproven observable aliases", () => {
  const source = (declarations: string, expression: string) =>
    analyzeLegendPractices(
      `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const store$ = observable({ profile: { name: "Ada" } });
    ${declarations}
    export function Name() {
      const profile = useValue(${expression});
      return <span>{profile.name}</span>;
    }
  `,
      "fixture.tsx",
    );
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
  const findings = analyzeLegendPractices(
    `
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
    "Screen.tsx",
    new Set(["shared$"]),
    new Set(["createStore"]),
  );

  assert.equal(
    findings.some((finding) => finding.action === "narrow-use-value-subscription"),
    false,
  );
});

test("splits divergent static leaf reads instead of keeping the broad subscription", () => {
  const [finding] = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada", email: "ada@example.com", rows: [] as string[] });
    export function Profile({ keyName }: { keyName: "name" }) {
      const profile = useValue(profile$);
      return <span>{profile.name} {profile.email}</span>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "split-use-value-leaves");
});

test("narrows optional raw-value reads only when they share one static child path", () => {
  const [finding] = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const dialog$ = observable<{ state: boolean; data?: { id: string } } | undefined>(undefined);
    export function Dialog() {
      const dialog = useValue(dialog$);
      return <span>{dialog?.data?.id}{dialog?.data?.id}</span>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "narrow-use-value-subscription");
  assert.match(requireValue(finding).message ?? "", /useValue\(dialog\$\.data\.id\)/u);

  for (const body of [
    `return <span>{dialog?.state}{dialog?.data?.id}</span>;`,
    `return <span>{dialog?.data?.[key]}</span>;`,
    `return <span>{dialog?.data?.id.trim()}</span>;`,
    `return <Child value={dialog} />;`,
  ]) {
    const findings = analyzeLegendPractices(
      `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const dialog$ = observable<{ state: boolean; data?: Record<string, string> } | undefined>(undefined);
      function Child({ value }: { value: unknown }) { return <>{String(value)}</>; }
      export function Dialog({ key }: { key: string }) {
        const dialog = useValue(dialog$);
        ${body}
      }
    `,
      "fixture.tsx",
    );
    assert.deepEqual(findings, [], body);
  }
});

test("keeps broad useValue reads when the child subscription is not proven equivalent", () => {
  const source = (body: string) =>
    analyzeLegendPractices(
      `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada", email: "ada@example.com", rows: [] as string[] });
    export function Profile({ keyName }: { keyName: "name" }) {
      const profile = useValue(profile$);
      ${body}
    }
  `,
      "fixture.tsx",
    );
  for (const body of [
    `return <span>{profile[keyName]}</span>;`,
    `return <Child profile={profile} />;`,
    `profile.name = "Grace"; return <span>{profile.name}</span>;`,
    `profile.contact.name = "Grace"; return <span>{profile.contact.name}</span>;`,
    `delete profile.contact.name; return <span>{String(profile.contact)}</span>;`,
    `return <span>{profile.name()}</span>;`,
    `return <span>{profile.contact[keyName]}</span>;`,
    `function nested(profile: { name: string }) { return profile.name; } return <span>{profile.name}</span>;`,
  ]) {
    assert.deepEqual(source(body), [], body);
  }
});

test("keeps array length as a selector concern rather than an observable child", () => {
  assert.deepEqual(
    analyzeLegendPractices(
      `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      const rows$ = observable(["one"]);
      export function Count() {
        const rows = useValue(rows$);
        return <span>{rows.length}</span>;
      }
    `,
      "fixture.tsx",
    ),
    [],
  );
});

test("keeps multi-property, defaulted, and rest useValue destructures", () => {
  const source = (binding: string) =>
    analyzeLegendPractices(
      `
    import { observable } from "@legendapp/state";
    import { useValue } from "@legendapp/state/react";
    const profile$ = observable({ name: "Ada", email: "ada@example.com" });
    export function Profile() {
      const ${binding} = useValue(profile$);
      return null;
    }
  `,
      "fixture.tsx",
    );
  for (const binding of [`{ name, email }`, `{ name = "Unknown" }`, `{ name, ...rest }`]) {
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

test("recommends batch when a conditional same-root write follows an assign run", () => {
  const [finding, ...rest] = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    const player$ = observable({ index: -1, isPlaying: false, positionSec: 0, durationSec: 0 });
    export function play(index: number, track: { duration: number } | null) {
      player$.index.set(index);
      player$.isPlaying.set(true);
      player$.positionSec.set(0);
      if (track) player$.durationSec.set(track.duration);
    }
  `,
    "fixture.ts",
  );
  assert.deepEqual(rest, []);
  assert.equal(requireValue(finding).action, "batch-observable-writes");
  assert.equal(requireValue(finding).location.line, 5);
  assert.match(requireValue(finding).message ?? "", /batch\(\(\) => \{ \.\.\. \}\)/u);
  assert.match(requireValue(finding).message ?? "", /player\$\.assign/u);
  assert.match(requireValue(finding).message ?? "", /`player\$\.durationSec`/u);
});

test("recommends batch when a conditional same-root write interrupts an assign run", () => {
  const findings = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    const player$ = observable({ index: -1, isPlaying: false, durationSec: 0 });
    export function play(index: number, track: { duration: number } | null) {
      player$.index.set(index);
      if (track) { player$.durationSec.set(track.duration); }
      player$.isPlaying.set(true);
    }
  `,
    "fixture.ts",
  );
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
  const findings = analyzeLegendPractices(
    `
    import { observable } from "@legendapp/state";
    const player$ = observable({ index: -1, isPlaying: false });
    const ui$ = observable({ toast: "" });
    export function play(index: number, track: { title: string } | null) {
      player$.index.set(index);
      player$.isPlaying.set(true);
      if (track) ui$.toast.set(track.title);
    }
  `,
    "fixture.ts",
  );
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["assign-observable-fields"],
  );
});

test("keeps the assign recommendation when the conditional branch mixes non-write statements", () => {
  const findings = analyzeLegendPractices(
    `
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
    "fixture.ts",
  );
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["assign-observable-fields"],
  );
});

test("keeps replace-legacy-use-value as a change when no installed package is resolved", () => {
  const [finding] = analyzeLegendPractices(
    `
    import { useSelector } from "@legendapp/state/react";
    export function read(value: string) { return useSelector(() => value); }
  `,
    "fixture.ts",
  );
  assert.equal(requireValue(finding).action, "replace-legacy-use-value");
  assert.equal(requireValue(finding).disposition, "change");
});

test("marks replace-legacy-use-value as style when the installed useValue is an alias", () => {
  const [finding] = analyzeLegendPractices(
    `
      import { use$ } from "@legendapp/state/react";
      export function read(value: string) { return use$(() => value); }
    `,
    "fixture.ts",
    new Set(),
    new Set(),
    { useValueExport: "alias", version: "3.0.0-beta.48" },
  );
  assert.equal(requireValue(finding).disposition, "style");
  assert.match(requireValue(finding).evidence.join("\n") ?? "", /no runtime effect/u);
});

test("suppresses replace-legacy-use-value when the installed package lacks useValue", () => {
  const findings = analyzeLegendPractices(
    `
      import { useSelector } from "@legendapp/state/react";
      export function read(value: string) { return useSelector(() => value); }
    `,
    "fixture.ts",
    new Set(),
    new Set(),
    { useValueExport: "missing", version: "2.1.0" },
  );
  assert.deepEqual(findings, []);
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
