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

test("snapshots compare-and-set guards whose write Legend drops on an unchanged value", () => {
  const finding = requireValue(
    unrendered(`
      const zone = useValue(player$.title);
      const hover = (next: string | null, inside: boolean) => {
        if (zone !== next) player$.title.set(next);
        if (!inside && zone !== null) {
          player$.title.set(null);
        }
      };
      return <Zones resolve={hover} />;
    `),
  );
  assert.match(finding.message, /replace its 2 non-render reads/u);
  assert.match(finding.message, /`player\$\.title\.peek\(\)`/u);
  assert.ok(
    unrendered(`
      const zone = useValue(player$.title);
      return <button onClick={() => { if ("a" !== zone) player$.title.set("a"); }}>go</button>;
    `),
    "inline handler",
  );
});

test("keeps guards that do more than drop an identical write", () => {
  for (const [label, guard] of [
    ["else branch", `if (zone !== next) player$.title.set(next); else log(next);`],
    ["second statement", `if (zone !== next) { player$.title.set(next); log(next); }`],
    ["different value", `if (zone !== next) player$.title.set("other");`],
    ["different observable", `if (zone !== next) player$.index.set(next);`],
    ["later condition", `if (zone !== next && Math.random() > 0.5) player$.title.set(next);`],
    ["equality guard", `if (zone === next) player$.title.set(null);`],
    ["loose inequality", `if (zone != next) player$.title.set(next);`],
    ["computed operand", `if (zone !== next.trim()) player$.title.set(next.trim());`],
    ["value written", `if (zone !== next) player$.title.set(zone);`],
  ] as const) {
    assert.equal(
      unrendered(`
        const zone = useValue(player$.title);
        const hover = (next: string) => { ${guard} };
        return <Zones resolve={hover} />;
      `),
      undefined,
      label,
    );
  }
  for (const [label, callback] of [
    [
      "memoized closure",
      `useCallback((next: string) => { if (zone !== next) player$.title.set(next); }, [])`,
    ],
    [
      "async callback",
      `async (next: string) => { await log(next); if (zone !== next) player$.title.set(next); }`,
    ],
    [
      "deferred callback",
      `(next: string) => setTimeout(() => { if (zone !== next) player$.title.set(next); })`,
    ],
  ] as const) {
    assert.equal(
      unrendered(`
        const zone = useValue(player$.title);
        const hover = ${callback};
        return <Zones resolve={hover} />;
      `),
      undefined,
      label,
    );
  }
});

test("snapshots the initializer of a binding nothing reads", () => {
  const finding = requireValue(
    unrendered(`
      const tracks = useValue(player$.tracks);
      const _first = Object.values(tracks).find((track) => track !== null);
      return <p>idle</p>;
    `),
  );
  assert.match(finding.message, /replace its 1 non-render read/u);
});

test("keeps initializers whose binding or effects outlive the render", () => {
  for (const [label, body] of [
    ["read binding", `const first = Object.values(tracks)[0]; return <p>{String(first)}</p>;`],
    [
      "callback read",
      `const first = tracks; return <button onClick={() => log(first)}>go</button>;`,
    ],
    ["mutable binding", `let first = tracks; return <p>idle</p>;`],
    ["conditional binding", `if (Math.random()) { const first = tracks; } return <p>idle</p>;`],
    [
      "assignment",
      `const ref = useRef<unknown>(null); const first = (ref.current = tracks); return <p>idle</p>;`,
    ],
    ["nested closure", `const read = () => tracks; return <p>idle</p>;`],
  ] as const) {
    assert.equal(unrendered(`const tracks = useValue(player$.tracks);\n${body}`), undefined, label);
  }
});
