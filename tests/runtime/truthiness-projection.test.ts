import { act, createElement as jsx } from "react";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { mountDom } from "../../src/runtime/dom.js";
import { observable } from "@legendapp/state";
import test from "node:test";
import { useValue } from "@legendapp/state/react";

interface Track {
  id: string;
}

for (const strict of [false, true]) {
  test(`a truthiness selector renders only when the value turns truthy or falsy (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const markup: string[][] = [];
    for (const projected of [false, true]) {
      const dragged$ = observable<Track | null>(null);
      let renders = 0;
      const Raw = (): ReactElement => {
        renders += 1;
        const dragged = useValue(dragged$);
        return jsx(
          "div",
          { className: dragged ? "on" : "off" },
          dragged && jsx("b", null, "dragging"),
        );
      };
      const Projected = (): ReactElement => {
        renders += 1;
        const hasDragged = useValue(() => Boolean(dragged$.get()));
        return jsx(
          "div",
          { className: hasDragged ? "on" : "off" },
          hasDragged && jsx("b", null, "dragging"),
        );
      };
      const steps: string[] = [];
      await ui.render(jsx(projected ? Projected : Raw));
      steps.push(ui.html());

      renders = 0;
      await act(() => dragged$.set({ id: "1" }));
      steps.push(ui.html());
      assert.equal(renders, strict ? 2 : 1, "turning truthy renders");

      renders = 0;
      await act(() => dragged$.set({ id: "2" }));
      steps.push(ui.html());
      const changedRenders = strict ? 2 : 1;
      assert.equal(renders, projected ? 0 : changedRenders, "a truthy-to-truthy change");

      renders = 0;
      await act(() => dragged$.set(null));
      steps.push(ui.html());
      assert.equal(renders, strict ? 2 : 1, "turning falsy renders");
      markup.push(steps);
      await ui.render(null);
    }
    assert.deepEqual(markup[1], markup[0], "a falsy guard renders the same markup as false");
  });
}
