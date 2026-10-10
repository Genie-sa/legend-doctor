import type { HookFinding } from "../../src/core/types.js";
import { analyzeSourceWith } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("a reset keyed by props with primitive or module defaults is a change", () => {
  const finding = analyzeSourceWith(
    `
      import { useEffect, useState } from "react";
      const PAGE_SIZE = 25;
      export function List({ open = false, pageSize = PAGE_SIZE, label = "rows" }) {
        const [draft, setDraft] = useState("");
        useEffect(() => setDraft(""), [open, pageSize, label]);
        return <input value={draft} onChange={(event) => setDraft(event.target.value)} />;
      }
    `,
    "fixture.tsx",
    { confirmations: null },
  ).find((result) => result.hook === "useEffect");
  assert.equal(requireValue(finding).action, "reset-during-render");
});

for (const parameters of ["props", "{ ref, ...props }"]) {
  test(`a reset keyed by fields destructured from ${parameters} or a local alias of a module value is a change`, () => {
    const finding = analyzeSourceWith(
      `
        import { useEffect, useState } from "react";
        import { CONST } from "./const";
        const PAGE_SIZE = 25;
        export function List(${parameters}) {
          const { tab = CONST.TAB.ALL, expanded } = props;
          const pageSize = PAGE_SIZE;
          const [draft, setDraft] = useState("");
          useEffect(() => setDraft(""), [tab, expanded, pageSize]);
          return <input value={draft} onChange={(event) => setDraft(event.target.value)} />;
        }
      `,
      "fixture.tsx",
      { confirmations: null },
    ).find((result) => result.hook === "useEffect");
    assert.equal(requireValue(finding).action, "reset-during-render");
  });
}

for (const [label, prelude, dependency] of [
  ["a body destructure with a rebuilt default", "const { sort = [] } = props;", "sort"],
  ["a destructure of a local copy of the props", "let copy = props; const { tab } = copy;", "tab"],
  [
    "a local alias of a hook result",
    "const selection = useSelection(); const tab = selection;",
    "tab",
  ],
] as const) {
  test(`a reset keyed by ${label} asks about its identity`, () => {
    const finding = analyzeSourceWith(
      `
        import { useEffect, useState } from "react";
        export function List(props) {
          ${prelude}
          const [draft, setDraft] = useState("");
          useEffect(() => setDraft(""), [${dependency}]);
          return <input value={draft} onChange={(event) => setDraft(event.target.value)} />;
        }
      `,
      "fixture.tsx",
      { confirmations: null },
    ).find((result) => result.hook === "useEffect");
    assert.equal(requireValue(finding).abstentionReason, "dependency-identity-unproven");
  });
}

function memoResetEffect(memo: string): HookFinding {
  return requireValue(
    analyzeSourceWith(
      `
        import { useEffect, useMemo, useState } from "react";
        const NAMES = { all: "all", mine: "mine" } as const;
        export function List({ rows, query, mine }) {
          const key = useMemo(${memo}, [rows, query, mine]);
          const [draft, setDraft] = useState("");
          useEffect(() => setDraft(""), [key]);
          return <input value={draft} onChange={(event) => setDraft(event.target.value)} />;
        }
      `,
      "fixture.tsx",
      { confirmations: null },
    ).find((result) => result.hook === "useEffect"),
  );
}

for (const [label, memo] of [
  ["primitives", '() => { if (!rows.length) return ""; return query + ":" + rows.length; }'],
  ["module constants", '() => (mine ? NAMES["mine"] : NAMES.all)'],
] as const) {
  test(`a reset keyed by a memo of ${label} is a change, since its value compares equal`, () => {
    assert.equal(memoResetEffect(memo).action, "reset-during-render");
  });
}

for (const [label, memo] of [
  ["a filtered array", "() => rows.filter(Boolean)"],
  ["a prop object", "() => rows"],
  ["an unknown call", "() => format(query)"],
  ["a value from a nested callback", '() => { const pick = () => { return "a"; }; return rows; }'],
] as const) {
  test(`a reset keyed by a memo of ${label} asks about its identity`, () => {
    assert.equal(memoResetEffect(memo).abstentionReason, "dependency-identity-unproven");
  });
}

interface HookResetCase {
  readonly dependencies: string;
  readonly prelude?: string;
  readonly signature: string;
  readonly types?: string;
}

function hookResetEffect({
  dependencies,
  prelude = "",
  signature,
  types = "",
}: HookResetCase): HookFinding {
  return requireValue(
    analyzeSourceWith(
      `
        import { useEffect, useState } from "react";
        import type { RemoteOptions } from "./remote";
        ${types}
        export function ${signature} {
          ${prelude}
          const [draft, setDraft] = useState("");
          useEffect(() => setDraft(""), [${dependencies}]);
          return [draft, setDraft];
        }
      `,
      "fixture.ts",
      { confirmations: null },
    ).find((result) => result.hook === "useEffect"),
  );
}

for (const [label, hookCase] of [
  ["a string parameter", { dependencies: "id", signature: "useDraft(id: string)" }],
  [
    "an optional literal union parameter",
    { dependencies: "mode", signature: 'useDraft(mode?: "edit" | "view" | null)' },
  ],
  [
    "an option declared by a local interface",
    {
      dependencies: "open, tab",
      signature: "useDraft({ open, tab }: Options)",
      types: 'interface Options { open: boolean; tab?: "all" | "mine" }',
    },
  ],
  [
    "an option path declared by a local type alias",
    {
      dependencies: "options.open, options?.filter.scope",
      signature: "useDraft(options: Options)",
      types: "type Options = { open: boolean; filter: { scope: string } };",
    },
  ],
  [
    "a field destructured from a typed parameter",
    {
      dependencies: "id",
      prelude: "const { id } = options;",
      signature: "useDraft(options: { id: string })",
    },
  ],
] as const satisfies readonly (readonly [string, HookResetCase])[]) {
  test(`a custom hook reset keyed by ${label} is a change, since equal primitives compare equal`, () => {
    assert.equal(hookResetEffect(hookCase).action, "reset-during-render");
  });
}

for (const [label, hookCase] of [
  [
    "a number parameter, which can be NaN",
    { dependencies: "index", signature: "useDraft(index: number)" },
  ],
  [
    "an object parameter",
    { dependencies: "options", signature: "useDraft(options: { id: string })" },
  ],
  [
    "a generic parameter",
    { dependencies: "value", signature: "useDraft<T extends string>(value: T)" },
  ],
  [
    "an imported option type",
    { dependencies: "open", signature: "useDraft({ open }: RemoteOptions)" },
  ],
  [
    "an option from an interface with a base",
    {
      dependencies: "open",
      signature: "useDraft({ open }: Options)",
      types: "interface Base { open: boolean } interface Options extends Base {}",
    },
  ],
  [
    "an option declared twice",
    {
      dependencies: "open",
      signature: "useDraft({ open }: Options)",
      types: "interface Options { open: boolean } interface Options { open: boolean }",
    },
  ],
  [
    "a field destructured from a reassignable binding",
    {
      dependencies: "id",
      prelude: "let source = options; const { id } = source;",
      signature: "useDraft(options: { id: string })",
    },
  ],
  ["an untyped parameter", { dependencies: "id", signature: "useDraft(id)" }],
] as const satisfies readonly (readonly [string, HookResetCase])[]) {
  test(`a custom hook reset keyed by ${label} asks about its identity`, () => {
    assert.equal(hookResetEffect(hookCase).abstentionReason, "dependency-identity-unproven");
  });
}
