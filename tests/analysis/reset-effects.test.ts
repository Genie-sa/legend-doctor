import { actions, requireValue } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

test("keeps a same-owner reset effect behind an opaque controlled component", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Browser() {
        const [category, setCategory] = useState("all");
        const [detailIndex, setDetailIndex] = useState(0);
        useEffect(() => setDetailIndex(0), [category]);
        return <main>
          <Filter onChange={setCategory} />
          <button onClick={() => setDetailIndex(value => value + 1)}>{detailIndex}</button>
        </main>;
      }
    `),
    ["review-state", "keep-state", "review-effect"],
  );
});

test("does not move reset effects into opaque custom-component callbacks", () => {
  for (const mutation of [
    `<Controller onRender={setCategory} />`,
    `<Controller onMount={() => setCategory("next")} />`,
    `<Controller onChange={setCategory} />`,
  ]) {
    assert.deepEqual(
      actions(`
        import { useEffect, useState } from "react";
        export function Browser() {
          const [category, setCategory] = useState("all");
          const [detailIndex, setDetailIndex] = useState(0);
          useEffect(() => setDetailIndex(0), [category]);
          return <main>
            ${mutation}
            <button onClick={() => setDetailIndex(value => value + 1)}>{detailIndex}</button>
          </main>;
        }
      `),
      ["review-state", "keep-state", "review-effect"],
      mutation,
    );
  }
});

test("moves reset effects into intrinsic event callbacks", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Browser() {
        const [category, setCategory] = useState("all");
        const [detailIndex, setDetailIndex] = useState(0);
        useEffect(() => setDetailIndex(0), [category]);
        return <main>
          <button onClick={() => setCategory("next")}>Next category</button>
          <button onClick={() => setDetailIndex(value => value + 1)}>{detailIndex}</button>
        </main>;
      }
    `),
    ["review-state", "keep-state", "move-to-event"],
  );
});

test("does not move reset effects whose initializer evaluation is not stable", () => {
  for (const reset of ["nextPage()", "{}", "[]"]) {
    const findings = analyzeSource(
      `
        import { useEffect, useState } from "react";
        export function Browser() {
          const [category, setCategory] = useState("all");
          const [page, setPage] = useState(${reset});
          useEffect(() => setPage(${reset}), [category]);
          return <main>
            <button onClick={() => setCategory("next")}>Next category</button>
            <button onClick={() => setPage(${reset})}>Next page</button>
          </main>;
        }
      `,
      "fixture.tsx",
    );
    assert.equal(
      requireValue(findings.find((finding) => finding.hook === "useEffect")).action,
      "review-effect",
      reset,
    );
  }
});

test("does not move a reset effect when a dependency mutation boundary is external", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Browser({ category }: { category: string }) {
        const [detailIndex, setDetailIndex] = useState(0);
        useEffect(() => setDetailIndex(0), [category]);
        return <button onClick={() => setDetailIndex(value => value + 1)}>{detailIndex}</button>;
      }
    `),
    ["keep-state", "keep-effect"],
  );
});

test("keeps an expression-bodied external subscription as lifecycle ownership", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      export function Bridge({ source }: { source: { subscribe: (fn: () => void) => () => void } }) {
        useEffect(() => source.subscribe(() => refresh()), [source]);
        return null;
      }
    `),
    ["keep-effect"],
  );
});

test("does not mistake an expression-bodied React setter for cleanup", () => {
  assert.deepEqual(
    actions(`
      import { useEffect, useState } from "react";
      export function Results({ query }: { query: string }) {
        const [page, setPage] = useState(1);
        useEffect(() => setPage(1), [query]);
        return <Pager page={page} onChange={setPage} />;
      }
    `),
    ["review-state", "review-effect"],
  );
});

test("does not mistake an arbitrary expression-bodied callback call for cleanup", () => {
  const [finding] = analyzeSource(
    `
      import { useEffect } from "react";
      export function Reporter({ result }: { result: unknown }) {
        useEffect(() => onResult(result), [result]);
        return null;
      }
    `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "keep-effect");
  assert.doesNotMatch(requireValue(finding).message, /cleanup|lifecycle/u);
});

test("keeps an effect with paired cleanup", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      export function Online() {
        useEffect(() => {
          window.addEventListener("online", onOnline);
          return () => window.removeEventListener("online", onOnline);
        }, []);
        return null;
      }
    `),
    ["keep-effect"],
  );
});
