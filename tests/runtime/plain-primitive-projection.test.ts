import { act, createElement as jsx } from "react";
import { observer, useValue } from "@legendapp/state/react";
import type { Observable } from "@legendapp/state";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { mountDom } from "../../src/runtime/dom.js";
import { observable } from "@legendapp/state";
import test from "node:test";

for (const strict of [false, true]) {
  test(`500 primitive projections suppress equal outputs and keep prop updates live (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const observations: { renders: number; selectors: number }[] = [];
    for (const projected of [false, true]) {
      const active$ = observable(0);
      let renders = 0;
      let selectors = 0;
      const Raw = ({ trackId }: { trackId: number }): ReactElement => {
        renders += 1;
        const id = useValue(active$);
        const selected = id === trackId;
        return jsx("div", { "data-id": trackId, "aria-selected": selected });
      };
      const Selected = ({ trackId }: { trackId: number }): ReactElement => {
        renders += 1;
        const selected = useValue(() => {
          selectors += 1;
          return active$.get() === trackId;
        });
        return jsx("div", { "data-id": trackId, "aria-selected": selected });
      };
      const Row = projected ? Selected : Raw;
      const rows = (offset: number): ReactElement[] =>
        Array.from({ length: 500 }, (_value, key) => jsx(Row, { key, trackId: key + offset }));
      await ui.render(rows(0));
      const first = ui.element('[data-id="0"]');
      renders = 0;
      selectors = 0;
      await act(() => active$.set(1));
      assert.equal(ui.element('[data-id="0"]').getAttribute("aria-selected"), "false");
      assert.equal(ui.element('[data-id="1"]').getAttribute("aria-selected"), "true");
      assert.equal(renders, (projected ? 2 : 500) * (strict ? 2 : 1));
      if (projected) {
        assert.ok(selectors >= 500, "selection remains linear work");
      }
      observations.push({ renders, selectors });
      await ui.render(rows(1));
      assert.equal(ui.element('[data-id="1"]'), first, "prop updates preserve mount identity");
      assert.equal(
        first.getAttribute("aria-selected"),
        "true",
        "inline selector reads the new prop",
      );
      renders = 0;
      await act(() => active$.set(2));
      assert.equal(first.getAttribute("aria-selected"), "false");
      assert.equal(ui.element('[data-id="2"]').getAttribute("aria-selected"), "true");
      assert.equal(renders, (projected ? 2 : 500) * (strict ? 2 : 1));
      await ui.render(null);
      renders = 0;
      await act(() => active$.set(3));
      assert.equal(renders, 0, "unmounted subscriptions are released");
    }
    context.diagnostic(JSON.stringify(observations));
  });

  test(`observer ownership is a separate runtime boundary (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const active$: Observable<number> = observable(0);
    let rawRenders = 0;
    let projectedRenders = 0;
    const Raw = observer(() => {
      rawRenders += 1;
      const id = useValue(active$);
      return jsx("div", { "data-raw": true, "aria-label": String(id === 10) });
    });
    const Selected = observer(() => {
      projectedRenders += 1;
      const selected = useValue(() => active$.get() === 10);
      return jsx("div", { "data-projected": true, "aria-label": String(selected) });
    });
    await ui.render(jsx("main", null, jsx(Raw), jsx(Selected)));
    rawRenders = 0;
    projectedRenders = 0;
    await act(() => active$.set(1));
    assert.equal(rawRenders, strict ? 2 : 1);
    assert.equal(projectedRenders, 0);
    assert.equal(ui.element("[data-raw]").getAttribute("aria-label"), "false");
    assert.equal(ui.element("[data-projected]").getAttribute("aria-label"), "false");
  });
}
