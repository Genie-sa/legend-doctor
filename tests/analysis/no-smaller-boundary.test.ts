import type { HookFinding } from "../../src/core/types.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview /><Nav />";

const NO_SMALLER_BOUNDARY = /no smaller subscriber removes a render/u;

function query(setup: string, extra = ""): HookFinding {
  const source = `
    import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
    export function Panel({ rows }: { rows: string[] }) {
      const [query, setQuery] = useState("");
      ${setup}
      return <main>${CHROME}
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
        <p>{query.length} characters</p>
        <span>{query ? "dirty" : "clean"}</span>
        ${extra}
      </main>;
    }
  `;
  return requireValue(
    analyzeSource(source, "src/panel.tsx").find((finding) => finding.name === "query"),
  );
}

function name(activeBranch: string): HookFinding {
  const source = `
    import { useState } from "react";
    export function Wizard({ done }: { done: boolean }) {
      const [name, setName] = useState("");
      if (done) {
        return <section>${CHROME}</section>;
      }
      return ${activeBranch};
    }
  `;
  return requireValue(
    analyzeSource(source, "src/wizard.tsx").find((finding) => finding.name === "name"),
  );
}

test("a state that selects the owner's early return keeps React state", () => {
  const found = query(`if (query === "reset") return <Empty />;`);
  assert.equal(found.action, "keep-state");
  assert.equal(found.assumption, undefined);
  assert.match(found.message, /selects the owner's early return/u);
});

test("a state feeding owner-level hooks whose result the owner renders keeps React state", () => {
  const owners = {
    dataHook: query(`const { data } = useSearch(query);`, `<Results data={data} />`),
    deferred: query(
      `const deferredQuery = useDeferredValue(query);`,
      `<Results query={deferredQuery} />`,
    ),
    memo: query(
      `const matches = useMemo(() => rows.filter((row) => row.includes(query)), [rows, query]);`,
      `<ul>{matches.map((row) => <li key={row}>{row}</li>)}</ul>`,
    ),
  };
  for (const [hookInput, found] of Object.entries(owners)) {
    assert.equal(found.action, "keep-state", hookInput);
    assert.equal(found.assumption, undefined, hookInput);
    assert.match(
      found.message,
      /feeds an owner-level hook whose result the owner renders/u,
      hookInput,
    );
  }
});

test("hook inputs that never reach rendered output leave the finding to the subscriber analysis", () => {
  const owners = {
    callbackDependency: query(
      `const save = useCallback(() => persist(query), [query]);`,
      `<button onClick={save}>Save</button>`,
    ),
    effectOnlyMemo: query(
      `const trimmed = useMemo(() => query.trim(), [query]); useEffect(() => { log(trimmed); }, [trimmed]);`,
    ),
    stateInitializer: query(`const [draft] = useState(query);`, `<Draft value={draft} />`),
    unrenderedHookResult: query(`useSearch(query);`),
  };
  for (const [hookInput, found] of Object.entries(owners)) {
    assert.notEqual(found.action, "keep-state", hookInput);
    assert.doesNotMatch(found.message, NO_SMALLER_BOUNDARY, hookInput);
  }
});

test("settles a chain of derived values that each read the previous one twice in linear time", () => {
  const chain = Array.from(
    { length: 40 },
    (_level, index) => `const level${index + 1} = level${index} + level${index};`,
  ).join("\n");
  const unrendered = query(`const level0 = useDeferredValue(query);\n${chain}`);
  assert.doesNotMatch(unrendered.message, NO_SMALLER_BOUNDARY);
  const rendered = query(`const level0 = useDeferredValue(query);\n${chain}`, `<p>{level40}</p>`);
  assert.equal(rendered.action, "keep-state");
  assert.match(rendered.message, /feeds an owner-level hook whose result the owner renders/u);
});

test("a subtree is weighed against the return branch that renders it", () => {
  const wholeBranch = name(
    `<form><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} /><p>{name.length}</p><span>{name ? "dirty" : "clean"}</span></form>`,
  );
  assert.doesNotMatch(wholeBranch.message, /extract the <form> subtree/u);
  const smallLeaf = name(
    `<form>${CHROME}<fieldset><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} /><p>{name}</p></fieldset></form>`,
  );
  assert.equal(smallLeaf.action, "use-observable");
  assert.match(smallLeaf.message, /extract the <fieldset> subtree/u);
});
