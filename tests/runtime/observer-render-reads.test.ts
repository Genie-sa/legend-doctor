import { count, mountDom } from "../../src/runtime/dom.js";
import { observer, useValue } from "@legendapp/state/react";
import type { Observable } from "@legendapp/state";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { createElement as jsx } from "react";
import { observable } from "@legendapp/state";
import test from "node:test";

interface Settings {
  label: string;
  unrelated: number;
}

interface LabelProps {
  renders: Map<string, number>;
  settings$: Observable<Settings>;
}

function GetLabel({ renders, settings$ }: LabelProps): ReactElement {
  count(renders, "label");
  const label = settings$.label.get();
  return jsx("p", null, label);
}

function UseValueLabel({ renders, settings$ }: LabelProps): ReactElement {
  count(renders, "label");
  const label = useValue(settings$.label);
  return jsx("p", null, label);
}

for (const strict of [false, true]) {
  test(`inside observer, useValue renders exactly like a render get() (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const traces: string[][] = [];
    for (const Label of [observer(GetLabel), observer(UseValueLabel)]) {
      const settings$ = observable<Settings>({ label: "a", unrelated: 0 });
      const renders = new Map<string, number>();
      await ui.render(jsx(Label, { renders, settings$ }));
      const trace = [ui.html()];
      for (const [event, write] of [
        ["unrelated", (): void => settings$.unrelated.set(1)],
        ["label", (): void => settings$.label.set("b")],
      ] as const) {
        globalThis.window.addEventListener(event, write, { once: true });
        await ui.signal(event);
        trace.push(`${ui.html()} renders=${renders.get("label")}`);
      }
      traces.push(trace);
      await ui.render(null);
    }
    assert.deepEqual(traces[1], traces[0]);
    assert.match(traces[0]?.at(-1) ?? "", /<p>b<\/p>/u);
  });
}
