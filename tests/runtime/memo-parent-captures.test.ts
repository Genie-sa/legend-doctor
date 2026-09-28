import { Computed, Memo, useValue } from "@legendapp/state/react";
import type { ReactElement, RefObject } from "react";
import { act, createRef, createElement as jsx, useState } from "react";
import { count, mountDom } from "../../src/runtime/dom.js";
import type { Observable } from "@legendapp/state";
import assert from "node:assert/strict";
import { observable } from "@legendapp/state";
import test from "node:test";

type Wrapper = typeof Computed | typeof Memo;

interface Feed {
  offset: number;
  forks: number;
}

interface RowProps {
  feed$: Observable<Feed>;
  renders: Map<string, number>;
  wrapper: Wrapper;
}

interface Snapshot {
  owner: number;
  text: string;
}

function Row({ feed$, renders, wrapper }: RowProps): ReactElement {
  count(renders, "owner");
  const offset = useValue(feed$.offset);
  const absoluteIndex = offset + 1;
  return jsx(
    "output",
    null,
    jsx(wrapper, { children: () => `${absoluteIndex}:${feed$.forks.get()}` }),
  );
}

interface LabeledProps {
  setter: RefObject<((label: string) => void) | null>;
  wrapper: Wrapper;
}

function Labeled({ setter, wrapper }: LabeledProps): ReactElement {
  const [label, update] = useState("first");
  setter.current = update;
  return jsx("output", null, jsx(wrapper, { children: () => label }));
}

async function renderAfterStateChange(
  context: test.TestContext,
  strict: boolean,
  wrapper: Wrapper,
): Promise<string | null> {
  const ui = mountDom(context, strict);
  const setter = createRef<(label: string) => void>();
  await ui.render(jsx(Labeled, { setter, wrapper }));
  await act(() => setter.current?.("second"));
  return ui.element("output").textContent;
}

async function mountRow(
  context: test.TestContext,
  strict: boolean,
  wrapper: Wrapper,
): Promise<{ feed$: Observable<Feed>; read: () => Snapshot; renders: Map<string, number> }> {
  const ui = mountDom(context, strict);
  const feed$ = observable<Feed>({ forks: 0, offset: 0 });
  const renders = new Map<string, number>();
  await ui.render(jsx(Row, { feed$, renders, wrapper }));
  assert.equal(ui.element("output").textContent, "1:0");
  renders.clear();
  return {
    feed$,
    read: () => ({
      owner: renders.get("owner") ?? 0,
      text: ui.element("output").textContent ?? "",
    }),
    renders,
  };
}

for (const strict of [false, true]) {
  test(`a Memo child keeps a subscribed value from its first render (strict=${strict})`, async (context) => {
    const { feed$, read } = await mountRow(context, strict, Memo);
    await act(() => feed$.offset.set(5));
    assert.ok(read().owner > 0, "the owner re-renders for its own subscription");
    assert.equal(read().text, "1:0", "Memo ignores the owner's render");
    await act(() => feed$.forks.set(1));
    assert.equal(
      read().text,
      "1:1",
      "an observable the child reads re-renders it with the stale capture",
    );
  });

  test(`a Computed child renders the owner's current value and still tracks its observables (strict=${strict})`, async (context) => {
    const { feed$, read, renders } = await mountRow(context, strict, Computed);
    await act(() => feed$.offset.set(5));
    assert.equal(read().text, "6:0");
    renders.clear();
    await act(() => feed$.forks.set(1));
    assert.equal(read().text, "6:1");
    assert.equal(
      read().owner,
      0,
      "an observable read inside Computed does not re-render the owner",
    );
  });

  test(`a Memo child reading React state keeps its first value (strict=${strict})`, async (context) => {
    assert.equal(await renderAfterStateChange(context, strict, Memo), "first");
  });

  test(`a Computed child reading React state renders the new value (strict=${strict})`, async (context) => {
    assert.equal(await renderAfterStateChange(context, strict, Computed), "second");
  });
}
