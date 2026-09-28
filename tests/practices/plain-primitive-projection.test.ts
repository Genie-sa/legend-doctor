import { assertVerifiedEdits, practiceFindings } from "./edit-assertions.js";
import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

const fixture = (
  body: string,
  source = 'observable<string>("a")',
  wrapper = '<Row trackId="a" />',
): string => `
import { observable } from "@legendapp/state";
import { observer, useValue } from "@legendapp/state/react";
import { memo, useEffect, useRef } from "react";
const active$ = ${source};
const state$ = observable({ selected: "a", other: 0 });
const TARGET = "b";
function Row({ trackId }: { trackId: string }) {
  ${body}
}
export function App() { return ${wrapper}; }
`;
const findings = (source: string): LegendPracticeFinding[] =>
  practiceFindings(source, "select-primitive-projection");
const body =
  "const id = useValue(active$); const selected = id === trackId; return <div data-selected={selected} />;";

test("merges a sole named comparison into the selector", () => {
  const [finding, ...rest] = findings(fixture(body));
  assert.equal(rest.length, 0);
  assert.equal(finding?.disposition, "change");
  assert.equal(finding?.confidence, "certain");
  assert.match(
    finding?.message ?? "",
    /^Replace `const id = useValue\(active\$\)` with `const selected = useValue\(\(\) => active\$\.get\(\) === trackId\)` and delete `const selected = id === trackId`\. Row then renders only when the comparison flips/u,
  );
});

test("quotes the selector hook the source already calls", () => {
  for (const [importLine, hook] of [
    ["{ observer, use$ }", "use$"],
    ["{ observer, useSelector as select }", "select"],
  ] as const) {
    const source = fixture(body.replace("useValue(active$)", `${hook}(active$)`)).replace(
      "{ observer, useValue }",
      importLine,
    );
    const [finding] = findings(source);
    assert.ok(
      finding?.message.includes(`\`const selected = ${hook}(() => active$.get() === trackId)\``),
      hook,
    );
  }
});

for (const [name, source, selector] of [
  [
    "reversed operands",
    fixture(body.replace("id === trackId", "trackId === id")),
    "trackId === active$.get()",
  ],
  [
    "inequality",
    fixture(body.replace("id === trackId", "id !== trackId")),
    "active$.get() !== trackId",
  ],
  [
    "literal operand",
    fixture(body.replace("id === trackId", 'id === "b"')),
    'active$.get() === "b"',
  ],
  [
    "module constant",
    fixture(body.replace("id === trackId", "id === TARGET")),
    "active$.get() === TARGET",
  ],
  [
    "earlier owner const",
    fixture(
      body
        .replace("const id", "const key = trackId.trim(); const id")
        .replace("id === trackId", "id === key"),
    ),
    "active$.get() === key",
  ],
  [
    "numeric domain",
    fixture(body.replace("id === trackId", "id !== 10"), "observable<number>(0)"),
    "active$.get() !== 10",
  ],
  ["nullable domain", fixture(body, 'observable<string | null>("a")'), "active$.get() === trackId"],
  [
    "property path",
    fixture(body.replace("useValue(active$)", "useValue(state$.selected)")),
    "state$.selected.get() === trackId",
  ],
  [
    "exported owner",
    fixture(body).replace("function Row", "export function Row"),
    "active$.get() === trackId",
  ],
  ["memo wrapper", `${fixture(body)}const Memoized = memo(Row);`, "active$.get() === trackId"],
  ["custom child", fixture(body.replace("<div", "<Child")), "active$.get() === trackId"],
  [
    "event read of the boolean",
    fixture(body.replace("data-selected={selected}", "onClick={() => selected}")),
    "active$.get() === trackId",
  ],
  [
    "optional prop",
    fixture(body).replace("trackId: string", "trackId?: string"),
    "active$.get() === trackId",
  ],
  [
    "ref write on the equal side",
    fixture(
      body.replace(
        "return <div",
        "const ref = useRef(0); if (selected) { ref.current = 1; } return <div",
      ),
    ),
    "active$.get() === trackId",
  ],
] as const) {
  test(`selects the projection across ${name}`, () => {
    const [finding, ...rest] = findings(source);
    assert.equal(rest.length, 0);
    assert.ok(finding?.message.includes(selector), finding?.message);
  });
}

