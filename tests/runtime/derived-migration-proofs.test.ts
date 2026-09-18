import { act, createElement, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useObservable, useValue } from "@legendapp/state/react";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { mountDom } from "../../src/runtime/dom.js";
import { observable } from "@legendapp/state";
import test from "node:test";

for (const strict of [false, true]) {
  test(`moving an unproven helper adds a visible dependency (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const active$ = observable(1);
    const hidden$ = observable(1);
    const helper = (): number => hidden$.get();
    let beforeRenders = 0;
    let afterRenders = 0;
    const Before = (): ReactElement => {
      beforeRenders += 1;
      const id = useValue(active$);
      const selected = useMemo(() => id === helper(), [id]);
      return createElement("output", { id: "before" }, String(selected));
    };
    const After = (): ReactElement => {
      afterRenders += 1;
      const selected$ = useObservable(() => active$.get() === helper());
      const selected = useValue(selected$);
      return createElement("output", { id: "after" }, String(selected));
    };
    await ui.render(createElement("main", null, createElement(Before), createElement(After)));
    assert.equal(ui.element("#before").textContent, "true");
    assert.equal(ui.element("#after").textContent, "true");
    beforeRenders = 0;
    afterRenders = 0;
    await act(() => hidden$.set(2));
    assert.equal(ui.element("#before").textContent, "true");
    assert.equal(ui.element("#after").textContent, "false");
    assert.equal(beforeRenders, 0);
    assert.equal(afterRenders, strict ? 2 : 1);
  });

  test(`suffixes save no renders; strict comparisons preserve output and suppress equal transitions (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    for (const projection of ["suffix", "comparison"] as const) {
      const active$ = observable("a");
      let beforeRenders = 0;
      let afterRenders = 0;
      let computations = 0;
      const Before = (): ReactElement => {
        beforeRenders += 1;
        const id = useValue(active$);
        const result = useMemo(() => (projection === "suffix" ? `${id}!` : id === "a"), [id]);
        return createElement("output", { id: "before" }, String(result));
      };
      const After = (): ReactElement => {
        afterRenders += 1;
        const result$ = useObservable(() => {
          computations += 1;
          return projection === "suffix" ? `${active$.get()}!` : active$.get() === "a";
        });
        const result = useValue(result$);
        return createElement("output", { id: "after" }, String(result));
      };
      await ui.render(createElement("main", null, createElement(Before), createElement(After)));
      const element = ui.element("#after");
      beforeRenders = 0;
      afterRenders = 0;
      for (const id of ["b", "c", "d"]) {
        await act(() => active$.set(id));
        assert.equal(
          ui.element("#before").textContent,
          projection === "suffix" ? `${id}!` : "false",
        );
        assert.equal(ui.element("#after").textContent, ui.element("#before").textContent);
        assert.equal(ui.element("#after"), element);
      }
      assert.equal(beforeRenders, strict ? 6 : 3);
      assert.equal(afterRenders, (projection === "suffix" ? 3 : 1) * (strict ? 2 : 1));
      await ui.render(null);
      const computationsAtUnmount = computations;
      beforeRenders = 0;
      afterRenders = 0;
      await act(() => active$.set("detached"));
      assert.equal(beforeRenders, 0);
      assert.equal(afterRenders, 0);
      assert.equal(computations, computationsAtUnmount);
      await ui.render(createElement("main", null, createElement(Before), createElement(After)));
      assert.equal(
        ui.element("#before").textContent,
        projection === "suffix" ? "detached!" : "false",
      );
      assert.equal(ui.element("#after").textContent, ui.element("#before").textContent);
      await ui.render(null);
    }
  });
}

for (const strict of [false, true]) {
  for (const [name, effect] of [
    ["effect", useEffect],
    ["layout", useLayoutEffect],
  ] as const) {
    test(`equal results can hide commit and ref snapshots (strict=${strict}, hook=${name})`, async (context) => {
      const ui = mountDom(context, strict);
      const active$ = observable("a");
      const beforeCommits: string[] = [];
      const afterCommits: string[] = [];
      let beforeSnapshot = "";
      let afterSnapshot = "";
      const Before = (): ReactElement => {
        const id = useValue(active$);
        const selected = useMemo(() => id === "selected", [id]);
        const snapshot = useRef("");
        snapshot.current = active$.peek();
        effect(() => {
          beforeCommits.push(active$.peek());
        });
        beforeSnapshot = snapshot.current;
        return createElement("output", { id: "before" }, String(selected));
      };
      const After = (): ReactElement => {
        const selected$ = useObservable(() => active$.get() === "selected");
        const selected = useValue(selected$);
        const snapshot = useRef("");
        snapshot.current = active$.peek();
        effect(() => {
          afterCommits.push(active$.peek());
        });
        afterSnapshot = snapshot.current;
        return createElement("output", { id: "after" }, String(selected));
      };
      await ui.render(createElement("main", null, createElement(Before), createElement(After)));
      beforeCommits.length = 0;
      afterCommits.length = 0;
      await act(() => active$.set("b"));
      assert.equal(ui.element("#before").textContent, "false");
      assert.equal(ui.element("#after").textContent, "false");
      assert.deepEqual(beforeCommits, ["b"]);
      assert.deepEqual(afterCommits, []);
      assert.equal(beforeSnapshot, "b");
      assert.equal(afterSnapshot, "a");
    });
  }
}

for (const strict of [false, true]) {
  test(`numeric strict comparisons preserve NaN, signed zero, and infinity (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const active$ = observable(1);
    const Before = (): ReactElement => {
      const id = useValue(active$);
      const selected = useMemo(() => id === 0, [id]);
      return createElement("output", { id: "before" }, String(selected));
    };
    const After = (): ReactElement => {
      const selected$ = useObservable(() => active$.get() === 0);
      const selected = useValue(selected$);
      return createElement("output", { id: "after" }, String(selected));
    };
    await ui.render(createElement("main", null, createElement(Before), createElement(After)));
    for (const [value, expected] of [
      [-0, "true"],
      [0, "true"],
      [Number.NaN, "false"],
      [Number.NaN, "false"],
      [Infinity, "false"],
      [0, "true"],
    ] as const) {
      await act(() => active$.set(value));
      assert.equal(ui.element("#before").textContent, expected);
      assert.equal(ui.element("#after").textContent, expected);
    }
  });
}

for (const strict of [false, true]) {
  test(`a prop observable swap exposes mount-time computed identity (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const old$ = observable("other");
    const next$ = observable("selected");
    interface Props {
      source$: typeof old$;
    }
    const Before = ({ source$ }: Props): ReactElement => {
      const id = useValue(source$);
      const selected = useMemo(() => id === "selected", [id]);
      return createElement("output", { id: "before" }, String(selected));
    };
    const After = ({ source$ }: Props): ReactElement => {
      const selected$ = useObservable(() => source$.get() === "selected");
      const selected = useValue(selected$);
      return createElement("output", { id: "after" }, String(selected));
    };
    const render = (source$: typeof old$): ReactElement =>
      createElement(
        "main",
        null,
        createElement(Before, { source$ }),
        createElement(After, { source$ }),
      );
    await ui.render(render(old$));
    assert.equal(ui.element("#before").textContent, "false");
    assert.equal(ui.element("#after").textContent, "false");
    await ui.render(render(next$));
    assert.equal(ui.element("#before").textContent, "true");
    assert.equal(ui.element("#after").textContent, "false");
  });
}
