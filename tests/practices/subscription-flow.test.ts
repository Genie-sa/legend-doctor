import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

function moves(setup: string, content: string, extra = ""): LegendPracticeFinding[] {
  return analyzeLegendPractices({
    fileName: "flow.tsx",
    sourceText: `
    import { useObservable, useValue } from "@legendapp/state/react";
    import { useMemo, useEffect, useCallback } from "react";
    export function Screen({ label }: { label: string }) {
      const state$ = useObservable({ count: 0, track: { title: "", artist: "" } });
      ${setup}
      ${extra}
      return <main><Header/><Toolbar/><Summary/><Filters/><List/><Footer/>
        <Aside/><Help/><Status/><Actions/><Search/>${content}</main>;
    }
  `,
  }).filter((finding) => finding.action === "move-use-value-down");
}

test("follows a defaulted value to all distant render consumers", () => {
  const result = moves(
    "const raw = useValue(state$.count); const bins = raw ?? 64;",
    "<output>{bins}</output><input value={String(bins)} />",
  );
  assert.equal(result.length, 1);
  assert.match(result[0]!.message, /bins/u);
  assert.match(result[0]!.message, /2 separate child/u);
});

test("moves a memoized primitive derivation together with its source subscription", () => {
  const result = moves(
    `const artist = useValue(state$.track.artist);
    const subtitle = useMemo(() => {
      if (!artist) return "";
      const parts: string[] = [];
      if (artist) parts.push(artist);
      return parts.join(" • ");
    }, [artist]);`,
    "<section>{subtitle ? <p>{subtitle}</p> : null}</section>",
  );
  assert.equal(result.length, 1);
  assert.match(result[0]!.message, /subtitle/u);
  assert.match(result[0]!.message, /useMemo/u);
});

test("derivations cannot hide event snapshots, mutations, external calls, or incomplete memo inputs", () => {
  for (const [setup, content, extra] of [
    [
      "const raw = useValue(state$.count); const bins = raw ?? 64;",
      "<button onClick={() => bins}/>",
      "",
    ],
    ["const raw = useValue(state$.count); let bins = raw;", "<output>{bins}</output>", "bins++;"],
    [
      "const raw = useValue(state$.count); const bins = transform(raw);",
      "<output>{bins}</output>",
      "",
    ],
    [
      "const raw = useValue(state$.count); const bins = useMemo(() => raw, []);",
      "<output>{bins}</output>",
      "",
    ],
    [
      "const raw = useValue(state$.count); const bins = useMemo(() => { shared.push(raw); return shared.join(); }, [raw]);",
      "<output>{bins}</output>",
      "",
    ],
    [
      "const raw = useValue(state$.count); const bins = raw ?? 64;",
      "<output>{bins}</output>",
      "useEffect(() => publish(bins), [bins]);",
    ],
    [
      "const raw = useValue(state$.count); const bins = raw ?? 64;",
      "<output>{String(bins)}</output>",
      "const String = convert;",
    ],
  ]) {
    assert.equal(moves(setup!, content!, extra!).length, 0, setup);
  }
});

test("preserves dependency-stable effects without admitting every-commit or unstable effects", () => {
  const setup = "const raw = useValue(state$.count);";
  const content = "<output>{raw}</output>";
  assert.equal(moves(setup, content, "useEffect(() => publish(label), [label]);").length, 1);
  assert.equal(moves(setup, content, "useEffect(() => publish(label));").length, 0);
  assert.equal(moves(setup, content, "useEffect(() => publish(label), [{ label }]);").length, 0);
});

test("an unrelated memo cannot hide an imperative snapshot during a multi-child cut", () => {
  const findings = moves(
    "const stored = useValue(state$.count); const bins = stored ?? 64; const snapshot = useMemo(() => clock.read());",
    "<output>{bins}</output><input value={String(bins)}/><output>{snapshot}</output>",
  );
  assert.equal(findings.length, 0);
});

test("single-child cuts also preserve unrelated memos that recompute every render", () => {
  for (const dependencies of ["", ", [{}]"]) {
    assert.equal(
      moves(
        `const stored = useValue(state$.count); const bins = stored ?? 64; const snapshot = useMemo(() => clock.read()${dependencies});`,
        "<output>{bins}</output><output>{snapshot}</output>",
      ).length,
      0,
    );
  }
});

test("does not duplicate getter-based derivations into separate children", () => {
  const result = analyzeLegendPractices({
    fileName: "getter.tsx",
    sourceText: `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      let reads = 0;
      const state$ = observable({ track: { get title() { return String(++reads); } } });
      export function Screen() {
        const track = useValue(state$.track);
        const title = track ? track.title : "";
        return <main><Header/><Toolbar/><Summary/><Filters/><List/><Footer/>
          <Aside/><Help/><Status/><Actions/><Search/><h1>{title}</h1><h2>{title}</h2></main>;
      }
    `,
  });
  assert.ok(result.every((finding) => finding.action !== "move-use-value-down"));
});

for (const read of ["Date.now()", "clock.read()"]) {
  test(`a single subscription child preserves the owner's ${read} snapshot`, () => {
    assert.equal(
      moves(
        `const raw = useValue(state$.count); const bins = raw ?? 64; const time = ${read};`,
        "<output>{time}</output><h1>{bins}</h1>",
      ).length,
      0,
    );
  });
}

test("retains a cached snapshot owned by an independent subscription", () => {
  assert.equal(
    moves(
      `const raw = useValue(state$.count); const bins = raw ?? 64;
     const artist = useValue(state$.track.artist);
     const cached = useMemo(() => clock.read(), [artist]);`,
      "<output>{cached}</output><h1>{bins}</h1>",
    ).length,
    1,
  );
});

test("retains independent deferred callbacks inside rendered JSX aliases", () => {
  assert.equal(
    moves(
      `const raw = useValue(state$.count); const bins = raw ?? 64;
     const handler = useCallback(() => clock.read(), []);
     const pane = <button onClick={handler}/>;`,
      "{pane}<h1>{bins}</h1>",
    ).length,
    1,
  );
});

test("does not treat an unstable callback dependency as cached render work", () => {
  assert.equal(
    moves(
      `const raw = useValue(state$.count); const bins = raw ?? 64;
     const handler = useCallback(() => act(), [clock.read()]);
     const pane = <button onClick={handler}/>;`,
      "{pane}<h1>{bins}</h1>",
    ).length,
    0,
  );
});

test("a selector hook cannot hide a fresh imperative snapshot", () => {
  assert.equal(
    moves(
      `const raw = useValue(state$.count); const bins = raw ?? 64;
     const time = useValue(() => clock.read());`,
      "<output>{time}</output><h1>{bins}</h1>",
    ).length,
    0,
  );
});

test("a cached callback cannot hide eagerly evaluated factory work", () => {
  assert.equal(
    moves(
      `const raw = useValue(state$.count); const bins = raw ?? 64;
     const handler = useCallback(clock.read(), []);
     const pane = <button onClick={handler}/>;`,
      "{pane}<h1>{bins}</h1>",
    ).length,
    0,
  );
});
