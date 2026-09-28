import { count, mountDom } from "../../src/runtime/dom.js";
import { use$, useSelector, useValue } from "@legendapp/state/react";
import type { Observable } from "@legendapp/state";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { createElement as jsx } from "react";
import { observable } from "@legendapp/state";
import test from "node:test";

interface Player {
  current: string;
  time: number;
}

interface RowProps {
  id: string;
  player$: Observable<Player>;
  renders: Map<string, number>;
}

function isCurrent(player$: Observable<Player>, id: string): boolean {
  return player$.current.get() === id;
}

function UnreadSubscriptionRow({ id, player$, renders }: RowProps): ReactElement {
  count(renders, id);
  use$(player$);
  const current = useSelector(() => isCurrent(player$, id));
  return jsx("li", { "data-current": String(current) }, id);
}

function SelectorRow({ id, player$, renders }: RowProps): ReactElement {
  count(renders, id);
  const current = useSelector(() => isCurrent(player$, id));
  return jsx("li", { "data-current": String(current) }, id);
}

const ROW_IDS = ["a", "b", "c"];
const TICKS = 5;

test("use$ and useSelector are the useValue export", () => {
  assert.equal(use$, useValue);
  assert.equal(useSelector, useValue);
});

for (const strict of [false, true]) {
  test(`deleting an unread use$ keeps a row's tracked selector current (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const traces: string[][] = [];
    const tickRenders: number[] = [];
    for (const Row of [UnreadSubscriptionRow, SelectorRow]) {
      const player$ = observable<Player>({ current: "a", time: 0 });
      const renders = new Map<string, number>();
      const list = (): ReactElement =>
        jsx(
          "ul",
          null,
          ROW_IDS.map((id) => jsx(Row, { id, key: id, player$, renders })),
        );
      await ui.render(list());
      const trace = [ui.html()];
      renders.clear();
      const tick = (): void => {
        player$.time.set((time) => time + 1);
      };
      for (let index = 0; index < TICKS; index += 1) {
        globalThis.window.addEventListener("tick", tick, { once: true });
        await ui.signal("tick");
      }
      tickRenders.push([...renders.values()].reduce((total, value) => total + value, 0));
      trace.push(ui.html());
      renders.clear();
      const select = (): void => {
        player$.current.set("b");
      };
      globalThis.window.addEventListener("select", select, { once: true });
      await ui.signal("select");
      assert.equal(ui.element('[data-current="true"]').textContent, "b");
      assert.equal(renders.has("c"), Row === UnreadSubscriptionRow);
      trace.push(ui.html());
      traces.push(trace);
      await ui.render(null);
    }
    assert.deepEqual(traces[1], traces[0]);
    assert.ok((tickRenders[0] ?? 0) >= ROW_IDS.length * TICKS);
    assert.equal(tickRenders[1], 0);
  });
}
