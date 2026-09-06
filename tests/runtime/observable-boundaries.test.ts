import { act, createElement, useMemo } from "react";
import type { Observable } from "@legendapp/state";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { mountDom } from "../../src/runtime/dom.js";
import { observable } from "@legendapp/state";
import test from "node:test";
import { useValue } from "@legendapp/state/react";

test("a grouped dialog handoff publishes payload and visibility together", (context) => {
  const dialog$ = observable({ target: "old", open: false });
  const published: { target: string; open: boolean }[] = [];
  context.after(dialog$.onChange(({ value }) => published.push({ ...value })));

  dialog$.assign({ target: "new", open: true });

  assert.deepEqual(published, [{ target: "new", open: true }]);
  assert.deepEqual(dialog$.peek(), { target: "new", open: true });
});

interface ProfileProps {
  profile$: Observable<{ name: string }>;
}

function BroadMemo({ profile$ }: ProfileProps): ReactElement {
  const profile = useValue(profile$);
  const caption = useMemo(() => profile.name, [profile]);
  return createElement("output", null, caption);
}

function LeafMemo({ profile$ }: ProfileProps): ReactElement {
  const name = useValue(profile$.name);
  const caption = useMemo(() => name, [name]);
  return createElement("output", null, caption);
}

test("child writes require a field subscription when memoized output depends on snapshot identity", async (context) => {
  const ui = mountDom(context, false);
  for (const Component of [BroadMemo, LeafMemo]) {
    const profile$ = observable({ name: "Ada" });
    await ui.render(createElement(Component, { profile$ }));
    assert.equal(ui.element("output").textContent, "Ada");
    await act(() => {
      if (Component === BroadMemo) {
        profile$.set({ ...profile$.peek(), name: "Grace" });
      } else {
        profile$.name.set("Grace");
      }
    });
    assert.equal(ui.element("output").textContent, "Grace");
    await ui.render(null);
  }
});
