import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const header = `
  import { useCallback, useEffect, useMemo, useRef } from "react";
  import { observable } from "@legendapp/state";
  import { useObservable, useValue } from "@legendapp/state/react";
  declare function log(value: unknown): void;
  declare const other$: { get(): number };
`;

const player = `const player$ = observable({ playing: false, index: -1, tracks: [], title: null });`;

function unrendered(
  body: string,
  store = player,
  preamble = header,
): LegendPracticeFinding | undefined {
  return analyzeLegendPractices({
    fileName: "fixture.tsx",
    sourceText: `${preamble}\n${store}\nexport function Player() {\n${body}\n}`,
  }).find((finding) => finding.action === "peek-unrendered-use-value");
}

test("deletes a useValue subscription that nothing reads", () => {
  const finding = requireValue(
    unrendered(`
      const playing = useValue(player$.playing);
      return <p>idle</p>;
    `),
  );
  assert.equal(finding.disposition, "change");
  assert.equal(finding.confidence, "probable");
  assert.match(finding.message, /^Delete `const playing = useValue\(player\$\.playing\)`/u);
  assert.match(finding.message, /stop rerendering `Player`/u);
});

test("replaces hook initial values and event-rooted reads with peek()", () => {
  const finding = requireValue(
    unrendered(`
      const index = useValue(player$.index);
      const initial = useRef(index);
      const select = useCallback(() => log(index), [index]);
      return <button onClick={select} onFocus={() => log(index)}>go</button>;
    `),
  );
  assert.match(finding.message, /replace its 3 non-render reads \(line 12, 13, 14\)/u);
  assert.match(finding.message, /`player\$\.index\.peek\(\)`/u);
  assert.match(finding.message, /drop `index` from the useCallback dependencies at line 13/u);
});

test("proves reads through legacy aliases, local observables, and shadowed render names", () => {
  for (const [label, body] of [
    [
      "use$ alias",
      `const playing = use$(player$.playing);
       return <p>idle</p>;`,
    ],
    [
      "useObservable seed",
      `const open$ = useObservable(false);
       const open = useValue(open$);
       return <p>idle</p>;`,
    ],
    [
      "shadowed render read",
      `const title = useValue(player$.title);
       return <ul>{["a"].map((title) => <li key={title}>{title}</li>)}</ul>;`,
    ],
    [
      "renamed destructuring key",
      `const { select: selectBase } = { select: () => undefined };
       const skip = useRef(false);
       const playing = useValue(player$.playing);
       const select = useCallback(() => { if (skip.current) return; selectBase(); }, [selectBase]);
       return <button onClick={select}>go</button>;`,
    ],
    [
      "ref written from a deferred measurement",
      `const rect = useRef(0);
       const playing = useValue(player$.playing);
       const measure = useCallback(() => { rect.current = 1; }, []);
       useEffect(() => { requestAnimationFrame(measure); }, [measure]);
       return <p>idle</p>;`,
    ],
  ] as const) {
    const preamble = header.replace(
      "useObservable, useValue",
      label === "use$ alias" ? "use$" : "useObservable, useValue",
    );
    assert.ok(unrendered(body, player, preamble), label);
  }
});

test("keeps subscriptions whose value a render or a later timing reads", () => {
  for (const [label, body] of [
    ["render read", `const playing = useValue(player$.playing); return <p>{playing}</p>;`],
    [
      "async handler",
      `const index = useValue(player$.index);
       return <button onClick={async () => { await Promise.resolve(); log(index); }}>go</button>;`,
    ],
    [
      "deferred read",
      `const index = useValue(player$.index);
       return <button onClick={() => setTimeout(() => log(index))}>go</button>;`,
    ],
    [
      "effect read",
      `const index = useValue(player$.index);
       useEffect(() => log(index), [index]);
       return null;`,
    ],
    [
      "stale callback closure",
      `const index = useValue(player$.index);
       const select = useCallback(() => log(index), []);
       return <button onClick={select}>go</button>;`,
    ],
    [
      "memo factory read",
      `const index = useValue(player$.index);
       const label = useMemo(() => String(index), [index]);
       return <button onClick={label}>go</button>;`,
    ],
    [
      "render callback read",
      `const index = useValue(player$.index);
       const label = () => String(index);
       return <p>{label()}</p>;`,
    ],
    [
      "subscription options",
      `const playing = useValue(player$.playing, { suspense: true }); return null;`,
    ],
    ["mutable binding", `let playing = useValue(player$.playing); return null;`],
    [
      "conditional subscription",
      `if (Math.random()) { const playing = useValue(player$.playing); } return null;`,
    ],
  ] as const) {
    assert.equal(unrendered(body), undefined, label);
  }
});

