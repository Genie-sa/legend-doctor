import type { FormEvent, ReactElement, ReactNode } from "react";
import { count, mountDom } from "../../src/runtime/dom.js";
import type { Observable } from "@legendapp/state";
import assert from "node:assert/strict";
import { createElement as jsx } from "react";
import { observable } from "@legendapp/state";
import test from "node:test";
import { useValue } from "@legendapp/state/react";

interface InputProps {
  label: string;
  onInput: (event: FormEvent<HTMLInputElement>) => void;
}

interface ScreenProps {
  commands: string[];
  error$: Observable<string>;
  label: string;
  renders: Map<string, number>;
}

function ErrorControl({ error, label, onInput }: InputProps & { error: string }): ReactElement {
  return jsx(
    "section",
    null,
    jsx("input", { "aria-label": label, className: error ? "invalid" : "", onInput }),
    error ? jsx("span", { role: "alert" }, error) : null,
  );
}

function SubscribedErrorControl({
  error$,
  ...props
}: InputProps & Pick<ScreenProps, "error$">): ReactElement {
  const error = useValue(error$);
  return jsx(ErrorControl, { ...props, error });
}

function Row({
  control,
  renders,
}: { control: ReactNode } & Pick<ScreenProps, "renders">): ReactElement {
  count(renders, "row");
  return jsx("main", null, jsx("h1", null, "Settings"), control);
}

function Before({ commands, error$, label, renders }: ScreenProps): ReactElement {
  count(renders, "owner");
  const error = useValue(error$);
  const onInput = (event: FormEvent<HTMLInputElement>): void => {
    commands.push(`${label}:${event.currentTarget.value}`);
  };
  return jsx(Row, { renders, control: jsx(ErrorControl, { error, label, onInput }) });
}

function After({ commands, error$, label, renders }: ScreenProps): ReactElement {
  count(renders, "owner");
  const onInput = (event: FormEvent<HTMLInputElement>): void => {
    commands.push(`${label}:${event.currentTarget.value}`);
  };
  return jsx(Row, { renders, control: jsx(SubscribedErrorControl, { error$, label, onInput }) });
}

for (const strict of [false, true]) {
  test(`embedded child preserves conditional UI and parent callback inputs (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    const snapshots: string[][] = [];
    for (const Component of [Before, After]) {
      const error$ = observable("");
      const renders = new Map<string, number>();
      const commands: string[] = [];
      await ui.render(jsx(Component, { commands, error$, label: "Original", renders }));
      await ui.input("input", "draft");
      const input = ui.element("input");
      const trace = [ui.html()];
      for (const error of ["Invalid hotkey", ""]) {
        renders.clear();
        globalThis.window.addEventListener("validation", () => error$.set(error), { once: true });
        await ui.signal("validation");
        assert.equal(ui.element("input"), input);
        assert.equal(input.getAttribute("class"), error ? "invalid" : "");
        assert.equal(ui.element("main").querySelector('[role="alert"]')?.textContent ?? "", error);
        assert.equal((renders.get("owner") ?? 0) > 0, Component === Before);
        assert.equal((renders.get("row") ?? 0) > 0, Component === Before);
        trace.push(ui.html());
      }
      await ui.render(jsx(Component, { commands, error$, label: "Updated", renders }));
      assert.equal(ui.element("input"), input);
      await ui.input("input", "new draft");
      assert.deepEqual(commands, ["Original:draft", "Updated:new draft"]);
      trace.push(ui.html());
      snapshots.push(trace);
      await ui.render(null);
    }
    assert.deepEqual(snapshots[1], snapshots[0]);
  });
}
