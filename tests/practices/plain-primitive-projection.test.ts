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
import { useValue, observer } from "@legendapp/state/react";
const active$ = ${source};
function Row({ trackId }: { trackId: string }) {
  ${body}
}
export function App() { return ${wrapper}; }
`;
const findings = (source: string): LegendPracticeFinding[] =>
  analyzeLegendPractices({ sourceText: source, fileName: "fixture.tsx" }).filter(
    (finding) => finding.action === "select-primitive-projection",
  );
const body =
  "const id = useValue(active$); const selected = id === trackId; return <div data-selected={selected} />;";

test("rejects hidden helper tracking before introducing a plain projection rule", () => {
  const source = fixture(body.replace("id === trackId", "id === hidden()"));
  assert.deepEqual(findings(source), []);
});

test("selects a confined strict boolean projection in a private JSX component", () => {
  const result = findings(fixture(body));
  assert.equal(result.length, 1);
  assert.equal(result[0]?.disposition, "change");
  assert.match(result[0]?.message ?? "", /useValue\(\(\) => active\$\.get\(\) === trackId\)/u);
});

for (const [name, source] of Object.entries({
  helper: fixture(body.replace("id === trackId", "id === hidden()")),
  event: fixture(body.replace("return <div", "const onClick = () => id; return <div")),
  effect: fixture(body.replace("return <div", "useEffect(() => log(id), [id]); return <div")),
  projectedEffect: fixture(
    body.replace("return <div", "useEffect(() => log(selected)); return <div"),
  ),
  projectedEvent: fixture(body.replace("data-selected={selected}", "onClick={() => selected}")),
  getter: fixture(body.replace("id === trackId", "id === props.trackId")),
  options: fixture(body.replace("useValue(active$)", "useValue(active$, { suspense: true })")),
  selected: fixture(body.replace("useValue(active$)", "useValue(() => active$.get() === trackId)")),
  booleanDomain: fixture(body, "observable<boolean>(false)"),
  literalDomain: fixture(body, 'observable<"a" | "b">("a")'),
  assertion: fixture(body, 'observable("a" as const)'),
  fake: fixture(body, 'fakeObservable("a")'),
  injective: fixture(body.replace("id === trackId", 'id + "!"')),
  loose: fixture(body.replace("id === trackId", "id == trackId")),
  observer: fixture(body, undefined, "observer(Row)"),
  alias: `${fixture(body)}const Wrapped = observer(Row);`,
  exported: fixture(body).replace("function Row", "export function Row"),
  shadow: fixture(body.replace("const id", "const active$ = fake; const id")),
  unused: fixture(body.replace("data-selected={selected}", "")),
  conditional: fixture(body.replace("const id", "if (!trackId) return null; const id")),
})) {
  test(`plain projection abstains on ${name}`, () => assert.deepEqual(findings(source), []));
}

for (const [source, comparison] of [
  ["observable<number>(0)", "id !== 10"],
  ['observable("a")', 'id === "b"'],
]) {
  test(`strict scalar subset accepts ${comparison}`, () => {
    const input = fixture(body.replace("id === trackId", comparison!), source);
    assert.equal(findings(input).length, 1);
  });
}

test("parameter defaults and intrinsic JSX names cannot prove a render cut", () => {
  for (const source of [
    fixture(body).replace("{ trackId }:", "{ trackId = hidden() }:"),
    fixture(body).replaceAll("Row", "row"),
    fixture(body).replace("data-selected={selected}", 'selected="constant"'),
    fixture(body).replace("data-selected={selected}", "{...selected}"),
  ]) {
    assert.deepEqual(findings(source), []);
  }
});

test("rejects all parameter work, key/ref, namespaces, and explicit alternate JSX runtimes", () => {
  const sources = [
    fixture(body).replace("{ trackId }:", "{ trackId, extra = hidden() }:"),
    fixture(body).replace("{ trackId }:", "{ trackId, ...rest }:"),
    fixture(body).replace("{ trackId }:", "{ trackId, [hidden()]: extra }:"),
    fixture(body).replace("data-selected", "key"),
    fixture(body).replace("data-selected", "ref"),
    fixture(body).replace("<div", "<svg:path"),
    fixture(body).replace("useValue(active$)", "Legend.useValue(active$)"),
    `/** @jsxImportSource preact */\n${fixture(body)}`,
    `/** @jsx custom */\n${fixture(body)}`,
  ];
  for (const source of sources) {
    assert.deepEqual(findings(source), []);
  }
});

test("replacement preserves an aliased hook and never calls an unrelated useValue binding", () => {
  const aliased = fixture(body)
    .replace("{ useValue, observer }", "{ useValue as useSelected, observer }")
    .replace("useValue(active$)", "useSelected(active$)");
  for (const source of [
    aliased,
    `${aliased}\nfunction useValue() { throw new Error("unrelated"); }`,
  ]) {
    const [finding] = findings(source);
    assert.ok(finding);
    assert.match(
      finding.message,
      /const selected = useSelected\(\(\) => active\$\.get\(\) === trackId\)/u,
    );
    assert.doesNotMatch(finding.message, / = useValue\(/u);
  }
});

for (const [name, source] of Object.entries({
  rawReexport: `${fixture(body)}\nexport { Row };`,
  componentAlias: `${fixture(body)}\nconst Alias = Row;`,
  reactMemo: `${fixture(body)}\nconst Memoized = memo(Row);`,
  asyncOwner: fixture(body).replace("function Row", "async function Row"),
  hookShadow: fixture(body).replace("{ trackId }:", "{ trackId, useValue }:"),
  sourceShadow: fixture(body).replace("{ trackId }:", "{ trackId, active$ }:"),
  literalProp: fixture(body).replace("trackId: string", 'trackId: "a" | "b"'),
  optionalProp: fixture(body).replace("trackId: string", "trackId?: string"),
  unknownProp: fixture(body).replace("trackId: string", "trackId: unknown"),
  untypedProp: fixture(body).replace(": { trackId: string }", ""),
  parameterDefault: fixture(body).replace(
    "{ trackId: string })",
    "{ trackId: string } = readProps())",
  ),
  restParameter: fixture(body).replace("{ trackId }: { trackId: string }", "...props: unknown[]"),
  propertyPath: fixture(body).replace("useValue(active$)", "useValue(active$.id)"),
  arrayDomain: fixture(body, 'observable(["a"])'),
  promiseDomain: fixture(body, 'observable(Promise.resolve("a"))'),
  nullableDomain: fixture(body, 'observable<string | null>("a")'),
  helperInitializer: fixture(body, "observable(initialId())"),
  thrownProjection: fixture(body.replace("id === trackId", "id === mayThrow()")),
  reverseComparison: fixture(body.replace("id === trackId", "trackId === id")),
  customChild: fixture(body.replace("<div", "<Child")),
  rawSnapshot: fixture(body.replace("data-selected={selected}", "data-selected={id}")),
})) {
  test(`unproven projection boundary remains non-enforced: ${name}`, () => {
    assert.deepEqual(findings(source), []);
  });
}

test("projection version gates reject v2 and missing exports while permitting the tested v3 API", () => {
  for (const [version, useValueExport, expected] of [
    ["2.1.15", "alias", 0],
    ["3.0.0-beta.48", "missing", 0],
    ["next", "unknown", 1],
    ["3.0.0-beta.48", "alias", 1],
  ] as const) {
    const result = analyzeLegendPractices({
      sourceText: fixture(body),
      fileName: "fixture.tsx",
      installedLegendState: { version, useValueExport, syncExport: "available" },
    }).filter((finding) => finding.action === "select-primitive-projection");
    assert.equal(result.length, expected);
  }
});