test("keeps subscriptions when a render may rely on the forced rerender", () => {
  for (const [label, body] of [
    [
      "ref read in render",
      `const count = useRef(0);
       const playing = useValue(player$.playing);
       return <p>{count.current}</p>;`,
    ],
    [
      "untracked get in render",
      `const playing = useValue(player$.playing);
       return <p>{other$.get()}</p>;`,
    ],
    [
      "ref read in a render-invoked callback",
      `const count = useRef(0);
       const playing = useValue(player$.playing);
       const read = useCallback(() => count.current, []);
       return <p>{read()}</p>;`,
    ],
    [
      "ref read in a non-event prop",
      `const count = useRef(0);
       const playing = useValue(player$.playing);
       return <List renderItem={() => count.current} />;`,
    ],
  ] as const) {
    assert.equal(unrendered(body), undefined, label);
  }
});

test("sees through wrappers that return a defined subscription result unchanged", () => {
  const store = `${player}\nconst FIRST = 0;`;
  const deleted = requireValue(
    unrendered(`const playing = useValue(player$.playing) ?? false; return null;`, store),
  );
  assert.match(
    deleted.message,
    /^Delete `const playing = useValue\(player\$\.playing\) \?\? false`; nothing reads `playing`/u,
  );
  const imported = requireValue(
    unrendered(
      `const index = useValue(player$.index) ?? DEFAULT_INDEX; return null;`,
      store,
      `${header}\nimport { DEFAULT_INDEX } from "./constants";`,
    ),
  );
  assert.match(imported.message, /\?\? DEFAULT_INDEX`; nothing reads `index`/u);
  const asserted = requireValue(
    unrendered(
      `const index = useValue(player$.index)!;
       return <button onClick={() => log(index)}>go</button>;`,
      store,
    ),
  );
  assert.match(asserted.message, /with `player\$\.index\.peek\(\)`/u);
  const fallback = requireValue(
    unrendered(
      `const index = (useValue(player$.index) as number | undefined) ?? FIRST;
       return <button onClick={() => log(index)}>go</button>;`,
      store,
    ),
  );
  assert.match(fallback.message, /with `\(player\$\.index\.peek\(\) \?\? FIRST\)`/u);
});

test("keeps wrapped subscriptions whose fallback or operator changes the value or its timing", () => {
  const store = `${player}\nlet mutableFallback = 0;\ndeclare function compute(): number;`;
  const preamble = `${header}\nimport { DEFAULT_INDEX } from "./constants";`;
  for (const [label, body] of [
    ["falsy fallback", `const index = useValue(player$.index) || 0; return null;`],
    ["arithmetic", `const index = useValue(player$.index) + 1; return null;`],
    ["called fallback", `const index = useValue(player$.index) ?? compute(); return null;`],
    [
      "owner-level fallback",
      `const first = 0;
       const index = useValue(player$.index) ?? first;
       return null;`,
    ],
    [
      "mutable fallback copied into a command",
      `const index = useValue(player$.index) ?? mutableFallback;
       return <button onClick={() => log(index)}>go</button>;`,
    ],
    [
      "imported fallback copied into a command",
      `const index = useValue(player$.index) ?? DEFAULT_INDEX;
       return <button onClick={() => log(index)}>go</button>;`,
    ],
  ] as const) {
    assert.equal(unrendered(body, store, preamble), undefined, label);
  }
});

test("treats a direct get() inside a Legend selector callback as a tracked render read", () => {
  const legacyPreamble = header.replace("useObservable, useValue", "use$, useSelector, useValue");
  for (const [label, body] of [
    [
      "useValue selector",
      `const player = useValue(player$);
       const current = useValue(() => player$.index.get() === 1);
       return <p>{current ? "a" : "b"}</p>;`,
    ],
    [
      "legacy useSelector selector",
      `const player = use$(player$);
       const current = useSelector(() => {
         const index = player$.index.get();
         return index === 1;
       });
       return <p>{current ? "a" : "b"}</p>;`,
    ],
  ] as const) {
    assert.ok(unrendered(body, player, legacyPreamble), label);
  }
});

test("quotes the legacy hook it deletes beside a selector that tracks its own read", () => {
  const preamble = header.replace("useObservable, useValue", "use$, useSelector");
  const finding = requireValue(
    unrendered(
      `const player = use$(player$);
       const current = useSelector(() => player$.index.get() === 1);
       return <p>{current ? "current" : "idle"}</p>;`,
      player,
      preamble,
    ),
  );
  assert.match(finding.message, /^Delete `const player = use\$\(player\$\)`/u);
});

test("keeps subscriptions beside selector reads that no hook tracks", () => {
  const legacy = header.replace("useObservable, useValue", "use$, useSelector");
  for (const [label, body, preamble] of [
    [
      "selector reads an unproven receiver",
      `const player = use$(player$);
       const current = useSelector(() => other$.get() === 1);
       return <p>{current ? "current" : "idle"}</p>;`,
      legacy,
    ],
    [
      "selector read inside a nested callback",
      `const player = use$(player$);
       const current = useSelector(() => [1].some(() => player$.index.get() === 1));
       return <p>{current ? "current" : "idle"}</p>;`,
      legacy,
    ],
    [
      "memo factory read",
      `const player = useValue(player$);
       const current = useMemo(() => player$.index.get() === 1, []);
       return <p>{current ? "current" : "idle"}</p>;`,
      header,
    ],
    [
      "foreign selector hook",
      `const player = use$(player$);
       const current = useSelector(() => player$.index.get() === 1);
       return <p>{current ? "current" : "idle"}</p>;`,
      `${header.replace("useObservable, useValue", "use$")}\nimport { useSelector } from "react-redux";`,
    ],
    [
      "peek in a selector",
      `const player = useValue(player$);
       const current = useValue(() => player$.index.peek());
       return <p>{current}</p>;`,
      header,
    ],
    [
      "ref in a selector",
      `const count = useRef(0);
       const player = useValue(player$);
       const current = useValue(() => player$.index.get() + count.current);
       return <p>{current}</p>;`,
      header,
    ],
    [
      "async selector",
      `const player = useValue(player$);
       const current = useValue(async () => player$.index.get());
       return <p>{String(current)}</p>;`,
      header,
    ],
  ] as const) {
    assert.equal(unrendered(body, player, preamble), undefined, label);
  }
});

test("requires a plain-data seed for the subscribed path", () => {
  const body = `const playing = useValue(player$.playing); return null;`;
  for (const [label, store] of [
    ["computed child", `const player$ = observable({ playing: () => other$.get() > 0 });`],
    ["lazy synced child", `const player$ = observable({ playing: synced({ get: () => false }) });`],
    [
      "declared type only",
      `interface Player { playing: boolean } declare const seed: Player; const player$ = observable<Player>(seed);`,
    ],
    [
      "later spread may replace the seed",
      `declare const defaults: object; const player$ = observable({ playing: false, ...defaults });`,
    ],
    ["repeated key", `const player$ = observable({ playing: false, playing: () => true });`],
    ["mutable root", `let player$ = observable({ playing: false });`],
    ["mutable constant", `let IDLE = false; const player$ = observable({ playing: IDLE });`],
    [
      "computed constant",
      `const IDLE = Math.random() > 1; const player$ = observable({ playing: IDLE });`,
    ],
  ]) {
    assert.equal(unrendered(body, store), undefined, label);
  }
  for (const [label, store] of [
    [
      "plain sibling",
      `declare const WIDTH: number; const player$ = observable({ playing: false, width: WIDTH });`,
    ],
    ["module constant", `const IDLE = false; const player$ = observable({ playing: IDLE });`],
    [
      "negative number and nested object",
      `const player$ = observable({ playing: { value: -1 } });`,
    ],
  ]) {
    const path =
      label === "negative number and nested object"
        ? body.replace("player$.playing", "player$.playing.value")
        : body;
    assert.ok(unrendered(path, store), label);
  }
});

test("keeps same-named hooks that are not Legend State subscriptions", () => {
  const body = `const playing = useValue(player$.playing); return null;`;
  assert.equal(
    unrendered(body, player, header.replace('from "@legendapp/state/react"', 'from "other-state"')),
    undefined,
  );
});
