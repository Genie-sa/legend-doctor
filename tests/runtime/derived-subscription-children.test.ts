import { count, mountDom } from "../../src/runtime/dom.js";
import type { Observable } from "@legendapp/state";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { createElement as jsx } from "react";
import { observable } from "@legendapp/state";
import test from "node:test";
import { useValue } from "@legendapp/state/react";

interface Props {
  bins$: Observable<number | null | undefined>;
  label: string;
  renders: Map<string, number>;
}

function Preview({ bins$ }: Pick<Props, "bins$">): ReactElement {
  const bins = useValue(bins$) ?? 64;
  return jsx("output", { "data-bins": bins }, bins);
}

function Picker({ bins$, label }: Omit<Props, "renders">): ReactElement {
  const bins = useValue(bins$) ?? 64;
  return jsx("input", { "aria-label": label, value: String(bins), readOnly: true });
}

function Before({ bins$, label, renders }: Props): ReactElement {
  count(renders, "owner");
  const stored = useValue(bins$);
  const bins = stored ?? 64;
  return jsx(
    "main",
    null,
    jsx("output", { "data-bins": bins }, bins),
    jsx("input", { "aria-label": label, value: String(bins), readOnly: true }),
    jsx("input", { "data-draft": true, defaultValue: "" }),
  );
}

function After({ bins$, label, renders }: Props): ReactElement {
  count(renders, "owner");
  return jsx(
    "main",
    null,
    jsx(Preview, { bins$ }),
    jsx(Picker, { bins$, label }),
    jsx("input", { "data-draft": true, defaultValue: "" }),
  );
}

for (const strict of [false, true]) {
  test(`derived subscription children preserve defaults, zero, and parent inputs (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    for (const Component of [Before, After]) {
      const bins$ = observable<number | null | undefined>();
      const renders = new Map<string, number>();
      await ui.render(jsx(Component, { bins$, renders, label: "Bins" }));
      const picker = ui.element("input[readonly]");
      const draft = ui.element("input[data-draft]");
      assert.ok(picker instanceof globalThis.window.HTMLInputElement);
      assert.ok(draft instanceof globalThis.window.HTMLInputElement);
      assert.equal(picker.value, "64");
      await ui.input("input[data-draft]", "unsaved");
      for (const [next, expected] of [
        [32, "32"],
        [null, "64"],
        [0, "0"],
        [128, "128"],
      ] as const) {
        renders.clear();
        globalThis.window.addEventListener("bins", () => bins$.set(next), { once: true });
        await ui.signal("bins");
        assert.equal(ui.element("output").textContent, expected);
        assert.equal(picker.value, expected);
        assert.equal(ui.element("input[readonly]"), picker);
        assert.equal(ui.element("input[data-draft]"), draft);
        assert.equal(draft.value, "unsaved");
        assert.equal((renders.get("owner") ?? 0) > 0, Component === Before);
      }
      await ui.render(jsx(Component, { bins$, renders, label: "Frequency detail" }));
      assert.equal(picker.getAttribute("aria-label"), "Frequency detail");
      assert.equal(ui.element("input[readonly]"), picker);
      assert.equal(draft.value, "unsaved");
      await ui.render(null);
    }
  });
}
