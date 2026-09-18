import { act, createElement as jsx } from "react";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { mountDom } from "../../src/runtime/dom.js";
import { observable } from "@legendapp/state";
import test from "node:test";
import { useValue } from "@legendapp/state/react";

for (const strict of [false, true]) {
  test(`object coercion must retain the owner's update clock (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    for (const isolated of [false, true]) {
      let label = "before";
      let coercions = 0;
      const open$ = observable(false);
      const state$ = observable({
        number: {
          toString() {
            coercions += 1;
            return label;
          },
        },
      });
      const OpenLeaf = (): ReactElement =>
        jsx("output", { "data-open": true }, String(useValue(open$)));
      const Original = (): ReactElement => {
        const open = useValue(open$);
        const raw = useValue(state$.number);
        return jsx(
          "main",
          null,
          jsx("aside", { "data-label": true }, String(raw)),
          jsx("output", { "data-open": true }, String(open)),
        );
      };
      const Isolated = (): ReactElement => {
        const raw = useValue(state$.number);
        return jsx("main", null, jsx("aside", { "data-label": true }, String(raw)), jsx(OpenLeaf));
      };
      await ui.render(jsx(isolated ? Isolated : Original));
      assert.equal(ui.element("[data-label]").textContent, "before");
      const mountedCoercions = coercions;
      label = "after";
      await act(() => open$.set(true));
      assert.equal(ui.element("[data-open]").textContent, "true");
      assert.equal(ui.element("[data-label]").textContent, isolated ? "before" : "after");
      assert.equal(coercions > mountedCoercions, !isolated);
      await ui.render(null);
    }
  });
}
