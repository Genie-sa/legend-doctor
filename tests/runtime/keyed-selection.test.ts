import type { FormEvent, ReactElement } from "react";
import { count, mountDom } from "../../src/runtime/dom.js";
import { createElement as jsx, useState } from "react";
import { useObservable, useValue } from "@legendapp/state/react";
import type { Observable } from "@legendapp/state";
import assert from "node:assert/strict";
import test from "node:test";

interface ListProps {
  ids: readonly string[];
  renders: Map<string, number>;
}
interface RowProps {
  id: string;
  selected: boolean;
  select: () => void;
  renders: Map<string, number>;
}

function Row({ id, selected, select, renders }: RowProps): ReactElement {
  count(renders, id);
  const [draft, setDraft] = useState("");
  return jsx(
    "li",
    { "data-row": id },
    jsx("button", { onClick: select, "aria-pressed": selected }, id),
    jsx("input", {
      value: draft,
      onInput: (event: FormEvent<HTMLInputElement>) => setDraft(event.currentTarget.value),
    }),
  );
}

function ReactList({ ids, renders }: ListProps): ReactElement {
  count(renders, "owner");
  const [selected, setSelected] = useState<string | null>(null);
  return jsx(
    "ul",
    null,
    ids.map((id) =>
      jsx(Row, { key: id, id, selected: selected === id, select: () => setSelected(id), renders }),
    ),
  );
}

function ObservableRow({
  id,
  selected$,
  renders,
}: Pick<RowProps, "id" | "renders"> & { selected$: Observable<string | null> }): ReactElement {
  const selected = useValue(() => {
    count(renders, `selector:${id}`);
    return selected$.get() === id;
  });
  return jsx(Row, { id, selected, select: () => selected$.set(id), renders });
}

function LegendList({ ids, renders }: ListProps): ReactElement {
  count(renders, "owner");
  const selected$ = useObservable<string | null>(null);
  return jsx(
    "ul",
    null,
    ids.map((id) => jsx(ObservableRow, { key: id, id, selected$, renders })),
  );
}

for (const strict of [false, true]) {
  test(`keyed selection updates only changed rows and retains drafts through reorder (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    for (const Component of [ReactList, LegendList]) {
      const renders = new Map<string, number>();
      await ui.render(jsx(Component, { ids: ["a", "b", "c"], renders }));
      await ui.input('[data-row="a"] input', "unsaved");
      const input = ui.element('[data-row="a"] input');
      await ui.click('[data-row="a"] button');
      renders.clear();
      await ui.click('[data-row="b"] button');
      assert.equal(ui.element('[data-row="a"] button').getAttribute("aria-pressed"), "false");
      assert.equal(ui.element('[data-row="b"] button').getAttribute("aria-pressed"), "true");
      assert.ok((renders.get("a") ?? 0) > 0);
      assert.ok((renders.get("b") ?? 0) > 0);
      for (const unaffected of ["owner", "c"]) {
        assert.equal((renders.get(unaffected) ?? 0) > 0, Component === ReactList, unaffected);
      }
      if (Component === LegendList) {
        assert.ok(
          (renders.get("selector:c") ?? 0) > 0,
          "a stable row still evaluates its selector",
        );
      }
      await ui.render(jsx(Component, { ids: ["c", "b", "a"], renders }));
      assert.ok(
        ui.element('[data-row="a"] input') === input,
        "stable keys preserve the existing input",
      );
      assert.equal(ui.element('[data-row="a"] input').getAttribute("value"), "unsaved");
      await ui.render(null);
    }
  });
}
