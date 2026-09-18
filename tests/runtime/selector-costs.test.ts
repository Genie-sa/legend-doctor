import { act, createElement as jsx } from "react";
import { count, mountDom } from "../../src/runtime/dom.js";
import type { Observable } from "@legendapp/state";
import type { ReactElement } from "react";
import type { SubscriptionCosts } from "../../src/core/subscriptions.js";
import assert from "node:assert/strict";
import { observable } from "@legendapp/state";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { useValue } from "@legendapp/state/react";

interface RowProps {
  id: number;
  active$: Observable<number>;
  renders: Map<string, number>;
  costs: SubscriptionCosts;
}

function RawRow({ id, active$, renders }: RowProps): ReactElement {
  count(renders, String(id));
  const selected = useValue(active$) === id;
  return jsx("output", { "data-id": id }, String(selected));
}

function SelectedRow({ id, active$, renders, costs }: RowProps): ReactElement {
  count(renders, String(id));
  const selected = useValue(() => {
    const start = performance.now();
    costs.selectorExecutions! += 1;
    const result = active$.get() === id;
    costs.selectorDurationMs! += performance.now() - start;
    return result;
  });
  return jsx("output", { "data-id": id }, String(selected));
}

for (const strict of [false, true]) {
  test(`selector fanout remains observable despite fewer row renders (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const observations: SubscriptionCosts[] = [];
    const markup: string[] = [];
    for (const Component of [RawRow, SelectedRow]) {
      const active$ = observable(0);
      const renders = new Map<string, number>();
      const costs: SubscriptionCosts = {
        ownerRenders: 0,
        siblingRenders: 0,
        selectorExecutions: 0,
        selectorDurationMs: 0,
      };
      await ui.render(
        jsx(
          "main",
          null,
          Array.from({ length: 100 }, (_unused, id) =>
            jsx(Component, { key: id, id, active$, renders, costs }),
          ),
        ),
      );
      renders.clear();
      costs.selectorExecutions = 0;
      costs.selectorDurationMs = 0;
      const start = performance.now();
      await act(() => active$.set(1));
      costs.scenarioDurationMs = performance.now() - start;
      costs.ownerRenders = [...renders.values()].reduce((sum, value) => sum + value, 0);
      assert.equal(ui.element('[data-id="0"]').textContent, "false");
      assert.equal(ui.element('[data-id="1"]').textContent, "true");
      assert.ok(Number.isFinite(costs.scenarioDurationMs) && costs.scenarioDurationMs >= 0);
      assert.ok(Number.isFinite(costs.selectorDurationMs) && costs.selectorDurationMs >= 0);
      observations.push(costs);
      markup.push(ui.html());
      await ui.render(null);
    }
    assert.equal(markup[0], markup[1]);
    const [before, after] = observations;
    assert.equal(before!.ownerRenders, strict ? 200 : 100);
    assert.equal(after!.ownerRenders, strict ? 4 : 2);
    assert.equal(before!.selectorExecutions, 0);
    assert.equal(after!.selectorExecutions, strict ? 104 : 102);
    context.diagnostic(
      JSON.stringify({ environment: "jsdom, development, act completion", strict, before, after }),
    );
  });
}
