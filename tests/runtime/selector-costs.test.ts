import { act, createElement as jsx } from "react";
import { batch, observable } from "@legendapp/state";
import { count, mountDom } from "../../src/runtime/dom.js";
import type { Observable } from "@legendapp/state";
import type { ReactElement } from "react";
import type { SubscriptionCosts } from "../../src/core/subscriptions.js";
import assert from "node:assert/strict";
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
      observations.push({ ...costs });
      markup.push(ui.html());
      const host = ui.element('[data-id="1"]');
      renders.clear();
      costs.selectorExecutions = 0;
      await act(() => active$.set(1));
      assert.equal(renders.size, 0, "equal writes do not produce update renders");
      assert.equal(costs.selectorExecutions, 0, "equal writes do not execute selectors");
      await act(() =>
        batch(() => {
          active$.set(2);
          active$.set(3);
        }),
      );
      assert.equal(ui.element('[data-id="2"]').textContent, "false");
      assert.equal(ui.element('[data-id="3"]').textContent, "true");
      assert.equal(ui.element('[data-id="1"]'), host, "updates preserve host identity");
      const renderMultiplier = strict ? 2 : 1;
      const changedRows = Component === RawRow ? 100 : 2;
      assert.equal(
        [...renders.values()].reduce((sum, value) => sum + value, 0),
        changedRows * renderMultiplier,
      );
      const selectedExecutions = strict ? 104 : 102;
      assert.equal(costs.selectorExecutions, Component === RawRow ? 0 : selectedExecutions);
      await ui.render(null);
      renders.clear();
      costs.selectorExecutions = 0;
      await act(() => active$.set(4));
      assert.equal(renders.size, 0, "unmounted rows cannot render");
      assert.equal(costs.selectorExecutions, 0, "unmount releases selector subscriptions");
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
