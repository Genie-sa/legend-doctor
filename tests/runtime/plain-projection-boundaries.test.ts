import { act, createElement as jsx, useEffect } from "react";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { mountDom } from "../../src/runtime/dom.js";
import { observable } from "@legendapp/state";
import test from "node:test";
import { useValue } from "@legendapp/state/react";

for (const strict of [false, true]) {
  test(`moving a helper read would add a hidden subscription (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const active$ = observable(1);
    const hidden$ = observable(1);
    const helper = (): number => hidden$.get();
    const Raw = (): ReactElement => {
      const id = useValue(active$);
      const selected = id === helper();
      return jsx("output", { id: "raw" }, String(selected));
    };
    const Unsafe = (): ReactElement => {
      const selected = useValue(() => active$.get() === helper());
      return jsx("output", { id: "unsafe" }, String(selected));
    };
    await ui.render(jsx("main", null, jsx(Raw), jsx(Unsafe)));
    assert.equal(ui.element("#raw").textContent, "true");
    assert.equal(ui.element("#unsafe").textContent, "true");
    await act(() => hidden$.set(2));
    assert.equal(ui.element("#raw").textContent, "true");
    assert.equal(ui.element("#unsafe").textContent, "false");
  });

  test(`suppressed raw renders would change effects and event snapshots (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const active$ = observable(0);
    const effects: number[] = [];
    const clicks: number[] = [];
    const Raw = (): ReactElement => {
      const id = useValue(active$);
      const selected = id === 10;
      useEffect(() => {
        effects.push(id);
      });
      return jsx("button", { id: "raw", onClick: () => clicks.push(id) }, String(selected));
    };
    const Unsafe = (): ReactElement => {
      const selected = useValue(() => active$.get() === 10);
      const id = active$.peek();
      useEffect(() => {
        effects.push(id);
      });
      return jsx("button", { id: "unsafe", onClick: () => clicks.push(id) }, String(selected));
    };
    await ui.render(jsx("main", null, jsx(Raw), jsx(Unsafe)));
    effects.length = 0;
    await act(() => active$.set(1));
    assert.deepEqual(effects, [1], "only the original owner refreshes its effect");
    await ui.click("#raw");
    await ui.click("#unsafe");
    assert.deepEqual(clicks, [1, 0], "the naive replacement leaves an event closure stale");
    assert.equal(ui.element("#raw").textContent, ui.element("#unsafe").textContent);
  });
}