for (const [name, source] of Object.entries({
  helperOperand: fixture(body.replace("id === trackId", "id === hidden()")),
  laterOperand: fixture(
    body
      .replace("const selected", "const key = trackId; const selected")
      .replace("id === trackId", "id === key"),
  ),
  reassignedOperand: fixture(
    body
      .replace("const id", 'let key = trackId; key += "!"; const id')
      .replace("id === trackId", "id === key"),
  ),
  eventRead: fixture(body.replace("return <div", "const onClick = () => id; return <div")),
  effectDependency: fixture(
    body.replace("return <div", "useEffect(() => log(id), [id]); return <div"),
  ),
  everyRenderEffect: fixture(
    body.replace("return <div", "useEffect(() => log(selected)); return <div"),
  ),
  options: fixture(body.replace("useValue(active$)", "useValue(active$, { suspense: true })")),
  alreadySelected: fixture(
    body.replace("useValue(active$)", "useValue(() => active$.get() === trackId)"),
  ),
  booleanDomain: fixture(body, "observable<boolean>(false)"),
  twoLiteralDomain: fixture(body, 'observable<"a" | "b">("a")'),
  constAssertion: fixture(body, 'observable("a" as const)'),
  fakeFactory: fixture(body, 'fakeObservable("a")'),
  injective: fixture(body.replace("id === trackId", 'id + "!"')),
  looseComparison: fixture(body.replace("id === trackId", "id == trackId")),
  mixedOperands: fixture(body.replace("id === trackId", 'id === trackId || id === "b"')),
  mixedOperators: fixture(body.replace("id === trackId", "id === trackId && !(id !== trackId)")),
  rawSnapshot: fixture(body.replace("data-selected={selected}", "data-selected={id}")),
  unreadComparison: fixture(body.replace("data-selected={selected}", "")),
  shadowedSource: fixture(body.replace("const id", "const active$ = fake; const id")),
  observerWrapped: `${fixture(body)}const Tracked = observer(Row);`,
  asyncOwner: fixture(body).replace("function Row", "async function Row"),
  generatorOwner: fixture(body).replace("function Row", "function* Row"),
  lowercaseOwner: fixture(body).replaceAll("Row", "row"),
  unimportedNamespace: fixture(body.replace("useValue(active$)", "Legend.useValue(active$)")),
  overlappingSubscription: fixture(
    body
      .replace("useValue(active$)", "useValue(state$.selected)")
      .replace("const selected", "const whole = useValue(state$); const selected")
      .replace("data-selected={selected}", "data-selected={selected} title={String(whole.other)}"),
  ),
  refRead: fixture(
    body.replace("return <div", "const ref = useRef(0); return <div title={String(ref.current)}"),
  ),
  peekRead: fixture(
    body.replace("data-selected={selected}", "data-selected={selected} title={active$.peek()}"),
  ),
  refReadOnUnequalSide: fixture(
    body.replace(
      "return <div",
      "const ref = useRef(0); if (!selected) { ref.current = 1; } return <div",
    ),
  ),
  customHook: fixture(
    body
      .replace("const id", "const theme = useTheme(); const id")
      .replace("<div", "<div className={theme}"),
  ),
  localContextRead: fixture(body.replace("const id", "const theme = useContext(Theme); const id"))
    .replace(
      "{ memo, useEffect, useRef }",
      "{ createContext, memo, useContext, useEffect, useRef }",
    )
    .replace("const TARGET", 'const Theme = createContext("dark");\nconst TARGET'),
})) {
  test(`projection abstains on ${name}`, () => assert.deepEqual(findings(source), []));
}

test("guards on the equal side prove nothing for object domains", () => {
  const source = fixture(
    "const item = useValue(active$); const ref = useRef(0); const current = item === pinned; if (current) { ref.current = 1; } return <div data-current={current} />;",
    "observable<{ id: string } | null>(null)",
  ).replace("{ trackId }: { trackId: string }", "{ pinned }: { pinned: { id: string } }");
  assert.deepEqual(findings(source), []);
});

test("only the Legend v2 gate disables the projection", () => {
  for (const [version, useValueExport, expected] of [
    ["2.1.15", "alias", 0],
    ["3.0.0-beta.48", "missing", 1],
    ["next", "unknown", 1],
    ["3.0.0-beta.48", "alias", 1],
  ] as const) {
    const result = analyzeLegendPractices({
      fileName: "fixture.tsx",
      installedLegendState: {
        source: "installed",
        syncExport: "available",
        useValueExport,
        version,
      },
      sourceText: fixture(body),
    }).filter((finding) => finding.action === "select-primitive-projection");
    assert.equal(result.length, expected, version);
  }
});

test("merged edits replace the raw subscription and delete the comparison", () => {
  const source = `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

const active$ = observable<string>("a");

export function Row({ trackId }: { trackId: string }) {
  const id = useValue(active$);
  const selected = id === trackId;
  return <div data-selected={selected} />;
}
`;
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

const active$ = observable<string>("a");

export function Row({ trackId }: { trackId: string }) {
  const selected = useValue(() => active$.get() === trackId);
  return <div data-selected={selected} />;
}
`,
    findings(source),
  );
});

test("fresh-name edits replace every comparison site", () => {
  const source = `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

interface Track {
  id: string;
}

const active$ = observable<string>("a");
const dragged$ = observable<Track | null>(null);

export function Zone({ id }: { id: string }) {
  const active = useValue(active$);
  const dragged = useValue(dragged$);
  const isActive = dragged !== null && active === id;
  return <div className={active === id ? "on" : "off"} data-active={isActive} />;
}
`;
  const result = findings(source);
  assert.equal(result.length, 2);
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

interface Track {
  id: string;
}

const active$ = observable<string>("a");
const dragged$ = observable<Track | null>(null);

export function Zone({ id }: { id: string }) {
  const activeMatches = useValue(() => active$.get() === id);
  const hasDragged = useValue(() => dragged$.get() !== null);
  const isActive = hasDragged && activeMatches;
  return <div className={activeMatches ? "on" : "off"} data-active={isActive} />;
}
`,
    result,
  );
});

test("keeps the finding but withholds edits that would delete a comment", () => {
  const source = fixture(body.replace("const selected", "// selection\n  const selected"));
  const [finding] = findings(source);
  assert.ok(finding);
  assert.equal(finding.edits, undefined);
});

test("withholds a fresh name the file already uses", () => {
  const source = fixture(
    "const id = useValue(active$); const idMatches = 1; return <div data-a={id === trackId} data-b={id === trackId} data-c={idMatches} />;",
  );
  assert.deepEqual(findings(source), []);
});
