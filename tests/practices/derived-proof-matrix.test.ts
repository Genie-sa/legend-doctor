import type { LegendPracticeFinding } from "../../src/core/types.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

const source = `
  import { useMemo } from "react";
  import { observable } from "@legendapp/state";
  import { useValue } from "@legendapp/state/react";
  const active$ = observable("a");
  function Row() {
    const id = useValue(active$);
    const selected = useMemo(() => id === "selected", [id]);
    return <output>{selected ? "yes" : "no"}</output>;
  }
  export function App() { return <Row />; }
`;

function analyze(sourceText: string): LegendPracticeFinding | undefined {
  return analyzeLegendPractices({ fileName: "fixture.tsx", sourceText }).find(
    (entry) => entry.action === "derive-computed-observable",
  );
}

test("equivalent imports, callback syntax, and broad scalar declarations preserve supported proofs", () => {
  for (const [label, input] of [
    [
      "aliased memo",
      source.replace("{ useMemo }", "{ useMemo as memoValue }").replace("useMemo(", "memoValue("),
    ],
    [
      "aliased observable",
      source.replace("{ observable }", "{ observable as state }").replace("observable(", "state("),
    ],
    [
      "aliased subscription",
      source
        .replace("{ useValue }", "{ useValue as readValue }")
        .replace("useValue(", "readValue("),
    ],
    [
      "React namespace",
      source.replace("{ useMemo }", "* as React").replace("useMemo(", "React.useMemo("),
    ],
    [
      "Legend namespace",
      source.replace("{ observable }", "* as Legend").replace("observable(", "Legend.observable("),
    ],
    [
      "function callback",
      source.replace('() => id === "selected"', 'function () { return id === "selected"; }'),
    ],
    ["explicit string", source.replace('observable("a")', 'observable<string>("a")')],
    [
      "explicit number",
      source
        .replace('observable("a")', "observable<number>(0)")
        .replace('id === "selected"', "1 !== id"),
    ],
    ["literal on left", source.replace('id === "selected"', '"selected" === id')],
    ["transparent comparison", source.replace('id === "selected"', '((id) === ("selected"))')],
  ]) {
    assert.equal(analyze(input!)?.disposition, "change", label);
  }
});

test("unproven domains, lifetime aliases, and equality maps remain review candidates", () => {
  for (const [label, input] of [
    ["unknown generic", source.replace('observable("a")', 'observable<unknown>("a")')],
    ["narrow generic", source.replace('observable("a")', 'observable<"a" | "selected">("a")')],
    ["asserted type", source.replace('observable("a")', 'observable("a" as const)')],
    ["annotated root", source.replace("const active$ =", "const active$: Observable<string> =")],
    ["mutable identity", source.replace("const active$", "let active$")],
    [
      "root alias",
      source.replace(
        'const active$ = observable("a");',
        'const original$ = observable("a"); const active$ = original$;',
      ),
    ],
    [
      "imported root",
      source.replace('const active$ = observable("a");', 'import { active$ } from "./state";'),
    ],
    ["truthiness projection", source.replace('id === "selected"', "!!id")],
    ["constant comparison", source.replace('id === "selected"', "id === id")],
    ["global operand", source.replace('id === "selected"', "id === Infinity")],
    [
      "arithmetic projection",
      source.replace('observable("a")', "observable(1)").replace('id === "selected"', "id + 1"),
    ],
    ["constructor side effect", source.replace('id === "selected"', "id === new Probe()")],
    [
      "conditional callback",
      source.replace('() => id === "selected"', "() => { if (id) return true; return false; }"),
    ],
    ["customized built-in", source.replace("<output>", '<output is="custom-output">')],
    ["JSX spread", source.replace("<output>", "<output {...attrs}>")],
    ["JSX call", source.replace('selected ? "yes" : "no"', "format(selected)")],
    ["custom child", source.replaceAll("output", "Display")],
    [
      "component alias",
      source.replace("export function App", "const alias = Row; export function App"),
    ],
  ]) {
    assert.equal(
      analyze(input!)?.disposition,
      label === "imported root" ? undefined : "candidate",
      label,
    );
  }
});

test("dependency, hook-option, and asynchronous boundaries still abstain before migration", () => {
  for (const [label, input] of [
    ["selector input", source.replace("useValue(active$)", "useValue(() => active$.get())")],
    [
      "subscription options",
      source.replace("useValue(active$)", "useValue(active$, { suspense: true })"),
    ],
    ["memo arity", source.replace("[id]);", "[id], options);")],
    ["missing dependency", source.replace("[id]", "[]")],
    ["duplicate dependency", source.replace("[id]", "[id, id]")],
    [
      "input consumed by event",
      source.replace("return <output>", "const onClick = () => publish(id); return <output>"),
    ],
    ["async callback", source.replace("useMemo(() =>", "useMemo(async () =>")],
    [
      "generator callback",
      source.replace('() => id === "selected"', 'function* () { return id === "selected"; }'),
    ],
    ["callback parameter", source.replace('() => id === "selected"', '(id) => id === "selected"')],
    ["mutable memo binding", source.replace("const selected", "let selected")],
  ]) {
    assert.equal(analyze(input!), undefined, label);
  }
});

test("legacy and foreign hook entry points do not inherit the tested useValue contract", () => {
  for (const input of [
    source.replaceAll("useValue", "useSelector"),
    source.replaceAll("useValue", "use$"),
    source.replace("{ useValue }", "{ useSelector as useValue }"),
    source.replace('from "@legendapp/state/react"', 'from "foreign-state/react"'),
    source.replace('from "react"', 'from "foreign-react"'),
  ]) {
    assert.equal(analyze(input), undefined);
  }
});
