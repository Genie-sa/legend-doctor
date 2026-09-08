import type { FormEvent, ReactElement } from "react";
import { count, mountDom } from "../../src/runtime/dom.js";
import { createElement as jsx, useState } from "react";
import type { Observable } from "@legendapp/state";
import assert from "node:assert/strict";
import { observable } from "@legendapp/state";
import test from "node:test";
import { useValue } from "@legendapp/state/react";

interface ScreenProps {
  enabled$: Observable<boolean>;
  label: string;
  renders: Map<string, number>;
}

interface ControlProps {
  disabled: boolean;
  id: string;
  label: string;
}

function Control({ disabled, id, label }: ControlProps): ReactElement {
  const [draft, setDraft] = useState("");
  return jsx("input", {
    "aria-label": label,
    "data-control": id,
    disabled,
    onInput: (event: FormEvent<HTMLInputElement>) => setDraft(event.currentTarget.value),
    value: draft,
  });
}

function SubscribedControl({
  enabled$,
  id,
  label,
}: Omit<ControlProps, "disabled"> & Pick<ScreenProps, "enabled$">): ReactElement {
  const enabled = useValue(enabled$);
  return jsx(Control, { disabled: !enabled, id, label });
}

function Unrelated({ renders }: Pick<ScreenProps, "renders">): ReactElement {
  count(renders, "unrelated");
  return jsx("p", null, "Unrelated settings");
}

function Before({ enabled$, label, renders }: ScreenProps): ReactElement {
  count(renders, "owner");
  const enabled = useValue(enabled$);
  return jsx(
    "main",
    null,
    jsx("section", null, jsx(Control, { disabled: !enabled, id: "a", label })),
    jsx(Unrelated, { renders }),
    jsx("aside", null, jsx(Control, { disabled: !enabled, id: "b", label })),
  );
}

function After({ enabled$, label, renders }: ScreenProps): ReactElement {
  count(renders, "owner");
  return jsx(
    "main",
    null,
    jsx("section", null, jsx(SubscribedControl, { enabled$, id: "a", label })),
    jsx(Unrelated, { renders }),
    jsx("aside", null, jsx(SubscribedControl, { enabled$, id: "b", label })),
  );
}

for (const strict of [false, true]) {
  test(`separate subscription children retain drafts and props while skipping owner work (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const snapshots: string[][] = [];
    for (const Component of [Before, After]) {
      const enabled$ = observable(true);
      const renders = new Map<string, number>();
      await ui.render(jsx(Component, { enabled$, renders, label: "Original" }));
      await ui.input('[data-control="a"]', "unsaved");
      const input = ui.element('[data-control="a"]');
      const trace = [ui.html()];
      renders.clear();
      // Publishing through an event exercises the same React batching boundary in both versions.
      const disable = (): void => {
        enabled$.set(false);
      };
      globalThis.window.addEventListener("disable-controls", disable, { once: true });
      await ui.signal("disable-controls");
      for (const id of ["a", "b"]) {
        assert.equal(ui.element(`[data-control="${id}"]`).hasAttribute("disabled"), true);
      }
      assert.equal((renders.get("owner") ?? 0) > 0, Component === Before);
      assert.equal((renders.get("unrelated") ?? 0) > 0, Component === Before);
      assert.equal(ui.element('[data-control="a"]'), input);
      assert.equal(input.getAttribute("value"), "unsaved");
      trace.push(ui.html());
      await ui.render(jsx(Component, { enabled$, renders, label: "Updated" }));
      assert.equal(ui.element('[data-control="a"]'), input);
      assert.equal(input.getAttribute("aria-label"), "Updated");
      trace.push(ui.html());
      snapshots.push(trace);
      await ui.render(null);
    }
    assert.deepEqual(snapshots[1], snapshots[0]);
  });
}
