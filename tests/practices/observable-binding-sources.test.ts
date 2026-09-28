import assert from "node:assert/strict";
import { practiceFindings } from "./edit-assertions.js";
import test from "node:test";

const row = (parameter: string, binding: string): string => `
import type { Observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

interface RowProps {
  active$: Observable<string | null>;
  id: string;
}

export function Row(${parameter}) {
  ${binding}
  const active = useValue(active$);
  const isActive = active === id;
  return <div data-active={isActive} />;
}
`;

const projections = (source: string): number =>
  practiceFindings(source, "select-primitive-projection").length;

for (const [name, source] of Object.entries({
  destructuredTypedProps: row("props: RowProps", "const { active$, id } = props;"),
  aliasedTypedProp: row("props: RowProps", "const active$ = props.active$; const { id } = props;"),
  destructuredParameter: row("{ active$, id }: RowProps", ""),
})) {
  test(`proves an observable prop through ${name}`, () => assert.equal(projections(source), 1));
}

for (const [name, source] of Object.entries({
  reassignedProps: row("props: RowProps", "props = { ...props }; const { active$, id } = props;"),
  unionPropType: row("props: RowProps", "const { active$, id } = props;").replace(
    "active$: Observable<string | null>;",
    "active$: Observable<string | null> | string;",
  ),
  untypedProps: row("props: any", "const { active$, id } = props;"),
  reboundAlias: row(
    "props: RowProps",
    "let active$ = props.active$; active$ = other$; const { id } = props;",
  ),
  nullishDefault: row("props: RowProps", "const { active$, id } = props ?? fallback;"),
})) {
  test(`keeps the observable binding unproven for ${name}`, () =>
    assert.equal(projections(source), 0));
}

test("a file-local context hook proves the binding but no provider value", () => {
  const source = `
import type { Observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";
import { createContext, useContext } from "react";

const Drag = createContext<{ active$: Observable<string | null> } | null>(null);
function useDrag() {
  const value = useContext(Drag);
  if (!value) {
    throw new Error("missing provider");
  }
  return value;
}

export function Row({ id }: { id: string }) {
  const { active$ } = useDrag();
  const active = useValue(active$);
  const isActive = active === id;
  return <div data-active={isActive} />;
}
`;
  assert.equal(projections(source), 0);
});
