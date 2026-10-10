import { act, createElement as jsx } from "react";
import { count, mountDom } from "../../src/runtime/dom.js";
import type { Observable } from "@legendapp/state";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { observable } from "@legendapp/state";
import test from "node:test";
import { useValue } from "@legendapp/state/react";

interface Viewport {
  label: string;
  width: number;
}

interface PanelProps {
  renders: Map<string, number>;
  viewport$: Observable<Viewport>;
}

function FreshPanel({ renders, viewport$ }: PanelProps): ReactElement {
  count(renders, "panel");
  const layout = useValue(() => ({
    label: viewport$.label.get(),
    wide: viewport$.width.get() > 800,
  }));
  return jsx("output", null, `${layout.label}:${String(layout.wide)}`);
}

function SplitPanel({ renders, viewport$ }: PanelProps): ReactElement {
  count(renders, "panel");
  const label = useValue(() => viewport$.label.get());
  const wide = useValue(() => viewport$.width.get() > 800);
  return jsx("output", null, `${label}:${String(wide)}`);
}

function RawPanel({ renders, viewport$ }: PanelProps): ReactElement {
  count(renders, "panel");
  const layout = useValue(() => ({
    label: viewport$.label.get(),
    width: viewport$.width.get(),
  }));
  return jsx("output", null, `${layout.label}:${layout.width}`);
}

async function rendersAfterWidthChanges(
  context: test.TestContext,
  strict: boolean,
  panel: (props: PanelProps) => ReactElement,
): Promise<{ renders: number; text: string | null }> {
  const ui = mountDom(context, strict);
  const viewport$ = observable<Viewport>({ label: "main", width: 400 });
  const renders = new Map<string, number>();
  await ui.render(jsx(panel, { renders, viewport$ }));
  renders.clear();
  for (const width of [500, 600, 700]) {
    await act(() => viewport$.width.set(width));
  }
  return { renders: renders.get("panel") ?? 0, text: ui.element("output").textContent };
}

for (const strict of [false, true]) {
  test(`a fresh object result re-renders on a tracked change that leaves its fields equal (strict=${strict})`, async (context) => {
    const { renders, text } = await rendersAfterWidthChanges(context, strict, FreshPanel);
    assert.equal(text, "main:false");
    assert.ok(renders >= 3, "useValue compares the new object with !==, so every change renders");
  });

  test(`primitive selectors skip a tracked change that leaves their results equal (strict=${strict})`, async (context) => {
    const { renders, text } = await rendersAfterWidthChanges(context, strict, SplitPanel);
    assert.equal(text, "main:false");
    assert.equal(renders, 0);
  });

  test(`a fresh object of raw reads renders only when a field changes (strict=${strict})`, async (context) => {
    const { renders, text } = await rendersAfterWidthChanges(context, strict, RawPanel);
    assert.equal(text, "main:700");
    assert.ok(renders >= 3, "each change also changes the width field, so splitting saves nothing");
  });

  test(`an equal write runs no selector and renders nothing (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const viewport$ = observable<Viewport>({ label: "main", width: 400 });
    const renders = new Map<string, number>();
    await ui.render(jsx(FreshPanel, { renders, viewport$ }));
    renders.clear();
    await act(() => viewport$.width.set(400));
    assert.equal(renders.size, 0);
  });
}
