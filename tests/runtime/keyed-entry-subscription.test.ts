import { act, createElement as jsx } from "react";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { mountDom } from "../../src/runtime/dom.js";
import { observable } from "@legendapp/state";
import test from "node:test";
import { useValue } from "@legendapp/state/react";

interface Area {
  name: string;
}

for (const strict of [false, true]) {
  test(`a keyed entry subscription renders only its own entry and follows its key (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const observations: number[] = [];
    for (const narrowed of [false, true]) {
      const areas$ = observable<Record<string, Area>>({
        alpha: { name: "A" },
        beta: { name: "B" },
        gamma: { name: "C" },
      });
      let renders = 0;
      const Whole = ({ areaId }: { areaId: string }): ReactElement => {
        renders += 1;
        const allAreas = useValue(areas$);
        return jsx("span", { "data-slot": areaId }, allAreas[areaId]?.name ?? "");
      };
      const Entry = ({ areaId }: { areaId: string }): ReactElement => {
        renders += 1;
        const area = useValue(areas$[areaId]);
        return jsx("span", { "data-slot": areaId }, area?.name ?? "");
      };
      const Label = narrowed ? Entry : Whole;
      const labels = (ids: readonly string[]): ReactElement[] =>
        ids.map((areaId, index) => jsx(Label, { key: index, areaId }));
      await ui.render(labels(["alpha", "beta", "gamma"]));

      renders = 0;
      await act(() => areas$.beta!.name.set("B2"));
      assert.equal(ui.element('[data-slot="beta"]').textContent, "B2");
      assert.equal(renders, (narrowed ? 1 : 3) * (strict ? 2 : 1));
      observations.push(renders);

      renders = 0;
      await act(() => areas$.delta!.set({ name: "D" }));
      assert.equal(renders, (narrowed ? 0 : 3) * (strict ? 2 : 1), "a new key renders no reader");

      const first = ui.element('[data-slot="alpha"]');
      await ui.render(labels(["gamma", "beta", "gamma"]));
      assert.equal(ui.element('[data-slot="gamma"]'), first, "a key change keeps mount identity");
      assert.equal(first.textContent, "C", "the entry subscription follows the new key");

      renders = 0;
      await act(() => areas$.alpha!.name.set("A2"));
      assert.equal(renders, narrowed ? 0 : 3 * (strict ? 2 : 1), "the old key is released");

      await act(() => areas$.gamma!.delete());
      assert.equal(first.textContent, "", "a deleted entry reads as missing");
      await ui.render(null);
    }
    context.diagnostic(JSON.stringify(observations));
  });
}
