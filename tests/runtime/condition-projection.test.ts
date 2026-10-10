import { act, createElement as jsx } from "react";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { mountDom } from "../../src/runtime/dom.js";
import { observable } from "@legendapp/state";
import test from "node:test";
import { useValue } from "@legendapp/state/react";

type Status = "idle" | "loading" | "saving" | "error";

interface Task {
  done: boolean;
  id: string;
}

for (const strict of [false, true]) {
  const perRender = strict ? 2 : 1;

  test(`count and joined-literal selectors render only when their boolean flips (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const markup: string[][] = [];
    for (const projected of [false, true]) {
      const tasks$ = observable<Task[]>([]);
      const status$ = observable<Status>("idle");
      let renders = 0;
      const Raw = (): ReactElement => {
        renders += 1;
        const tasks = useValue(tasks$);
        const status = useValue(status$);
        const isBusy = status === "loading" || status === "saving";
        return jsx("div", { "data-busy": isBusy, hidden: tasks.length === 0 });
      };
      const Projected = (): ReactElement => {
        renders += 1;
        const isTasksEmpty = useValue(() => tasks$.get().length === 0);
        const isBusy = useValue(() => {
          const status = status$.get();
          return status === "loading" || status === "saving";
        });
        return jsx("div", { "data-busy": isBusy, hidden: isTasksEmpty });
      };
      const steps: string[] = [];
      await ui.render(jsx(projected ? Projected : Raw));
      steps.push(ui.html());

      renders = 0;
      await act(() => tasks$.set([{ done: false, id: "a" }]));
      steps.push(ui.html());
      assert.equal(renders, perRender, "the first task flips emptiness");

      renders = 0;
      await act(() => tasks$.push({ done: true, id: "b" }));
      steps.push(ui.html());
      assert.equal(renders, projected ? 0 : perRender, "a second task keeps emptiness");

      renders = 0;
      await act(() => status$.set("loading"));
      steps.push(ui.html());
      assert.equal(renders, perRender, "loading flips busy");

      renders = 0;
      await act(() => status$.set("saving"));
      steps.push(ui.html());
      assert.equal(renders, projected ? 0 : perRender, "loading to saving keeps busy");
      markup.push(steps);
      await ui.render(null);
    }
    assert.deepEqual(markup[1], markup[0], "both forms render the same markup at every step");
  });

  test(`an inline selector compares against the latest prop (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const count$ = observable(4);
    const Counter = ({ limit }: { readonly limit: number }): ReactElement => {
      const countExceeds = useValue(() => count$.get() > limit);
      return jsx("div", { "data-over": countExceeds });
    };
    await ui.render(jsx(Counter, { limit: 5 }));
    assert.match(ui.html(), /data-over="false"/u);
    await ui.render(jsx(Counter, { limit: 3 }));
    assert.match(ui.html(), /data-over="true"/u, "a new prop re-evaluates the selector");
    await act(() => count$.set(2));
    assert.match(ui.html(), /data-over="false"/u, "a later change compares against the new prop");
    await ui.render(null);
  });
}
